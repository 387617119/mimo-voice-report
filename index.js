/**
 * MiMo 语音汇报 · Host half
 *
 * 职责：
 * 1. 旁听 `session/event`，把每个会话最近一轮（turn）的结果收成一份轻量记录：
 *    最后一条助手消息的正文、这一轮的工具调用次数、结束原因（turn/end）。
 * 2. 在 `/mimo-voice/*` 上注册本包自己的 HTTP 路由，浏览器半用相对路径取音频：
 *    POST /mimo-voice/report   { sessionId, force }  → 生成/复用语音，返回 base64 mp3
 *    POST /mimo-voice/say      { text }              → 任意文本试听（自检用）
 *    GET  /mimo-voice/state                          → 宿主侧观测快照（自检用）
 *    POST /mimo-voice/_client                        → 浏览器半上报诊断
 *    GET  /mimo-voice/_client                        → 读回最近一次浏览器诊断
 * 3. 调用 MiMo-TTS（OpenAI 兼容的 /chat/completions + audio 参数）合成音频。
 *
 * API Key 解析顺序：config.apiKey → 环境变量 → $DSH_HOME/.credentials.yaml 的 refs。
 * Key 只在宿主进程使用，不下发到浏览器。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 深海鱼娘的声线完全来自 voice-sample.mp3 的克隆。
 * 试过加"气息稳"的语气指令：指标上更稳，但试听不如纯克隆贴原声，所以 style 保持为空。
 * 要改语气就填 style；不要在里面写音色描述，会带偏克隆的音高。
 */
const PERSONA_STYLE = ''

const PERSONA_TAGS = '(俏皮 稚嫩)'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 随插件发布的两条采样：原版（中性）与俏皮版。 */
const VOICE_PRESETS = [
  { id: 'original', label: '原版', file: 'voice-sample.mp3' },
  { id: 'playful', label: '俏皮版', file: 'voice-sample-playful.mp3' },
]

const DEFAULTS = {
  baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts-voiceclone',
  voice: '冰糖',
  voiceSample: 'voice-sample.mp3',
  avatar: 'avatar.webp',
  style: PERSONA_STYLE,
  tags: PERSONA_TAGS,
  /** 播报里对你的称呼（如「主人」），缀在结束提示后："任务完成啦，主人。" */
  callMe: '',
  maxChars: 90,
  staleMs: 25000,
  timeoutMs: 30000,
  apiKey: '',
  summarizer: 'model',
  summaryModel: 'mimo-v2.6-flash',
  summaryMaxChars: 64,
}

const CREDENTIAL_NAMES = ['MIMO_API_KEY', 'MIMO_TTS_API_KEY', 'XIAOMI_TOKEN_PLAN_CN_API_KEY']
const VERSION = '1.10.0'
const MAX_SESSIONS = 60
const MAX_CACHE = 12
const MAX_BODY = 64 * 1024

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const host = createHostState()

  // sessions: sessionId -> 最近一轮的记录；保持插入顺序，超出上限就丢最旧的。
  const sessions = new Map()
  const cache = new Map()

  const remember = (id, rec) => {
    sessions.delete(id)
    sessions.set(id, rec)
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      sessions.delete(oldest)
    }
    host.sessionCount = sessions.size
  }

  const readRecord = (id) => sessions.get(id)
  const upsert = (id, patch) => {
    const current = sessions.get(id) || blankRecord()
    remember(id, { ...current, ...patch })
    return sessions.get(id)
  }

  // ——— 会话事件旁听：只做增量折叠，不写任何日志 ———
  ctx.on('session/event', (session, event) => {
    const id = sessionIdOf(session)
    if (!id || !event || typeof event.type !== 'string') return
    const data = event.data || {}
    switch (event.type) {
      case 'turn/start': {
        upsert(id, {
          turn: data.turn,
          text: '',
          toolCalls: 0,
          reason: undefined,
          error: undefined,
          endedAt: 0,
          startedAt: event.time || Date.now(),
        })
        break
      }
      case 'assistant/message': {
        const rec = readRecord(id) || blankRecord()
        const text = messageText(data.message)
        upsert(id, {
          turn: data.turn ?? rec.turn,
          // 一轮可能有多次助手消息（工具调用前后），取最后一条真正带正文的。
          text: text || rec.text,
          interrupted: data.interrupted === true,
        })
        break
      }
      case 'tool/call': {
        const rec = readRecord(id)
        if (!rec) break
        const turn = data.turn ?? rec.turn
        upsert(id, { toolCalls: rec.toolCalls + 1, turn })
        break
      }
      case 'turn/end': {
        const rec = readRecord(id) || blankRecord()
        const reason = data.reason && data.reason.kind ? data.reason.kind : 'unknown'
        upsert(id, {
          turn: data.turn ?? rec.turn,
          reason,
          error: reason === 'error' && data.reason.error ? String(data.reason.error.message || '') : undefined,
          endedAt: event.time || Date.now(),
          startedAt: rec.startedAt || 0,
        })
        break
      }
      default:
        break
    }
  })

  // ——— HTTP 路由 ———
  const route = {
    kind: 'prefix',
    path: '/mimo-voice',
    handler: async (req, res) => {
      try {
        await handleRequest({ req, res, cfg, record: readRecord, cache, host, editor: () => ctx.get('configEditor') })
      } catch (error) {
        json(res, 500, { ok: false, code: 'handler-failed', message: String(error && error.message ? error.message : error) })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route))
}

async function handleRequest({ req, res, cfg, record, cache, host, editor }) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const method = (req.method || 'GET').toUpperCase()

  // ——— 设置：读当前来源 / 写入本插件的 config.apiKey、voiceSample、callMe ———
  if (url.pathname === '/mimo-voice/config') {
    if (method === 'GET') {
      return json(res, 200, {
        ok: true,
        keySource: describeKeySource(cfg),
        keyHint: maskKey(resolveApiKey(cfg)),
        config: { apiKey: maskKey(cfg.apiKey || ''), hasConfigKey: Boolean(cfg.apiKey) },
        voice: { sample: cfg.voiceSample || '', presets: voicePresets(cfg) },
        persona: { callMe: String(cfg.callMe || '').trim() },
      })
    }
    if (method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed' })
    const body = await readJson(req)
    const hasKey = Object.prototype.hasOwnProperty.call(body, 'apiKey')
    const hasSample = Object.prototype.hasOwnProperty.call(body, 'voiceSample')
    const hasCall = Object.prototype.hasOwnProperty.call(body, 'callMe')
    const apiKey = hasKey ? String(body.apiKey || '').trim() : ''
    const nextSample = hasSample ? String(body.voiceSample || '').trim() : ''
    // 称呼是念出来的：压空白、去换行、限长 16，字符集只放行中英文/数字/间隔号。
    const nextCall = hasCall ? String(body.callMe || '').trim().replace(/\s+/g, ' ').slice(0, 16) : ''
    if (hasKey && apiKey && !/^[\x21-\x7e]{16,}$/.test(apiKey)) {
      return json(res, 400, { ok: false, code: 'bad-key', message: 'API Key 看起来不像有效值（应为 16 位以上的可见 ASCII 字符）。' })
    }
    if (hasSample && nextSample && !isKnownSample(nextSample)) {
      return json(res, 400, { ok: false, code: 'bad-sample', message: '只能选插件目录里已存在的 mp3/wav 采样。' })
    }
    if (hasCall && nextCall && !/^[\u4e00-\u9fa5A-Za-z0-9_· ]+$/.test(nextCall)) {
      return json(res, 400, { ok: false, code: 'bad-address', message: '称呼只能是中文、英文、数字、「·」或空格，最长 16 个字符。' })
    }
    const configEditor = typeof editor === 'function' ? editor() : undefined
    if (!configEditor) {
      return json(res, 500, { ok: false, code: 'no-config-editor', message: '这个 profile 没有 configEditor 服务，无法持久化。' })
    }
    try {
      const entry = configEditor
        .entries()
        .find((candidate) => candidate.name === 'mimo-voice-report' || candidate.id === 'include:mimo-voice-report')
      if (!entry) return json(res, 500, { ok: false, code: 'no-entry', message: '找不到本插件在 profile 里的配置行。' })
      await configEditor.edit(entry, (current) => {
        const next = { ...current }
        if (hasKey) next.apiKey = apiKey
        if (hasSample) next.voiceSample = nextSample
        if (hasCall) next.callMe = nextCall
        return next
      })
      // 立即生效；下一次配置重载会用新值再 apply 一遍。
      if (hasKey) cfg.apiKey = apiKey
      if (hasSample) cfg.voiceSample = nextSample
      if (hasCall) cfg.callMe = nextCall
      return json(res, 200, {
        ok: true,
        keySource: describeKeySource(cfg),
        keyHint: maskKey(apiKey || resolveApiKey(cfg)),
        voice: { sample: cfg.voiceSample || '', presets: voicePresets(cfg) },
        persona: { callMe: String(cfg.callMe || '').trim() },
      })
    } catch (error) {
      return json(res, 500, { ok: false, code: 'config-write-failed', message: String(error && error.message ? error.message : error) })
    }
  }

  if (url.pathname === '/mimo-voice/report') {
    if (method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed' })
    const body = await readJson(req)
    const sessionId = String(body.sessionId || url.searchParams.get('sessionId') || '')
    if (!sessionId) return json(res, 400, { ok: false, code: 'missing-session' })

    const rec = record(sessionId)
    if (!rec || !rec.endedAt) {
      return json(res, 200, {
        ok: false,
        code: 'no-turn',
        message: '还没有观察到这个会话的结束轮次。',
      })
    }

    const age = Date.now() - rec.endedAt
    if (body.force !== true && age > cfg.staleMs) {
      return json(res, 200, {
        ok: false,
        code: 'stale',
        message: `最近一轮结束于 ${Math.round(age / 1000)} 秒前，已跳过播报。`,
        turn: rec.turn,
        endedAt: rec.endedAt,
      })
    }

    const text = await buildReportText(rec, cfg)
    const cacheKey = `${sessionId}:${rec.turn}:${rec.endedAt}:${text}`
    const hit = cache.get(cacheKey)
    if (hit) {
      host.reports += 1
      return json(res, 200, { ...hit, cached: true })
    }

    try {
      const audio = await synthesize(text, cfg)
      const payload = {
        ok: true,
        text,
        audio,
        mime: 'audio/mpeg',
        voice: cfg.voice,
        model: cfg.model,
        turn: rec.turn,
        reason: rec.reason,
        endedAt: rec.endedAt,
        cached: false,
      }
      cache.set(cacheKey, payload)
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
      host.reports += 1
      host.lastReport = { at: Date.now(), sessionId, text, turn: rec.turn, bytes: audio.length }
      return json(res, 200, payload)
    } catch (error) {
      host.failures += 1
      host.lastError = { at: Date.now(), message: String(error && error.message ? error.message : error) }
      return json(res, 200, {
        ok: false,
        code: 'tts-failed',
        message: host.lastError.message,
        text,
      })
    }
  }

  if (url.pathname === '/mimo-voice/say') {
    if (method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed' })
    const body = await readJson(req)
    const text = String(body.text || '').trim().slice(0, 300)
    if (!text) return json(res, 400, { ok: false, code: 'missing-text' })
    try {
      const audio = await synthesize(text, cfg)
      return json(res, 200, { ok: true, text, audio, mime: 'audio/mpeg', voice: cfg.voice, cached: false })
    } catch (error) {
      return json(res, 200, { ok: false, code: 'tts-failed', message: String(error && error.message ? error.message : error) })
    }
  }

  if (url.pathname === '/mimo-voice/avatar') {
    const info = avatarInfo(cfg)
    if (!info.ok) {
      return json(res, 404, { ok: false, code: 'no-avatar', message: info.error || '没有找到 avatar 图片' })
    }
    try {
      const body = readFileSync(info.path)
      res.statusCode = 200
      res.setHeader('content-type', info.mime)
      res.setHeader('cache-control', 'public, max-age=300')
      res.end(body)
    } catch (error) {
      json(res, 500, { ok: false, code: 'avatar-read-failed', message: String(error && error.message ? error.message : error) })
    }
    return
  }

  if (url.pathname === '/mimo-voice/state') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      persona: { voice: cfg.voice, style: String(cfg.style || '').slice(0, 200), tags: cfg.tags, callMe: String(cfg.callMe || '').trim() },
      sample: voiceSampleInfo(cfg),
      avatar: avatarInfo(cfg),
      config: { voice: cfg.voice, model: cfg.model, baseUrl: cfg.baseUrl, maxChars: cfg.maxChars, voiceSample: cfg.voiceSample, avatar: cfg.avatar },
      keySource: describeKeySource(cfg),
      keyHint: maskKey(resolveApiKey(cfg)),
      sessions: host.sessionCount,
      reports: host.reports,
      failures: host.failures,
      lastReport: host.lastReport,
      lastError: host.lastError,
      lastClient: host.lastClient,
    })
  }

  if (url.pathname === '/mimo-voice/_client') {
    if (method === 'POST') {
      const body = await readJson(req)
      host.lastClient = { at: Date.now(), ...body }
      host.clientEvents = (host.clientEvents + 1) || 1
      return json(res, 200, { ok: true })
    }
    return json(res, 200, { ok: true, lastClient: host.lastClient, events: host.clientEvents || 0 })
  }

  return json(res, 404, { ok: false, code: 'not-found', path: url.pathname })
}

function createHostState() {
  return {
    reports: 0,
    failures: 0,
    sessionCount: 0,
    lastReport: null,
    lastError: null,
    lastClient: null,
    clientEvents: 0,
  }
}

function blankRecord() {
  return { turn: 0, text: '', toolCalls: 0, reason: undefined, error: undefined, endedAt: 0, startedAt: 0, interrupted: false }
}

function sessionIdOf(session) {
  if (!session) return ''
  if (typeof session.id === 'string') return session.id
  if (session.header && typeof session.header.id === 'string') return session.header.id
  return ''
}

function messageText(message) {
  if (!message) return ''
  const blocks = Array.isArray(message.content) ? message.content : Array.isArray(message.blocks) ? message.blocks : []
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 生成最终口播稿：一句完成提示 + 一到两句结果总结。
 * 默认让 MiMo 对话模型把最后一条助手回复改写成口播稿（听感自然），
 * 模型不可用、超时或输出不合格时退回确定性抽取。
 */
export async function buildReportText(rec, cfg = {}) {
  const kind = rec && rec.reason ? rec.reason : 'unknown'
  if (kind === 'completed' && String(cfg.summarizer || DEFAULTS.summarizer) !== 'extract') {
    // 称呼在这里生效：announce 已带称呼，dedupeAnnounce 的前缀剥离同样按它对齐。
    const announce = announceOf(kind, cfg)
    const source = cleanText(rec.text)
    if (source.length >= 24) {
      try {
        const spoken = await summarizeWithModel(source, cfg, announce)
        const deduped = spoken ? dedupeAnnounce(spoken, announce) : ''
        if (deduped) return announce + deduped
      } catch {
        // 退回抽取式摘要，播报不能因为改写失败而消失。
      }
    }
  }
  return composeReport(rec, cfg)
}

/** 把一条助手回复压成适合朗读的一两句（确定性路径）。 */
export function composeReport(rec, cfg = {}) {
  const maxChars = Number(cfg.maxChars) > 10 ? Number(cfg.maxChars) : DEFAULTS.maxChars
  const kind = rec && rec.reason ? rec.reason : 'unknown'
  const announce = announceOf(kind, cfg)

  if (kind === 'completed') {
    const summary = summarize(rec.text, maxChars)
    return announce + (summary || '结果我已经写在对话里啦，你翻一眼就能看到。')
  }
  if (kind === 'error') {
    return announce + '错在哪我写进对话里了，要不要我再看一遍？'
  }
  if (kind === 'aborted' || kind === 'interrupted') {
    return announce + '想继续的话，随时喊我。'
  }
  if (kind === 'blocked') {
    return announce + '它在等你点个头。'
  }
  if (kind === 'max-tokens') {
    return announce + '要接着往下做的话，跟我说一声。'
  }
  return announce + '细节都在对话里啦。'
}

const ANNOUNCE = {
  completed: '任务完成啦。',
  error: '呜，任务出错了。',
  aborted: '任务先停在这里啦。',
  interrupted: '任务被打断啦。',
  blocked: '任务卡住啦，在等你点头。',
  'max-tokens': '长度到上限啦。',
  forked: '任务分叉好啦。',
  unknown: '这一轮结束啦。',
}

/**
 * 结束提示 + 可选称呼。称呼统一缀在句尾（"任务完成啦，主人。"）：
 * 比放句首更稳——"呜，任务出错了"这类带语气词的开头不会被劈开，所有结束语一个规则通吃。
 * 空串 / 超长（>16 字）都会被收敛：空 = 不称呼，超长截断。
 */
export function announceOf(kind, cfg = {}) {
  const base = ANNOUNCE[kind] || ANNOUNCE.unknown
  const raw = cfg.callMe === undefined ? DEFAULTS.callMe : cfg.callMe
  const address = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 16)
  if (!address) return base
  return base.endsWith('。') ? base.slice(0, -1) + '，' + address + '。' : base + '，' + address + '。'
}

/** 去掉 Markdown 噪声，取前一两句，控制朗读长度。 */
export function summarize(raw, maxChars = DEFAULTS.maxChars) {
  const text = cleanText(raw)
  if (!text) return ''
  let parts = text.split(/(?<=[。！？!?])/).map((part) => part.trim()).filter(Boolean)
  parts = dropBoilerplate(parts)
  if (!parts.length) return ''
  let out = parts[0]
  // 第一句太短（比如"已经完成。"）时补上第二句，让汇报有信息量。
  if (out.length < 18 && parts[1] && out.length + parts[1].length <= maxChars) out += parts[1]
  return clampSpoken(out, maxChars)
}

/** 去掉"已完成""我做了三件事"这类与完成提示重复的开场白。 */
function dropBoilerplate(parts) {
  const copy = parts.slice()
  while (copy.length > 1) {
    const first = copy[0]
    if (/^(已完成|完成了|搞定了|好了|可以了|完成|Done|Finished)[。！!，,]?$/.test(first)) {
      copy.shift()
      continue
    }
    if (/^(.{0,6})?(做了|完成了|处理了)?\s*[一两二三四五六七八九十\d]+\s*(件|个|项)?\s*(事|事情|步骤|工作|任务)[。！!，,]?$/.test(first)) {
      copy.shift()
      continue
    }
    break
  }
  return copy
}

function clampSpoken(text, maxChars) {
  let out = String(text).trim()
  if (!out) return ''
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars)
    const lastPunct = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf('；'), cut.lastIndexOf('：'))
    out = lastPunct >= Math.max(20, maxChars * 0.5) ? cut.slice(0, lastPunct) : cut
    out = out.replace(/[，、；：,;]$/, '')
    if (!/[。！？!?]$/.test(out)) out += '。'
  }
  if (!/[。！？!?]$/.test(out)) out += '。'
  return out
}

/**
 * 行级 Markdown 清理：标题、列表、代码块、表格、链接、强调符号都抹掉，
 * 并把"本该换行"的地方补成句号，让后续断句和朗读都自然。
 */
export function cleanText(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.replace(/\r\n?/g, '\n')
  text = text.replace(/```[\s\S]*?```/g, '\n').replace(/~~~[\s\S]*?~~~/g, '\n')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/<[^>/][^>]*>/g, ' ')
  text = text.replace(/^\s*\|.*\|\s*$/gm, '')
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+[.)]\s+/gm, '')
  text = text.replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, '$1')
  text = text.replace(/`([^`]*)`/g, '$1')

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const sentences = []
  for (const line of lines) {
    let value = line
    if (/[：:]$/.test(value)) value = value.slice(0, -1) + '，'
    if (!value) continue
    if (/[。！？!?；;，,]$/.test(value)) sentences.push(value)
    else sentences.push(value + '。')
  }
  return sentences
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/，。/g, '。')
    .replace(/\s+([。！？，、；：])/g, '$1')
    .trim()
}

/** 让 MiMo 对话模型把最后一条助手回复改写成一句口语化汇报。 */
export async function summarizeWithModel(source, cfg = {}, announce = '') {
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) return ''
  const baseUrl = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
  const limit = Number(cfg.summaryMaxChars) > 20 ? Number(cfg.summaryMaxChars) : DEFAULTS.summaryMaxChars
  const messages = [
    {
      role: 'system',
      content:
        '你是 DeepSeek 的鲸鱼娘——从深海里来的少女助手，现在给对话里的用户做语音汇报。' +
        `把给你的任务结果改写成一句到两句中文口播稿，最多 ${limit} 个字：` +
        '语气温柔、轻快、带一点俏皮，像贴着耳朵小声说话，但不要卖萌过度、不要撒娇腔、不要 emoji 或颜文字；' +
        '只讲做完的事和结果，用第一人称"我"，不要说"主人"之类的称呼；' +
        (announce
          ? '前面已经有一句完成提示，你不要再重复"完成""搞定"这类意思，也不要用同样的语气词收尾；只写后面这一两句。'
          : '句尾可以用"啦""咯""哦"轻轻收住；') +
        '文件大小、路径、版本号、代码标识符这类技术细节可以不念，长数字换成"好几个"；' +
        '不要 Markdown、列表、代码、工具名；直接输出可以朗读的句子，一句到两句，用中文句号结尾。',
    },
    { role: 'user', content: String(source).slice(0, 2400) },
  ]

  const request = async (withReasoningHint) => {
    const body = {
      model: cfg.summaryModel || DEFAULTS.summaryModel,
      temperature: 0,
      max_tokens: 120,
      messages,
    }
    // 关掉思考链：改写任务不需要推理，能省掉几秒。
    if (withReasoningHint) body.reasoning_effort = 'none'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) > 1000 ? Number(cfg.timeoutMs) : DEFAULTS.timeoutMs)
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const raw = await res.text()
      if (!res.ok) {
        const error = new Error(`MiMo 摘要 HTTP ${res.status}: ${raw.slice(0, 200)}`)
        error.status = res.status
        error.body = raw
        throw error
      }
      const payload = JSON.parse(raw)
      const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content
      return typeof content === 'string' ? content : ''
    } finally {
      clearTimeout(timer)
    }
  }

  let content = ''
  try {
    content = await request(true)
  } catch (error) {
    // 不同端点对 reasoning_effort 的支持不一致：被拒时去掉该字段重试一次。
    if (error && error.status === 400 && /reasoning_effort/i.test(String(error.body || ''))) {
      content = await request(false)
    } else {
      throw error
    }
  }
  return sanitizeSpoken(content, limit)
}

/** 校验模型输出：太长、带 Markdown、答非所问就丢掉。 */
function sanitizeSpoken(content, limit) {
  let text = cleanText(content)
  if (!text) return ''
  text = text.replace(/^(好的|好的，|当然|以下是|这是)[，,]?\s*/, '')
  if (text.length < 6) return ''
  if (/^(抱歉|对不起|无法|不能)/.test(text)) return ''
  const parts = text.split(/(?<=[。！？!?])/).map((part) => part.trim()).filter(Boolean)
  let out = parts.slice(0, 2).join('')
  out = clampSpoken(out, Math.min(limit + 16, 110))
  return out
}

/** 模型偶尔会把"任务完成啦"再复述一遍；这里剥掉开头重复的完成提示。 */
export function dedupeAnnounce(spoken, announce = '') {
  let text = String(spoken || '').trim()
  if (!text) return ''
  text = text.replace(/^["“「『]+/, '').replace(/["”」』]+$/, '').trim()
  const original = text
  const cut = (length) => {
    text = text.slice(length).replace(/^[\s，,。.!！、；;：:]+/, '').trim()
  }

  if (announce && text.startsWith(announce)) cut(announce.length)
  let match = /^(好的?|嗯|那)?[，,]?\s*(任务)?(已经|都)?(完成|做好|搞定)(啦|了|咯|啦～)?[。！!～~]?[，,]?\s*/.exec(text)
  if (match && match[0].trim()) cut(match[0].length)

  // 再兜一层：第一句很短又只讲"完成了"，且后面还有内容，就整句丢掉。
  const sentences = text.split(/(?<=[。！？!?])/).map((part) => part.trim()).filter(Boolean)
  if (sentences.length > 1 && sentences[0].length <= 14 && /(完成|做好|搞定|好啦|好了)/.test(sentences[0]) && !/\d/.test(sentences[0])) {
    text = sentences.slice(1).join('')
  }

  return text.trim()
}

/** 调用 MiMo-TTS，返回 base64 mp3。 */
export async function synthesize(text, cfg) {
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) {
    throw new Error('缺少 MiMo API Key：请在插件 config.apiKey、环境变量 MIMO_API_KEY 或 ~/.dsh/.credentials.yaml 的 refs 中提供。')
  }
  const baseUrl = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
  const model = cfg.model || DEFAULTS.model
  const messages = []
  // 人设/风格指令走 user message（不会念出来），这是 MiMo-TTS 的自然语言控制通道。
  const style = String(cfg.style === undefined ? DEFAULTS.style : cfg.style || '').trim()
  if (style) messages.push({ role: 'user', content: style })
  // 音频标签必须紧贴正文开头，例如 "(温柔 清亮 俏皮)任务完成啦。"
  const tags = String(cfg.tags === undefined ? DEFAULTS.tags : cfg.tags || '').trim()
  messages.push({ role: 'assistant', content: tags + String(text) })

  const audio = { format: 'mp3' }
  if (model === 'mimo-v2.5-tts') {
    audio.voice = cfg.voice || DEFAULTS.voice
  } else if (model === 'mimo-v2.5-tts-voiceclone') {
    // 复刻模型要的是 DataURL（不是裸 base64），采样从插件目录里的 mp3 读。
    audio.voice = voiceSampleDataUrl(cfg)
  }
  // voicedesign 不接受 voice 字段，只用 user message 描述音色。

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) > 1000 ? Number(cfg.timeoutMs) : DEFAULTS.timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, audio }),
      signal: controller.signal,
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`MiMo TTS HTTP ${res.status}: ${raw.slice(0, 300)}`)
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new Error(`MiMo TTS 返回了非 JSON 响应: ${raw.slice(0, 200)}`)
    }
    const audioBlock = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.audio
    const data = audioBlock && audioBlock.data
    if (typeof data !== 'string' || data.length < 32) {
      throw new Error(`MiMo TTS 响应里没有音频数据: ${raw.slice(0, 200)}`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** 声音克隆采样：读取插件目录下的 mp3/wav，转成 DataURL（按 mtime+size 缓存）。 */
let sampleCache = { key: '', data: '' }

export function voiceSamplePath(cfg = {}) {
  const rel = String(cfg.voiceSample === undefined ? DEFAULTS.voiceSample : cfg.voiceSample || '')
  if (!rel) return ''
  return isAbsolute(rel) ? rel : join(HERE, rel)
}

export function voiceSampleDataUrl(cfg = {}) {
  const file = voiceSamplePath(cfg)
  if (!file) throw new Error('没有配置 voiceSample：复刻模式需要一个本地 mp3/wav 采样文件。')
  const info = statSync(file)
  const key = `${file}:${info.mtimeMs}:${info.size}`
  if (sampleCache.key !== key) {
    const mime = /\.wav$/i.test(file) ? 'audio/wav' : 'audio/mpeg'
    sampleCache = { key, data: `data:${mime};base64,${readFileSync(file).toString('base64')}` }
  }
  return sampleCache.data
}

/** /state 用：只报采样文件概况，不读内容。 */
export function voiceSampleInfo(cfg = {}) {
  try {
    const file = voiceSamplePath(cfg)
    if (!file) return { path: '', ok: false, error: 'voiceSample 为空' }
    const info = statSync(file)
    return { path: file, ok: true, bytes: info.size, mtime: Math.round(info.mtimeMs) }
  } catch (error) {
    return { path: '', ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/** 可选音色：随插件发布的两条采样，标出当前选中的那条。 */
export function voicePresets(cfg = {}) {
  const current = String(cfg.voiceSample || '')
  return VOICE_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    file: preset.file,
    selected: current === preset.file,
    exists: existsSync(join(HERE, preset.file)),
  }))
}

/** 只接受插件目录里真实存在的 mp3/wav，避免把任意路径写进配置。 */
function isKnownSample(name) {
  if (!/^[\w.\-]+\.(mp3|wav)$/i.test(name)) return false
  try {
    return statSync(join(HERE, name)).isFile()
  } catch {
    return false
  }
}

/** 弹窗里显示的鲸鱼娘立绘：默认取插件目录里的 avatar.webp。 */
export function avatarPath(cfg = {}) {
  const rel = String(cfg.avatar === undefined ? DEFAULTS.avatar : cfg.avatar || '')
  if (!rel) return ''
  return isAbsolute(rel) ? rel : join(HERE, rel)
}

export function avatarInfo(cfg = {}) {
  try {
    const file = avatarPath(cfg)
    if (!file) return { path: '', ok: false, error: 'avatar 为空' }
    const info = statSync(file)
    const mime = /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.gif$/i.test(file) ? 'image/gif' : 'image/webp'
    return { path: file, ok: true, bytes: info.size, mime }
  } catch (error) {
    return { path: '', ok: false, error: String(error && error.message ? error.message : error) }
  }
}

export function resolveApiKey(cfg = {}) {
  if (cfg.apiKey && String(cfg.apiKey).trim()) return String(cfg.apiKey).trim()
  const envName = process.env.MIMO_API_KEY
  if (envName && envName.trim()) return envName.trim()
  for (const name of CREDENTIAL_NAMES) {
    const value = credentialRef(name)
    if (value) return value
  }
  return ''
}

export function describeKeySource(cfg = {}) {
  if (cfg.apiKey && String(cfg.apiKey).trim()) return 'config'
  if (process.env.MIMO_API_KEY) return 'env:MIMO_API_KEY'
  for (const name of CREDENTIAL_NAMES) if (credentialRef(name)) return `credentials:${name}`
  return 'missing'
}

/** 只露头尾，够确认"用的是哪把 key"，又不至于整串泄露。 */
export function maskKey(key) {
  const value = String(key || '').trim()
  if (!value) return ''
  if (value.length <= 10) return value.slice(0, 2) + '…'
  return value.slice(0, 3) + '…' + value.slice(-4)
}

let credentialCache = null
function credentialRef(name) {
  const now = Date.now()
  if (!credentialCache || now - credentialCache.at > 60_000) {
    credentialCache = { at: now, refs: readCredentialRefs() }
  }
  return credentialCache.refs[name] || ''
}

function readCredentialRefs() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(home, '.credentials.yaml')
  const refs = {}
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return refs
  }
  const lines = text.split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(line)) {
      inRefs = false
      continue
    }
    const match = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/.exec(line)
    if (match) refs[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return refs
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        resolve({})
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

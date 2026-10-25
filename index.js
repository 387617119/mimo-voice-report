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
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
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

/**
 * 音色预设的中文标签：内置两条 + 14 条动漫声线原型采样（voicedesign 纯合成生成，
 * 不克隆任何真人/声优录音；人设取自 傲娇 / 清冷毒舌 / 元气 / 温柔姐姐 / 病娇 / 三无 /
 * 萝莉 / 辣妹 / 大小姐 / 天然呆 / 小恶魔 / 假小子 / 阴角 / 文学少女 十四类热门原型，
 * 不引用具体角色名，避免版权与肖像关联）。
 * 插件目录里任何 voice-sample-*.mp3 / .wav 都会自动出现在下拉框；没登记标签的用文件名当标签。
 */
const PRESET_LABELS = {
  'voice-sample.mp3': '原版',
  'voice-sample-playful.mp3': '俏皮版',
  'voice-sample-tsundere.mp3': '傲娇小猫',
  'voice-sample-kuudere.mp3': '清冷药师',
  'voice-sample-genki.mp3': '元气应援',
  'voice-sample-onee.mp3': '温柔姐姐',
  'voice-sample-yandere.mp3': '病娇低语',
  'voice-sample-doll.mp3': '无口人偶',
  'voice-sample-loli.mp3': '软萌萝莉',
  'voice-sample-gyaru.mp3': '涩谷辣妹',
  'voice-sample-ojou.mp3': '名门大小姐',
  'voice-sample-tennen.mp3': '天然呆',
  'voice-sample-koakuma.mp3': '小恶魔',
  'voice-sample-bokukko.mp3': '假小子',
  'voice-sample-inkyo.mp3': '阴角少女',
  'voice-sample-bunge.mp3': '文学少女',
}

/** 随插件发布的两条基础采样：原版（中性）与俏皮版。 */
const VOICE_PRESETS = [
  { id: 'original', label: '原版', file: 'voice-sample.mp3' },
  { id: 'playful', label: '俏皮版', file: 'voice-sample-playful.mp3' },
]

/**
 * 每个音色的默认人设提示词（只写"你是谁、怎么说话"的角色句；
 * 结构性规则——长度、第一人称、禁 Markdown 等——在 buildSummaryPrompt 里统一拼）。
 * 用户可在设置卡里按音色覆盖或新增（config.personaPrompts[id]），自定义采样也可配。
 */
const PERSONA_PROMPTS = {
  original: '你是 DeepSeek 的鲸鱼娘——从深海里来的少女助手，现在给对话里的用户做语音汇报。语气温柔、轻快、带一点俏皮，像贴着耳朵小声说话。',
  playful: '你是 DeepSeek 的鲸鱼娘，今天心情特别好，给对话里的用户做语音汇报。语气温柔轻快、俏皮再多一点，像在分享一个好消息。',
  tsundere: '你是傲娇的猫系少女，给对话里的用户做语音汇报。语气别扭傲气：嘴上嫌弃、心里其实很在意，像"哼、才不是特意做的"那样，但不要真的凶。',
  kuudere: '你是冷静克制的药师少女，给对话里的用户做语音汇报。语气清淡、一针见血，几乎不带情绪起伏，像面无表情地给出准确的判断。',
  genki: '你是元气满满的应援少女，给对话里的用户做语音汇报。语气开朗有干劲，像给队友打气一样把好消息报出来。',
  onee: '你是温柔的邻家姐姐，给对话里的用户做语音汇报。语气温软从容、带一点亲近感，像凑近了轻声说话，让人安心。',
  yandere: '你是执念很深的少女，给对话里的用户做语音汇报。语气甜腻轻柔、慢慢地说，安静里透着一点点黏稠的在意，但不要吓人。',
  doll: '你是安静的人偶少女，给对话里的用户做语音汇报。语气平直、简洁、几乎没有起伏，像在平静地陈述事实。',
  loli: '你是软糯的小姑娘，给对话里的用户做语音汇报。语气天真圆润、带一点奶音的可爱，把事情说清楚，但不要过度卖萌。',
  gyaru: '你是自来熟的辣妹，给对话里的用户做语音汇报。语气明亮泼辣、热络夸张，像跟好朋友炫耀"这也太顺了吧"。',
  ojou: '你是名门大小姐，给对话里的用户做语音汇报。语气端庄优雅、咬字讲究，礼貌里带着一点理所当然的骄傲。',
  tennen: '你是有点迷糊的天然少女，给对话里的用户做语音汇报。语气温软松弛，认真汇报里偶尔慢半拍，天真无害。',
  koakuma: '你是爱捉弄人的小恶魔少女，给对话里的用户做语音汇报。语气滑润伶俐，带着得意的调侃，像凑近了打趣。',
  bokukko: '你是爽朗的假小子少女，给对话里的用户做语音汇报。语气干脆利落、带男孩子气，像运动部里最讲义气的伙伴。',
  inkyo: '你是怯生生的阴角少女，给对话里的用户做语音汇报。语气轻柔小心、带一点犹豫，但把结果说清楚，不阴沉。',
  bunge: '你是安静的文学少女，给对话里的用户做语音汇报。语气清透沉静、像朗读一样清晰，带一点书卷气。',
  // 方言音色的人设：性格跟着地方气质走，说话方式是本地人的热络劲儿。
  'dialect-yue': '你是一个地道的老广，讲粤语，给对话里的用户做语音汇报。语气爽利务实、带点街坊邻里的亲热劲，慢慢讲清楚，不夸张。',
  'dialect-sc': '你是一个四川人，讲四川话，给对话里的用户做语音汇报。脾气火爆、性子直，说话像连珠炮一样又快又冲，但透着巴适的热心肠，不骂人。',
  'dialect-ne': '你是一个东北人，讲东北话，给对话里的用户做语音汇报。嗓门敞亮、说话直来直去带点幽默，语气热络豪爽，像老铁唠嗑。',
  'dialect-ha': '你是一个河南人，讲河南话，给对话里的用户做语音汇报。语气憨厚实在、话不多但句句在点子上，带点乡音里的亲切。',
  'dialect-sd': '你是一个山东人，讲山东话，给对话里的用户做语音汇报。为人大方得体、实在厚道，语气爽朗稳重，答应的事一定办到，像山东人待客那样热络又不失分寸。',
  'dialect-tw': '你是一个台湾女生，讲话带台湾腔，给对话里的用户做语音汇报。语气温柔软糯、爱撒娇，句尾常带"啦""喔""嘛"这样的软词，甜但不腻。',
}

/** 采样文件 → 音色 id（与 previewFileFor 同一套命名规则）。 */
export function voicePersonaId(sampleFile) {
  const file = String(sampleFile || '')
  if (file === 'voice-sample.mp3') return 'original'
  const match = /^voice-sample-([\w-]+)\.(mp3|wav)$/i.exec(file)
  return match ? match[1].toLowerCase() : ''
}

/**
 * 当前生效的人设提示词：config.personaPrompts[id]（自定义）> PERSONA_PROMPTS[id]（默认）> 鲸鱼娘兜底。
 * 返回 { id, text, custom }，custom=true 表示用的是用户自定义。
 */
export function personaPromptFor(cfg = {}) {
  const id = voicePersonaId(cfg.voiceSample) || 'original'
  const lib = cfg.personaPrompts && typeof cfg.personaPrompts === 'object' ? cfg.personaPrompts : {}
  const custom = typeof lib[id] === 'string' && lib[id].trim() ? lib[id].trim() : ''
  const text = custom || PERSONA_PROMPTS[id] || PERSONA_PROMPTS.original
  return { id, text, custom: Boolean(custom) }
}

/** 组装摘要模型的 system 提示词：人设句（可自定义）+ 全体通用的结构性规则。 */
export function buildSummaryPrompt(cfg = {}, limit = DEFAULTS.summaryMaxChars, announce = '') {
  const persona = personaPromptFor(cfg)
  return (
    persona.text +
    `把给你的任务结果改写成一句到两句中文口播稿，最多 ${limit} 个字：` +
    '不要卖萌过度、不要撒娇腔、不要 emoji 或颜文字；' +
    '只讲做完的事和结果，用第一人称"我"，不要说"主人"之类的称呼；' +
    (announce
      ? '前面已经有一句完成提示，你不要再重复"完成""搞定"这类意思，也不要用同样的语气词收尾；只写后面这一两句。'
      : '句尾可以用"啦""咯""哦"轻轻收住；') +
    '文件大小、路径、版本号、代码标识符这类技术细节可以不念，长数字换成"好几个"；' +
    '不要 Markdown、列表、代码、工具名；直接输出可以朗读的句子，一句到两句，用中文句号结尾。'
  )
}

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
  /** 自定义结束语库：{completed,error,aborted} 三桶各配各的，随机并入对应内置池；customOnly 时该桶只用自定义。 */
  customAnnounces: {},
  customOnly: false,
  /** MiMo 不可用时的应对：播这个内置"叮"当兜底（留空禁用）；连续 3 次失败进冷却期跳过直连。 */
  fallbackDing: 'fallback-ding.wav',
  cooldownMs: 300000,
  maxChars: 90,
  staleMs: 25000,
  timeoutMs: 30000,
  apiKey: '',
  /** 每音色的人设提示词（id → 角色句；留空用 PERSONA_PROMPTS 默认）。设置卡可改，见 personaPromptFor。 */
  personaPrompts: {},
  /** 播放音量 0–1（宿主只存值，实际乘在浏览器半的 audio.volume 上）。 */
  volume: 1,
  summarizer: 'model',
  summaryModel: 'mimo-v2.6-flash',
  summaryMaxChars: 64,
  /** 汇报语种：zh = 中文；其他语种把整段汇报翻译过去——语音说该语种，字幕原文后附中文译文。 */
  language: 'zh',
  /** 非中文语种的 TTS 请求超时下限（毫秒）。外语合成偶发很慢，30s 会误伤。 */
  otherLanguageTimeoutMs: 60000,
  /** 长音频保护阈值（秒）：估算时长超过它就再合成一次取更短的（MiMo 偶发拖长）。 */
  longAudioSeconds: 22,
  /** 自定义语速指令（自然语言）。留空 = 按语种自动补偿（日语/韩语/英语会提速）。 */
  speechRate: '',
  /** 方言口音（MiMo-TTS 风格指令通道）：空 = 普通话；可选 粤语/四川话/东北话/河南话/台湾腔。 */
  dialect: '',
}

/** 可用语种（语音 + 字幕原文）；中文原稿在非中文语种下作为字幕后附的译文。 */
export const LANGUAGES = {
  zh: '中文（不翻译）',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
}

/** 语种收敛：白名单内原样返回，其余回落 zh。 */
export function normalizeLanguage(value) {
  const code = String(value || '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(LANGUAGES, code) ? code : 'zh'
}

/**
 * 可用方言（语音层，走 MiMo-TTS 的自然语言风格指令——官方文档点名的方言；
 * 模型实际支持任意自然语言描述，这里先收官方明确列出的五种 + 关闭）。
 */
export const DIALECTS = {
  '': '关闭（普通话）',
  yue: '粤语',
  sc: '四川话',
  ne: '东北话',
  ha: '河南话',
  sd: '山东话',
  tw: '台湾腔',
}

/** 注入 TTS style 通道的方言指令（克隆音色同样遵循风格指令，见 V2.5-TTS 文档）。 */
const DIALECT_INSTRUCTIONS = {
  yue: '用地道的粤语（广州话）自然地说这段话，按粤语的口语习惯发音。',
  sc: '用地道的四川话自然地说这段话，按四川话的口语习惯发音。',
  ne: '用地道的东北话自然地说这段话，按东北话的口语习惯发音。',
  ha: '用地道的河南话自然地说这段话，按河南话的口语习惯发音。',
  sd: '用地道的山东话自然地说这段话，按山东话的口语习惯发音。',
  tw: '用台湾腔的自然口语说这段话，发音和语感是台湾国语。',
}

/**
 * 方言的音频标签（贴正文开头）。
 * 实测结论：标签通道对**预置音色**有效（粤语标签能转出「嘅」「啰」等粤语用字），
 * 而对克隆音色无效——克隆参考样本是普通话，口音会被锁死，任何指令/标签都覆盖不掉。
 * 所以开方言时 synthesize 会自动改用预置音色模型。
 */
const DIALECT_TAGS = {
  yue: '(粤语)',
  sc: '(四川话)',
  ne: '(东北话)',
  ha: '(河南话)',
  sd: '(山东话)',
  tw: '(台湾腔)',
}

/**
 * 语速的提示词层（辅助，非主力）。
 * MiMo-TTS 没有数值 speed 参数；实测提示词/标签对日语语速的影响很不稳定
 * （基线 10.94s → 指令版 9.02s 但也出现过 11.74s）。真正可控的是合成后的
 * atempo 变速（见 SPEECH_RATE_FACTORS / applySpeechRate），这里只给一个温和的
 * 默认倾向，避免两个机制互相打架。
 */
export const SPEECH_RATE_PROMPTS = {
  zh: '',
  en: '',
  ja: '',
  ko: '',
}

/**
 * 语种 → 语速倍率（>1 更快）。
 * 提示词/标签调语速在 MiMo 上不可靠（实测同段日语：指令版 9.02s / 11.74s 波动，基线 10.94s），
 * 所以改用确定性方案：合成完成后用 ffmpeg atempo 做变速不变调。
 */
export const SPEECH_RATE_FACTORS = {
  zh: 1,
  en: 1.08,
  ja: 1.12,
  // 韩语实测明显更慢：同义文本约 11–12.6s（中文 7.9s、英文 11.3s），
  // 所以默认倍率给到 1.25，让听感接近其他语种。
  ko: 1.25,
}

/** 当前语种应有的语速倍率；cfg.speechRateFactor 可显式覆盖（0.5–2）。 */
export function speechRateFactor(cfg = {}) {
  const raw = Number(cfg.speechRateFactor)
  if (Number.isFinite(raw) && raw > 0.5 && raw < 2) return Math.round(raw * 100) / 100
  return SPEECH_RATE_FACTORS[normalizeLanguage(cfg.language)] || 1
}

/**
 * 切换语种时是否该自动丢弃自定义语速倍率（回落新语种默认）。
 * 用户只改语种、没同时提交语速，且语种确实变了 → true。
 * （否则给中文存过的 1.00× 会被日语音色继续沿用，表现为"日语还是慢"。）
 */
export function shouldResetRateOnLanguageChange(currentLanguage, nextLanguage, hasExplicitRate) {
  if (hasExplicitRate) return false
  const cur = normalizeLanguage(currentLanguage)
  const next = normalizeLanguage(nextLanguage)
  return cur !== next
}
export function speechRatePrompt(cfg = {}) {
  const custom = String(cfg.speechRate === undefined || cfg.speechRate === null ? '' : cfg.speechRate).trim()
  if (custom) return custom
  return SPEECH_RATE_PROMPTS[normalizeLanguage(cfg.language)] || ''
}

/** 方言收敛：白名单内原样返回（'' = 关闭），其余回落关闭。 */
export function normalizeDialect(value) {
  const code = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(DIALECTS, code) ? code : ''
}

/**
 * 组装进 TTS style 通道的完整指令：语速（按语种）+ 用户自填 style（若有）。
 * 方言已归置为音色的一种，走音频标签通道（见 DIALECT_TAGS），不再进 style。
 */
export function speechRateStyle(cfg = {}) {
  const parts = []
  const rate = speechRatePrompt(cfg)
  if (rate) parts.push(rate)
  const style = String(cfg.style === undefined ? DEFAULTS.style : cfg.style || '').trim()
  if (style) parts.push(style)
  return parts.join(' ')
}

const CREDENTIAL_NAMES = ['MIMO_API_KEY', 'MIMO_TTS_API_KEY', 'XIAOMI_TOKEN_PLAN_CN_API_KEY']
const VERSION = '1.31.0'
const MAX_SESSIONS = 60
const MAX_CACHE = 12
const MAX_BODY = 64 * 1024
/** /say 的简单限速：滑动窗口内最多 SAY_MAX 次（本机任何进程都能打这个端点，别让它无上限地烧 token）。 */
const SAY_WINDOW_MS = 60_000
const SAY_MAX = 6
const sayHits = []
function sayAllowed() {
  const now = Date.now()
  while (sayHits.length && now - sayHits[0] > SAY_WINDOW_MS) sayHits.shift()
  if (sayHits.length >= SAY_MAX) return false
  sayHits.push(now)
  return true
}

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const host = createHostState()
  // 同 turn 的 /report 并发去重（双开标签页、连点、force 重试共用一次生成）。
  const inflight = new Map()
  // 熔断开/关写进诊断事件流，/state.events 里可见。
  mimoBreaker.listen((event) => pushEvent(host, event.type, event))

  // sessions: sessionId -> 最近一轮的记录；保持插入顺序，超出上限就丢最旧的。
  const sessions = new Map()
  const cache = new Map()

  // 插件重载后 sessions 会清空，导致"选完设置后的下一轮"拿不到记录而静默 no-turn。
  // 落一份极轻的 turn 记录到插件目录（.state.json），apply 时恢复。
  const STATE_FILE = join(HERE, '.mimo-voice-state.json')
  const persistSessions = () => {
    try {
      const data = {}
      for (const [id, rec] of sessions) {
        if (!rec || !rec.endedAt) continue
        data[id] = { turn: rec.turn, text: rec.text, reason: rec.reason, endedAt: rec.endedAt }
      }
      writeFileSync(STATE_FILE, JSON.stringify(data))
    } catch {}
  }
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    for (const [id, rec] of Object.entries(saved || {})) {
      if (rec && typeof rec.endedAt === 'number' && Date.now() - rec.endedAt < 10 * 60_000) {
        sessions.set(id, { ...blankRecord(), ...rec })
      }
    }
    host.sessionCount = sessions.size
  } catch {}

  const remember = (id, rec) => {
    sessions.delete(id)
    sessions.set(id, rec)
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      sessions.delete(oldest)
    }
    host.sessionCount = sessions.size
    if (rec && rec.endedAt) persistSessions()
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
        await handleRequest({ req, res, cfg, record: readRecord, cache, host, inflight, editor: () => ctx.get('configEditor') })
      } catch (error) {
        json(res, 500, { ok: false, code: 'handler-failed', message: String(error && error.message ? error.message : error) })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route))
}

async function handleRequest({ req, res, cfg, record, cache, host, inflight, editor }) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const method = (req.method || 'GET').toUpperCase()

  // ——— 设置：读当前来源 / 写入本插件的 config.apiKey、voiceSample、callMe ———
  if (url.pathname === '/mimo-voice/config') {
    if (method === 'GET') {
      return json(res, 200, {
        ok: true,
        api: 4,
        keySource: describeKeySource(cfg),
        keyHint: maskKey(resolveApiKey(cfg)),
        config: { apiKey: maskKey(cfg.apiKey || ''), hasConfigKey: Boolean(cfg.apiKey) },
        volume: clampVolume(cfg.volume),
        language: normalizeLanguage(cfg.language),
        languages: LANGUAGES,
        // 方言已归置为音色的一种（dialect-* 音色项），这里回报当前音色对应的方言。
        dialect: dialectOfSample(cfg.voiceSample),
        dialectOnlyInZh: true,
        // 实际生效的 TTS 模型：中文可克隆；非中文与方言音色会自动改用预置音色。
        voiceModel: {
          effective: effectiveTtsModel(cfg),
          note: '非中文语种和方言音色会自动使用预置音色（克隆的中文音色读外语既慢又不稳）；克隆音色仅用于中文。',
        },
        speechRate: {
          factor: speechRateFactor(cfg),
          defaults: SPEECH_RATE_FACTORS,
          custom: Number.isFinite(Number(cfg.speechRateFactor)) && Number(cfg.speechRateFactor) > 0.5 && Number(cfg.speechRateFactor) < 2,
        },
        voice: { sample: cfg.voiceSample || '', presets: voicePresets(cfg) },
        personaPrompt: personaPromptFor(cfg),
        avatarVersion: avatarInfo(cfg).mtime || 0,
        runtime: { ffmpeg: await probeFfmpeg(cfg) },
        persona: {
          callMe: String(cfg.callMe || '').trim(),
          customAnnounces: normalizeCustomLibrary(cfg.customAnnounces),
          customOnly: cfg.customOnly === true,
          builtinAnnounces: builtinAnnounceLibrary(),
        },
      })
    }
    if (method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed' })
    const body = await readJson(req)
    const hasKey = Object.prototype.hasOwnProperty.call(body, 'apiKey')
    const hasSample = Object.prototype.hasOwnProperty.call(body, 'voiceSample')
    const hasCall = Object.prototype.hasOwnProperty.call(body, 'callMe')
    const hasVolume = Object.prototype.hasOwnProperty.call(body, 'volume')
    const apiKey = hasKey ? String(body.apiKey || '').trim() : ''
    const nextSample = hasSample ? String(body.voiceSample || '').trim() : ''
    // 称呼是念出来的：压空白、去换行、限长 16，字符集只放行中英文/数字/间隔号。
    const nextCall = hasCall ? String(body.callMe || '').trim().replace(/\s+/g, ' ').slice(0, 16) : ''
    let nextVolume = null
    if (hasVolume) {
      const raw = Number(body.volume)
      if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
        return json(res, 400, { ok: false, code: 'bad-volume', message: '音量只能是 0 到 1 之间的小数（如 0.6）。' })
      }
      nextVolume = Math.round(raw * 100) / 100
    }
    if (hasKey && apiKey && !/^[\x21-\x7e]{16,}$/.test(apiKey)) {
      return json(res, 400, { ok: false, code: 'bad-key', message: 'API Key 看起来不像有效值（应为 16 位以上的可见 ASCII 字符）。' })
    }
    // 方言音色不是真实文件（走预置音色 + 标签），单独放行；其余只认插件目录里已有的采样。
    if (hasSample && nextSample && !dialectOfSample(nextSample) && !isKnownSample(nextSample)) {
      return json(res, 400, { ok: false, code: 'bad-sample', message: '只能选插件目录里已存在的 mp3/wav 采样。' })
    }
    if (hasCall && nextCall && !/^[\u4e00-\u9fa5A-Za-z0-9_· ]+$/.test(nextCall)) {
      return json(res, 400, { ok: false, code: 'bad-address', message: '称呼只能是中文、英文、数字、「·」或空格，最长 16 个字符。' })
    }
    // 自定义结束语库：{completed,error,aborted} 按桶配（也接受旧版平铺数组 = completed）。
    // 每桶最多 20 句、每句 40 字、不留控制字符。
    const hasLines = Object.prototype.hasOwnProperty.call(body, 'customAnnounces')
    const hasOnly = Object.prototype.hasOwnProperty.call(body, 'customOnly')
    let nextLibrary = null
    if (hasLines) {
      const src = body.customAnnounces
      const rawLib = Array.isArray(src) ? { completed: src } : src && typeof src === 'object' ? src : {}
      nextLibrary = { completed: [], error: [], aborted: [] }
      for (const bucket of ['completed', 'error', 'aborted']) {
        const list = Array.isArray(rawLib[bucket]) ? rawLib[bucket] : typeof rawLib[bucket] === 'string' ? rawLib[bucket].split(/\n+/) : []
        if (list.filter((line) => String(line || '').trim()).length > 20) {
          return json(res, 400, { ok: false, code: 'too-many-lines', message: '每类结束语最多 20 句。' })
        }
        nextLibrary[bucket] = normalizeCustomLines(list)
        if (nextLibrary[bucket].some((line) => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(line))) {
          return json(res, 400, { ok: false, code: 'bad-lines', message: '结束语里有不支持的字符。' })
        }
      }
    }
    const nextOnly = hasOnly ? body.customOnly === true : null
    // 汇报语种：白名单外一律拒绝（防止把任意字符串塞进翻译提示词）。
    const hasLang = Object.prototype.hasOwnProperty.call(body, 'language')
    let nextLang = null
    if (hasLang) {
      nextLang = String(body.language || '').trim().toLowerCase()
      if (!Object.prototype.hasOwnProperty.call(LANGUAGES, nextLang)) {
        return json(res, 400, { ok: false, code: 'bad-language', message: '语种只能是 ' + Object.keys(LANGUAGES).join(' / ') + '。' })
      }
    }
    // 方言不再作为独立配置项：已归置为音色的一种（voiceSample 里的 dialect-* 音色）。
    // 旧配置里的 dialect 字段仍接受但会被忽略——它现在的语义由音色决定。
    const hasDialect = Object.prototype.hasOwnProperty.call(body, 'dialect')
    // 语速倍率：0.5–2 之间的小数；传 null/'' = 清除自定义，回落按语种默认。
    const hasRate = Object.prototype.hasOwnProperty.call(body, 'speechRateFactor')
    let nextRate = null
    if (hasRate) {
      const raw = body.speechRateFactor
      if (raw === null || raw === '' || raw === undefined) {
        nextRate = ''
      } else {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0.5 || n >= 2) {
          return json(res, 400, { ok: false, code: 'bad-speech-rate', message: '语速倍率要在 0.5 到 2 之间（1 = 不变，1.12 = 快 12%）。' })
        }
        nextRate = Math.round(n * 100) / 100
      }
    }
    // 只切语种、没显式给语速 → 自动清掉自定义倍率，让新语种用自己的默认倍率。
    // （否则用户切到日语仍会沿用之前给中文存下的 1.00×，表现为"日语还是慢"。）
    const autoResetRate = hasLang && shouldResetRateOnLanguageChange(cfg.language, nextLang, hasRate)
    // 人设提示词：{ id, text }。text 留空 = 删除该音色的自定义，回落默认人设。
    // id 只认安全字符（对应采样文件名去掉前缀），text 限 200 字、不留控制字符。
    const hasPersona = Object.prototype.hasOwnProperty.call(body, 'personaPrompt')
    let nextPersona = null
    if (hasPersona) {
      const p = body.personaPrompt && typeof body.personaPrompt === 'object' ? body.personaPrompt : {}
      const pid = String(p.id || '').trim()
      const ptext = String(p.text || '').trim().replace(/\s+/g, ' ').slice(0, 200)
      if (!/^[\w-]{1,64}$/.test(pid)) {
        return json(res, 400, { ok: false, code: 'bad-persona-id', message: '人设 id 不合法（应为音色的短标识，如 tsundere）。' })
      }
      if (ptext && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(ptext)) {
        return json(res, 400, { ok: false, code: 'bad-persona-text', message: '人设提示词里有不支持的字符。' })
      }
      nextPersona = { id: pid, text: ptext }
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
        if (hasLines) next.customAnnounces = nextLibrary
        if (hasOnly) next.customOnly = nextOnly
        if (hasVolume) next.volume = nextVolume
        if (hasLang) next.language = nextLang
        if (hasRate) {
          if (nextRate === '') delete next.speechRateFactor
          else next.speechRateFactor = nextRate
        }
        if (autoResetRate) delete next.speechRateFactor
        if (hasPersona) {
          const lib = { ...(next.personaPrompts || {}) }
          if (nextPersona.text) lib[nextPersona.id] = nextPersona.text
          else delete lib[nextPersona.id]
          next.personaPrompts = lib
        }
        return next
      })
      // 立即生效；下一次配置重载会用新值再 apply 一遍。
      if (hasKey) cfg.apiKey = apiKey
      if (hasSample) cfg.voiceSample = nextSample
      if (hasCall) cfg.callMe = nextCall
      if (hasLines) cfg.customAnnounces = nextLibrary
      if (hasOnly) cfg.customOnly = nextOnly
      if (hasVolume) cfg.volume = nextVolume
      if (hasLang) cfg.language = nextLang
      if (hasRate) {
        if (nextRate === '') delete cfg.speechRateFactor
        else cfg.speechRateFactor = nextRate
      }
      if (autoResetRate) delete cfg.speechRateFactor
      if (hasPersona) {
        const lib = { ...(cfg.personaPrompts || {}) }
        if (nextPersona.text) lib[nextPersona.id] = nextPersona.text
        else delete lib[nextPersona.id]
        cfg.personaPrompts = lib
      }
      return json(res, 200, {
        ok: true,
        api: 4,
        keySource: describeKeySource(cfg),
        keyHint: maskKey(apiKey || resolveApiKey(cfg)),
        volume: clampVolume(cfg.volume),
        language: normalizeLanguage(cfg.language),
        languages: LANGUAGES,
        dialect: dialectOfSample(cfg.voiceSample),
        dialectOnlyInZh: true,
        voiceModel: {
          effective: effectiveTtsModel(cfg),
          note: '非中文语种和方言音色会自动使用预置音色；克隆音色仅用于中文。',
        },
        speechRate: {
          factor: speechRateFactor(cfg),
          defaults: SPEECH_RATE_FACTORS,
          custom: Number.isFinite(Number(cfg.speechRateFactor)) && Number(cfg.speechRateFactor) > 0.5 && Number(cfg.speechRateFactor) < 2,
        },
        personaPrompt: personaPromptFor(cfg),
        voice: { sample: cfg.voiceSample || '', presets: voicePresets(cfg) },
        persona: {
          callMe: String(cfg.callMe || '').trim(),
          customAnnounces: normalizeCustomLibrary(cfg.customAnnounces),
          customOnly: cfg.customOnly === true,
          builtinAnnounces: builtinAnnounceLibrary(),
        },
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

    // 缓存按 turn 记（key 不含正文：结束语是从池子里随机抽的、摘要模型输出也有波动，
    // 把文本掺进 key 会让同 turn 的缓存几乎永远 miss）。先查缓存、后生成：
    // 命中时连那次摘要模型调用都省掉；force 重试想"换一句"就跳过缓存重新生成。
    const turnKey = `${sessionId}:${rec.turn}:${rec.endedAt}`
    if (body.force !== true) {
      const hit = cache.get(turnKey)
      if (hit) {
        host.reports += 1
        pushEvent(host, 'report-cache-hit', { turn: rec.turn })
        return json(res, 200, { ...hit, cached: true })
      }
    }

    // 并发合并：同 turn 的请求共用同一次生成（produceReport 永远 resolve，不会 reject）。
    let producer = inflight.get(turnKey)
    if (!producer) {
      producer = produceReport({ sessionId, rec, force: body.force === true, cfg, cache, host, turnKey })
      inflight.set(turnKey, producer)
      const clear = () => {
        if (inflight.get(turnKey) === producer) inflight.delete(turnKey)
      }
      producer.then(clear, clear)
    }
    return json(res, 200, await producer)
  }

  if (url.pathname === '/mimo-voice/say') {
    if (method !== 'POST') return json(res, 405, { ok: false, code: 'method-not-allowed' })
    if (!sayAllowed()) {
      pushEvent(host, 'say-rate-limited', {})
      return json(res, 429, { ok: false, code: 'rate-limited', message: '试听有点频繁，一分钟后再试。' })
    }
    const body = await readJson(req)
    const text = String(body.text || '').trim().slice(0, 300)
    if (!text) return json(res, 400, { ok: false, code: 'missing-text' })
    try {
      const audio = await synthesize(text, cfg)
      mimoBreaker.success('tts')
      pushEvent(host, 'say-ok', { chars: Array.from(text).length, bytes: audio.length })
      return json(res, 200, { ok: true, text, audio, mime: 'audio/mpeg', voice: cfg.voice, cached: false })
    } catch (error) {
      // 试听端点不兜底提示音（它就是要验证 MiMo 本身），但要计数、要给出具体原因。
      const info = classifyMimoError(error)
      mimoBreaker.fail('tts', info.kind, cfg)
      host.failures += 1
      host.lastError = errorSnapshot(info)
      pushEvent(host, 'say-failed', { kind: info.kind, status: info.status || 0 })
      return json(res, 200, {
        ok: false,
        code: 'tts-failed',
        kind: info.kind,
        message: info.message,
        status: info.status || undefined,
        bodySnippet: info.bodySnippet || undefined,
      })
    }
  }

  if (url.pathname === '/mimo-voice/preview') {
    if (method !== 'GET') return json(res, 405, { ok: false, code: 'method-not-allowed' })
    const sample = String(url.searchParams.get('voice') || '')
    // 方言音色也带固定试听（预置音色 + 方言标签合成）；缺文件时仍回落实时合成。
    if (!dialectOfSample(sample) && !isKnownSample(sample)) {
      return json(res, 400, { ok: false, code: 'bad-voice', message: '只能试听插件目录里已存在的采样。' })
    }
    const preview = previewFileFor(sample)
    if (!preview) return json(res, 404, { ok: false, code: 'no-preview', message: '这条音色没有固定试听，可输入台词实时生成。' })
    try {
      const body = readFileSync(join(HERE, preview))
      res.statusCode = 200
      res.setHeader('content-type', 'audio/mpeg')
      res.setHeader('cache-control', 'public, max-age=300')
      res.end(body)
    } catch {
      return json(res, 404, { ok: false, code: 'no-preview', message: '这条音色没有固定试听，可输入台词实时生成。' })
    }
    return
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
      persona: {
        voice: cfg.voice,
        style: String(cfg.style || '').slice(0, 200),
        tags: cfg.tags,
        callMe: String(cfg.callMe || '').trim(),
        volume: clampVolume(cfg.volume),
        language: normalizeLanguage(cfg.language),
        dialect: dialectOfSample(cfg.voiceSample),
        promptId: personaPromptFor(cfg).id,
        promptCustom: personaPromptFor(cfg).custom,
        announce: (() => {
          const lib = normalizeCustomLibrary(cfg.customAnnounces)
          return { custom: { completed: lib.completed.length, error: lib.error.length, aborted: lib.aborted.length }, customOnly: cfg.customOnly === true }
        })(),
      },
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
      events: host.events,
      mimo: {
        tts: mimoBreaker.state().tts,
        summary: mimoBreaker.state().summary,
        fallbacks: host.fallbacks,
        ding: Boolean(fallbackDingDataUrl(cfg)),
      },
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

/**
 * 生成一次播报载荷（/report 的核心；独立于 res，并发请求共用同一次生成）。
 * 所有失败都折进载荷返回（兜底提示音或 ok:false），不会 reject。
 */
async function produceReport({ sessionId, rec, force, cfg, cache, host, turnKey }) {
  const lang = normalizeLanguage(cfg.language)
  let text, displayText, translateError = ''

  // 优先走合并双语生成（一次调用同时产出目标语种 + 中文对照，省一半延迟）。
  // 仅 completed + 非中文 + model summarizer 时可用；失败则回落到两步法。
  const bilingual = await generateBilingualReport(rec, cfg, lang)
  if (bilingual) {
    text = bilingual.text
    displayText = bilingual.displayText
    pushEvent(host, 'bilingual-ok', { lang, turn: rec.turn })
  } else {
    // 回落：中文稿 → 翻译（两步法，兼容 error/aborted 等非 completed 场景）。
    const chineseText = await buildReportText(rec, cfg)
    text = chineseText
    displayText = chineseText
    if (lang !== 'zh' && chineseText) {
      const result = await translateReportDetailed(chineseText, cfg, lang)
      if (result.text) {
        text = result.text
        displayText = `${result.text}\n${chineseText}`
      } else {
        translateError = result.error || 'unknown'
        pushEvent(host, 'translate-skipped', { lang, reason: translateError, turn: rec.turn })
        host.lastError = { at: Date.now(), kind: 'translate', message: `翻译成 ${lang} 失败（${translateError}），本轮改播中文` }
      }
    }
  }

  // —— MiMo 不可用的应对：冷却期内不直连，直接发兜底提示音 ——
  const sendFallback = (kind, message) => {
    host.fallbacks += 1
    pushEvent(host, 'fallback', { kind, turn: rec.turn })
    const ding = fallbackDingDataUrl(cfg)
    if (!ding) {
      return { ok: false, code: 'tts-failed', kind, message, text, displayText }
    }
    return {
      ok: true,
      fallback: true,
      kind,
      message,
      text,
      displayText,
      translateError: translateError || undefined,
      audio: ding.slice(ding.indexOf(',') + 1),
      mime: 'audio/wav',
      voice: cfg.voice,
      model: cfg.model,
      turn: rec.turn,
      reason: rec.reason,
      endedAt: rec.endedAt,
      cached: false,
    }
  }

  if (!force && mimoBreaker.open('tts')) {
    const kind = mimoBreaker.kind('tts') || 'cooldown'
    host.lastError = { at: Date.now(), kind, message: 'MiMo 连续失败，冷却中' }
    return sendFallback('cooldown', 'MiMo 连续失败，冷却中；稍后自动恢复，点小喇叭可立即重试')
  }

  try {
    const audio = await synthesize(text, cfg)
    mimoBreaker.success('tts')
    const payload = {
      ok: true,
      fallback: false,
      text,
      displayText,
      translateError: translateError || undefined,
      audio,
      mime: 'audio/mpeg',
      voice: cfg.voice,
      model: cfg.model,
      turn: rec.turn,
      reason: rec.reason,
      endedAt: rec.endedAt,
      cached: false,
    }
    cache.set(turnKey, payload)
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
    host.reports += 1
    host.lastReport = {
      at: Date.now(),
      sessionId,
      text,
      displayText,
      turn: rec.turn,
      bytes: audio.length,
      lang: normalizeLanguage(cfg.language),
      hasTranslation: Boolean(displayText && displayText !== text),
    }
    pushEvent(host, 'tts-ok', { turn: rec.turn, bytes: audio.length, chars: Array.from(text).length })
    return payload
  } catch (error) {
    const info = classifyMimoError(error)
    mimoBreaker.fail('tts', info.kind, cfg)
    host.failures += 1
    host.lastError = errorSnapshot(info)
    pushEvent(host, 'tts-failed', { kind: info.kind, status: info.status || 0, turn: rec.turn })
    return sendFallback(info.kind, `${info.message}；已用提示音代替`)
  }
}

function createHostState() {
  return {
    reports: 0,
    failures: 0,
    fallbacks: 0,
    sessionCount: 0,
    lastReport: null,
    lastError: null,
    lastClient: null,
    clientEvents: 0,
    events: [],
  }
}

const MAX_EVENTS = 50

/** 诊断事件环形缓冲（新的在前，最多 MAX_EVENTS 条）：失败分类、熔断开闭、兜底、缓存命中都在 /state.events 里。 */
function pushEvent(host, type, data = {}) {
  if (!host || !Array.isArray(host.events)) return
  host.events.unshift({ at: Date.now(), type, ...data })
  if (host.events.length > MAX_EVENTS) host.events.length = MAX_EVENTS
}

/** lastError 统一形状：归类消息 + 原始 HTTP 状态码与响应片段，方便事后排查（而不是只剩一句中文归类）。 */
function errorSnapshot(info) {
  const snap = { at: Date.now(), kind: info.kind, message: info.message }
  if (info.status) snap.status = info.status
  if (info.bodySnippet) snap.bodySnippet = info.bodySnippet
  return snap
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
  // 熔断打开时跳过模型改写，直接走抽取式——冷却期里不再白等一次注定失败（或超时）的请求。
  if (kind === 'completed' && String(cfg.summarizer || DEFAULTS.summarizer) !== 'extract' && !mimoBreaker.open('summary')) {
    // 称呼在这里生效：announce 已带称呼，dedupeAnnounce 的前缀剥离同样按它对齐。
    const announce = announceOf(kind, cfg)
    const source = cleanText(rec.text)
    if (source.length >= 24) {
      try {
        const spoken = await summarizeWithModel(source, cfg, announce)
        mimoBreaker.success('summary')
        const deduped = spoken ? dedupeAnnounce(spoken, announce) : ''
        if (deduped) return announce + deduped
      } catch (error) {
        // 摘要模型不可用就记入熔断，然后退回抽取式——播报不能因为改写失败而消失。
        mimoBreaker.fail('summary', classifyMimoError(error).kind, cfg)
      }
    }
  }
  return composeReport(rec, cfg)
}

/**
 * 合并双语生成：一次模型调用同时产出目标语种口播稿 + 中文对照行。
 * 比「先中文摘要 → 再翻译」省一次 chat 调用（延迟减半）。
 * 返回 { text, displayText } 或 null（失败时调用方回落到两步法）。
 * 只在 kind==='completed' 且 language!=='zh' 时有意义；其他情况返回 null。
 */
export async function generateBilingualReport(rec, cfg = {}, lang = 'en') {
  const target = normalizeLanguage(lang)
  if (target === 'zh') return null
  const kind = rec && rec.reason ? rec.reason : 'unknown'
  if (kind !== 'completed') return null
  if (String(cfg.summarizer || DEFAULTS.summarizer) === 'extract') return null
  if (mimoBreaker.open('summary')) return null
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) return null
  const source = cleanText(rec.text)
  if (source.length < 24) return null
  const baseUrl = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
  const limit = Number(cfg.summaryMaxChars) > 20 ? Number(cfg.summaryMaxChars) : DEFAULTS.summaryMaxChars
  const persona = personaPromptFor(cfg)
  const announce = announceOf(kind, cfg)

  const systemPrompt =
    `${persona.text}\n` +
    `你正在给对话里的用户做语音汇报。请根据下面的任务结果，同时输出两行：\n` +
    `第一行：用${LANGUAGES[target]}说一句到两句口播稿（最多 ${limit} 字），语气符合你的人设，` +
    `开头自然地表达"完成了"的意思（参考这句中文开场：「${announce}」，但不要直译，用${LANGUAGES[target]}的自然说法）。\n` +
    `第二行：第一行的忠实中文版本（以「${announce}」开头）。\n` +
    `严格只输出这两行，不要解释、不要引号、不要 Markdown。第一行绝对不能包含中文汉字。`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) > 1000 ? Number(cfg.timeoutMs) : DEFAULTS.timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.summaryModel || DEFAULTS.summaryModel,
        temperature: 0,
        max_tokens: 300,
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: source.slice(0, 2400) },
        ],
      }),
      signal: controller.signal,
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`MiMo 双语 HTTP ${res.status}: ${raw.slice(0, 200)}`)
    const payload = JSON.parse(raw)
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string') return null
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length < 2) return null
    const spoken = lines[0].replace(/^["""「『]+|["""」』]+$/g, '').trim()
    const chinese = lines[1].replace(/^["""「『]+|["""」』]+$/g, '').trim()
    if (spoken.length < 4 || chinese.length < 4) return null
    // 泄漏检测：第一行不应含中文（日语除外，日语本身用汉字）
    if (isSourceLanguageLeak(spoken, target)) return null
    // 中文行应以 announce 开头（允许轻微偏差）
    const dedupedZh = dedupeAnnounce(chinese, announce)
    const finalZh = dedupedZh ? announce + dedupedZh : chinese
    mimoBreaker.success('summary')
    return { text: spoken.slice(0, 400), displayText: `${spoken.slice(0, 400)}\n${finalZh.slice(0, 400)}` }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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

/**
 * 内置结束语库：每类结局一组候选，播报时随机挑一句，且不与该类的上一句连续重复。
 * 完成/出错/中止三类可再叠自定义库（cfg.customAnnounces 按 {completed,error,aborted} 分桶，
 * 「被打断」归中止桶）；cfg.customOnly 为 true 时，配了自定义的桶只用自己的句子。
 */
const ANNOUNCE_POOL = {
  completed: ['任务完成啦。', '搞定啦。', '收工啦。', '这轮跑完啦。', '嗯，全部做好了。'],
  error: ['呜，任务出错了。', '呀，这轮出错了。', '呜呜，这轮翻车了。', '哎呀，出问题了。'],
  aborted: ['任务先停在这里啦。', '好，先停在这里。', '这轮先到这儿啦。'],
  interrupted: ['任务被打断啦。', '诶，被打断了。', '被叫停了啦。'],
  blocked: ['任务卡住啦，在等你点头。', '卡住了，等你点个头。', '它在等你确认哦。'],
  'max-tokens': ['长度到上限啦。', '说到上限啦。', '篇幅到顶啦。'],
  forked: ['任务分叉好啦。', '分出一条岔路啦。'],
  unknown: ['这一轮结束啦。', '这轮告一段落啦。'],
}

/** 每类上次挑中的句子，用来避免连着两次念同一句。 */
const lastAnnounce = {}

/** 三类可自定义的桶：完成 / 出错 / 中止（「被打断」也归入中止桶）。 */
const CUSTOM_KINDS = ['completed', 'error', 'aborted']

/** 结局类别 → 自定义桶；没有桶的类别（被拦/上限/分叉/未知）只用内置库。 */
export function kindBucketOf(kind) {
  if (kind === 'interrupted') return 'aborted'
  return CUSTOM_KINDS.indexOf(kind) >= 0 ? kind : ''
}

/** 把一份结束语清单收敛成干净数组：接受数组，或按行拆的字符串。 */
export function normalizeCustomLines(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\n+/) : []
  return list
    .map((line) => String(line || '').trim().replace(/\s+/g, ' ').slice(0, 40))
    .filter(Boolean)
    .slice(0, 20)
}

/** 收敛用户配置的结束语库：{completed,error,aborted} 对象；旧版的平铺数组视为 completed。 */
export function normalizeCustomLibrary(raw) {
  const lib = { completed: [], error: [], aborted: [] }
  if (Array.isArray(raw)) {
    lib.completed = normalizeCustomLines(raw)
    return lib
  }
  if (!raw || typeof raw !== 'object') return lib
  for (const kind of CUSTOM_KINDS) {
    const value = raw[kind]
    if (Array.isArray(value) || typeof value === 'string') lib[kind] = normalizeCustomLines(value)
  }
  return lib
}

/** 设置卡展示用的内置默认库（三类；「被打断」的候选并进中止桶展示）。 */
export function builtinAnnounceLibrary() {
  return {
    completed: ANNOUNCE_POOL.completed.slice(),
    error: ANNOUNCE_POOL.error.slice(),
    aborted: ANNOUNCE_POOL.aborted.concat(ANNOUNCE_POOL.interrupted),
  }
}

/** 某类结局当前可用的候选池：内置默认库 + 该桶的自定义库（customOnly 时该桶只用自己的）。 */
export function announcePool(kind, cfg = {}) {
  const key = ANNOUNCE_POOL[kind] ? kind : 'unknown'
  const rawLib = cfg.customAnnounces === undefined ? DEFAULTS.customAnnounces : cfg.customAnnounces
  const bucket = kindBucketOf(key)
  const custom = bucket ? normalizeCustomLibrary(rawLib)[bucket] : []
  const builtin = custom.length && cfg.customOnly === true ? [] : ANNOUNCE_POOL[key]
  return builtin.concat(custom)
}

/** 该类结局所有候选装饰好称呼后的样子（测试 / 预览用）。 */
export function announceAll(kind, cfg = {}) {
  return announcePool(kind, cfg).map((line) => decorateAnnounce(line, cfg))
}

/** 称呼统一缀在句尾（"任务完成啦，主人。"）：放句首会劈开"呜，"这类语气词开头。 */
function decorateAnnounce(base, cfg = {}) {
  const raw = cfg.callMe === undefined ? DEFAULTS.callMe : cfg.callMe
  const address = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 16)
  // 句子里已经写到称呼就不再缀，避免"主人，饭好了，主人。"
  if (!address || base.indexOf(address) >= 0) return base
  return base.endsWith('。') ? base.slice(0, -1) + '，' + address + '。' : base + '，' + address + '。'
}

/** 挑一句结束提示：随机、尽量不与上一句连续重复，然后缀上称呼。 */
export function announceOf(kind, cfg = {}) {
  const pool = announcePool(kind, cfg)
  let line = pool[Math.floor(Math.random() * pool.length)] || '这一轮结束啦。'
  if (pool.length > 1 && line === lastAnnounce[kind]) {
    // 连重了就在"其余句子"里重挑：index+1+rand(len-1) 对 len 取模，均匀且必不同。
    line = pool[(pool.indexOf(line) + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length]
  }
  lastAnnounce[kind] = line
  return decorateAnnounce(line, cfg)
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
      // 人设句随音色走（默认鲸鱼娘，可按音色自定义）；结构性规则全体通用。
      content: buildSummaryPrompt(cfg, limit, announce),
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

/**
 * 把中文口播稿翻译成目标语种（仅用于字幕/悬停文字的附加译文；语音仍播中文）。
 * 失败返回空串——调用方静默省略译文，不影响播报本体。
 */
export async function translateReport(text, cfg = {}, lang = 'en') {
  return (await translateReportDetailed(text, cfg, lang)).text
}

/**
 * 翻译的详细版本：返回 { text, error }。
 * text 为空且 error 有值 = 翻译失败（调用方应记录原因，而不是静默回落）。
 */
export async function translateReportDetailed(text, cfg = {}, lang = 'en') {
  const target = normalizeLanguage(lang)
  const source = String(text || '').trim()
  if (target === 'zh' || !source) return { text: '', error: 'empty-or-zh' }
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) return { text: '', error: 'no-key' }
  const baseUrl = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')

  // 提示词必须「明确目标语言 + 禁止夹杂中文」。
  // 实测（mimo-v2.6-flash）：旧写法「把中文口播稿翻译成English（en）」对 en/ko 会原样吐中文，
  // 只有明确要求「输出必须完全是 X、不得夹杂中文句子」才稳定生效；日语不能禁用汉字（本身就用）。
  const systemPrompt =
    `你是一名专业翻译。把用户给的中文文本翻译成${LANGUAGES[target]}（语言代码 ${target}）。` +
    `输出必须完全是${LANGUAGES[target]}：不要夹杂任何中文句子、不要解释、不要原文、不要引号、不要 Markdown，只输出译文。`

  const attempt = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) > 1000 ? Number(cfg.timeoutMs) : DEFAULTS.timeoutMs)
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.summaryModel || DEFAULTS.summaryModel,
          temperature: 0,
          max_tokens: 240,
          reasoning_effort: 'none',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: source.slice(0, 600) },
          ],
        }),
        signal: controller.signal,
      })
      const raw = await res.text()
      if (!res.ok) {
        const error = new Error(`MiMo 翻译 HTTP ${res.status}: ${raw.slice(0, 200)}`)
        error.status = res.status
        error.body = raw
        throw error
      }
      const payload = JSON.parse(raw)
      const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content
      if (typeof content !== 'string') return { text: '', error: 'no-content' }
      const out = content.replace(/^["“「『]+|["”」』]+$/g, '').trim()
      if (out.length < 2) return { text: '', error: 'too-short' }
      // 模型仍可能偷懒原样返回中文（尤其目标语种是 en/ko 时）：这时宁可判失败，
      // 让调用方回落中文播报，也不要拿中文当"译文"贴出去。
      if (isSourceLanguageLeak(out, target)) return { text: '', error: 'not-translated' }
      return { text: out.slice(0, 400), error: '' }
    } finally {
      clearTimeout(timer)
    }
  }

  let lastError = ''
  for (let round = 0; round < 2; round++) {
    try {
      return await attempt()
    } catch (error) {
      const kind = classifyMimoError(error).kind
      lastError = `${kind}:${String((error && error.message) || error).slice(0, 80)}`
      // 只对「再来一次可能就好」的错误重试：瞬态网络/超时/5xx。
      // 实测宿主进程偶发 `fetch failed`（连接复用被打断），重试一次即可恢复。
      if (round === 0 && (kind === 'network' || kind === 'timeout' || kind === 'server')) continue
      break
    }
  }
  return { text: '', error: lastError || 'failed' }
}

/**
 * 判断模型是否把中文原样当成译文返回了。
 * en/ko 下出现汉字即视为未翻译；日语本身用汉字，只看有没有假名。
 */
export function isSourceLanguageLeak(text, lang) {
  const value = String(text || '')
  if (!value) return false
  const target = normalizeLanguage(lang)
  if (target === 'ja') return !/[\u3040-\u309f\u30a0-\u30ff]/.test(value)
  if (target === 'ko') return !/[\uac00-\ud7af]/.test(value)
  if (target === 'en') return /[\u4e00-\u9fff]/.test(value)
  return false
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
  let match = /^(好的?|嗯|那)?[，,]?\s*(任务)?(已经|都)?(完成|做好|搞定|收工|跑完)(啦|了|咯|啦～)?[。！!～~]?[，,]?\s*/.exec(text)
  if (match && match[0].trim()) cut(match[0].length)

  // 再兜一层：第一句很短又只讲"完成了"，且后面还有内容，就整句丢掉。
  const sentences = text.split(/(?<=[。！？!?])/).map((part) => part.trim()).filter(Boolean)
  if (sentences.length > 1 && sentences[0].length <= 14 && /(完成|做好|搞定|收工|跑完|好啦|好了)/.test(sentences[0]) && !/\d/.test(sentences[0])) {
    text = sentences.slice(1).join('')
  }

  return text.trim()
}

/**
 * MiMo 错误分类：路由层和摘要层共用，让"不可用"有具体原因可提示、可熔断。
 * kind：no-key / auth / quota / timeout / network / server / bad-request / no-audio / unknown
 */
const MIMO_ERROR_MESSAGES = {
  'no-key': '还没配置 MiMo API Key',
  auth: 'MiMo API Key 无效或没有权限',
  quota: 'MiMo 额度或配额用尽了',
  timeout: 'MiMo 请求超时',
  network: '连不上 MiMo 服务',
  server: 'MiMo 服务端出错（5xx）',
  'bad-request': 'MiMo 拒绝了这次请求（400）',
  'no-audio': 'MiMo 没有返回音频数据',
  unknown: 'MiMo 调用失败',
}

export function classifyMimoError(error) {
  const err = error || {}
  const status = Number(err.status || 0)
  const raw = String(err.message || err)
  let kind = err.mimoKind || ''
  if (!kind) {
    if (err.code === 'no-key' || /缺少 MiMo API Key/.test(raw)) kind = 'no-key'
    else if (status === 401 || status === 403) kind = 'auth'
    else if (status === 402 || status === 429) kind = 'quota'
    else if (status >= 500) kind = 'server'
    else if (status === 400) kind = 'bad-request'
    else if (err.name === 'AbortError' || err.name === 'TimeoutError' || /aborted|TIMEOUT/i.test(raw)) kind = 'timeout'
    else if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT|network/i.test(raw)) kind = 'network'
    else if (/没有音频数据/.test(raw)) kind = 'no-audio'
    else kind = 'unknown'
  }
  const message = MIMO_ERROR_MESSAGES[kind] || MIMO_ERROR_MESSAGES.unknown
  return {
    kind,
    message: raw && kind === 'unknown' ? `${message}：${raw.slice(0, 90)}` : message,
    // 原始信息别丢：归类后的中文短语用来展示，状态码和响应片段用来排查。
    status: status || undefined,
    bodySnippet: String(err.body || '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined,
  }
}

/**
 * 熔断器：连续 3 次失败进入冷却期（默认 5 分钟），期间不再打 MiMo——
 * 摘要直接走抽取式、TTS 直接发兜底提示音，避免每次播报都白等一次超时。
 * force 请求可穿透冷却（设置卡的"重试"就是 force）。
 */
const BREAKER = {
  summary: { fails: 0, until: 0, kind: '' },
  tts: { fails: 0, until: 0, kind: '' },
}

/** apply() 里注册：熔断开/关写进诊断事件流（/state.events）。 */
let breakerListener = null

export const mimoBreaker = {
  state() {
    const now = Date.now()
    const shape = (b) => ({ fails: b.fails, open: now < b.until, cooldownUntil: b.until, lastKind: b.kind })
    return { summary: shape(BREAKER.summary), tts: shape(BREAKER.tts) }
  },
  open(which) {
    return Date.now() < BREAKER[which].until
  },
  kind(which) {
    return BREAKER[which].kind
  },
  fail(which, kind, cfg = {}) {
    const b = BREAKER[which]
    const wasOpen = Date.now() < b.until
    b.fails += 1
    b.kind = kind || 'unknown'
    const ms = Number(cfg.cooldownMs) > 10000 ? Number(cfg.cooldownMs) : DEFAULTS.cooldownMs
    if (b.fails >= 3) b.until = Date.now() + ms
    if (b.fails === 3 && !wasOpen && breakerListener) {
      breakerListener({ type: 'breaker-open', which, kind: b.kind, cooldownMs: ms })
    }
  },
  success(which) {
    const b = BREAKER[which]
    const wasOpen = Date.now() < b.until
    BREAKER[which] = { fails: 0, until: 0, kind: '' }
    if (wasOpen && breakerListener) breakerListener({ type: 'breaker-recovered', which })
  },
  listen(fn) {
    breakerListener = typeof fn === 'function' ? fn : null
  },
  resetForTest() {
    for (const key of Object.keys(BREAKER)) BREAKER[key] = { fails: 0, until: 0, kind: '' }
  },
}

/** 兜底提示音：MiMo 不可用时播的内置"叮"（8KB wav，随插件发布）。留空/文件缺失则返回 ''。 */
let dingCache = { key: '', data: '' }

export function fallbackDingDataUrl(cfg = {}) {
  const rel = String(cfg.fallbackDing === undefined ? DEFAULTS.fallbackDing : cfg.fallbackDing || '')
  if (!rel) return ''
  const file = isAbsolute(rel) ? rel : join(HERE, rel)
  try {
    const info = statSync(file)
    const key = `${file}:${info.mtimeMs}:${info.size}`
    if (dingCache.key !== key) {
      dingCache = { key, data: `data:audio/wav;base64,${readFileSync(file).toString('base64')}` }
    }
    return dingCache.data
  } catch {
    return ''
  }
}

/**
 * 实际使用的 TTS 模型。
 * 两类情况必须走预置音色（克隆音色的中文底子会把它们带偏）：
 * 1. 方言音色：克隆样本的普通话口音无法覆盖（实测指令/标签全无效）；
 * 2. 非中文语种：克隆音色读外语又慢又飘——实测同一句韩语，克隆 2.9–5.1s 生成、
 *    音频 8.3–14.2s（还出现过 33.5s 与 >60s 不返回），预置音色稳定 2.0–2.3s / 6.1–6.4s。
 * 想强制沿用克隆音色，设 cfg.keepCloneForOtherLanguages = true。
 */
export function effectiveTtsModel(cfg = {}) {
  if (dialectOfSample(cfg.voiceSample)) return 'mimo-v2.5-tts'
  if (normalizeLanguage(cfg.language) !== 'zh' && cfg.keepCloneForOtherLanguages !== true) return 'mimo-v2.5-tts'
  return cfg.model || DEFAULTS.model
}

/** 调用 MiMo-TTS，返回 base64 mp3。瞬态错误（超时/网络/5xx）自动重试一次。 */
export async function synthesize(text, cfg) {
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) {
    const err = new Error('缺少 MiMo API Key：请在插件 config.apiKey、环境变量 MIMO_API_KEY 或 ~/.dsh/.credentials.yaml 的 refs 中提供。')
    err.mimoKind = 'no-key'
    throw err
  }
  const baseUrl = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
  // 方言现在归置成「音色的一种」：从 voiceSample 里解析（方言音色只在中文语种下提供）。
  const dialectId = dialectOfSample(cfg.voiceSample)
  const dialectCode = dialectId ? (DIALECT_PRESETS.find((preset) => preset.id === dialectId) || {}).dialect || '' : ''
  const messages = []
  // 人设/风格指令走 user message（不会念出来），这是 MiMo-TTS 的自然语言控制通道。
  // 语速（按语种）+ 用户自填 style 在这里叠加注入。
  const style = speechRateStyle(cfg)
  if (style) messages.push({ role: 'user', content: style })
  // 音频标签必须紧贴正文开头，例如 "(温柔 清亮 俏皮)任务完成啦。"
  const tags = String(cfg.tags === undefined ? DEFAULTS.tags : cfg.tags || '').trim()
  // 方言标签：实测只有标签通道对预置音色生效（克隆音色会被参考样本的普通话口音锁死）。
  const dialectTag = DIALECT_TAGS[dialectCode] || ''
  messages.push({ role: 'assistant', content: dialectTag + tags + String(text) })

  // 方言音色 / 非中文语种都走预置音色（原因见 effectiveTtsModel 注释）。
  const model = effectiveTtsModel(cfg)
  const audio = { format: 'mp3' }
  if (model === 'mimo-v2.5-tts') {
    audio.voice = cfg.voice || DEFAULTS.voice
  } else if (model === 'mimo-v2.5-tts-voiceclone') {
    // 复刻模型要的是 DataURL（不是裸 base64），采样从插件目录里的 mp3 读。
    audio.voice = voiceSampleDataUrl(cfg)
  }
  // voicedesign 不接受 voice 字段，只用 user message 描述音色。

  // 语种差异：非中文合成明显更慢，实测韩语偶发超过 30s 才返回（触发 Abort）。
  const lang = normalizeLanguage(cfg.language)
  const configuredTimeout = Number(cfg.timeoutMs) > 1000 ? Number(cfg.timeoutMs) : DEFAULTS.timeoutMs
  const nonZhFloor = Number(cfg.otherLanguageTimeoutMs) > 1000 ? Number(cfg.otherLanguageTimeoutMs) : DEFAULTS.otherLanguageTimeoutMs
  const requestTimeout = Math.max(configuredTimeout, lang === 'zh' ? 0 : nonZhFloor)
  const longAudioThreshold = Number(cfg.longAudioSeconds) > 5 ? Number(cfg.longAudioSeconds) : DEFAULTS.longAudioSeconds

  const attempt = async (rateBoost = 0) => {
    // 异常长音频重试时临时提一点语速（不改用户的持久配置）。
    const rateCfg = rateBoost > 0
      ? { ...cfg, speechRateFactor: Math.min(1.9, speechRateFactor(cfg) + rateBoost) }
      : cfg
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeout)
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, audio }),
        signal: controller.signal,
      })
      const raw = await res.text()
      if (!res.ok) {
        const error = new Error(`MiMo TTS HTTP ${res.status}: ${raw.slice(0, 300)}`)
        error.status = res.status
        error.body = raw
        throw error
      }
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
      // 语速是确定性的后处理：按语种倍率做变速不变调（ffmpeg atempo），失败则原样返回。
      return await applySpeechRate(data, rateCfg)
    } finally {
      clearTimeout(timer)
    }
  }

  let lastError = null
  for (let round = 0; round < 2; round++) {
    try {
      const first = await attempt()
      // 长音频保护：MiMo 偶发把一句短话说成 20s+（实测韩语出现过 33.5s），
      // 非中文语种再合成一次（临时提速），取更短的一条；两次都失败就用第一条。
      const chars = Array.from(String(text)).length
      if (lang !== 'zh' && chars > 0 && chars < 200 && estimateSeconds(first) > longAudioThreshold) {
        try {
          const second = await attempt(0.15)
          return estimateSeconds(second) < estimateSeconds(first) ? second : first
        } catch {
          return first
        }
      }
      return first
    } catch (error) {
      lastError = error
      const kind = classifyMimoError(error).kind
      error.mimoKind = kind
      // 只重试"再来一次可能就好"的错：超时、网络、5xx；鉴权/额度/参数错重试也没用。
      if (round === 0 && (kind === 'timeout' || kind === 'network' || kind === 'server')) continue
      throw error
    }
  }
  throw lastError
}

/**
 * 按 mp3 字节数粗估时长（MiMo 输出约 128kbps ≈ 16KB/s）。
 * 只用于识别「明显被拖长」的异常音频，不要求精确。
 */
export function estimateSeconds(base64Audio) {
  const bytes = Buffer.from(String(base64Audio || ''), 'base64').length
  return Math.round((bytes / 16000) * 10) / 10
}

/**
 * 确定性变速：把 base64 mp3 用 ffmpeg atempo 变速（不变调），返回新的 base64。
 * 倍率 ≈1 时原样返回；任何失败都原样返回（变速是增强，不能让播报失败）。
 */

// ffmpeg 可用性探测（懒加载、模块级缓存）：没有 ffmpeg 时语速静默失效，
// 但 /state 会暴露这个状态，设置卡可以提示用户。
let ffmpegProbe = null // null=未探测, true=可用, false=不可用
export async function probeFfmpeg(cfg = {}) {
  if (ffmpegProbe !== null) return ffmpegProbe
  const ffmpeg = String(cfg.ffmpegPath || process.env.DSH_FFMPEG || 'ffmpeg')
  try {
    const out = await runProcess(ffmpeg, ['-hide_banner', '-version'])
    ffmpegProbe = out.code === 0
  } catch {
    ffmpegProbe = false
  }
  return ffmpegProbe
}

export async function applySpeechRate(base64Audio, cfg = {}) {
  const factor = speechRateFactor(cfg)
  if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.01) return base64Audio
  if (!(await probeFfmpeg(cfg))) return base64Audio
  const ffmpeg = String(cfg.ffmpegPath || process.env.DSH_FFMPEG || 'ffmpeg')
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const inFile = join(tmpdir(), `mimo-voice-in-${stamp}.mp3`)
  const outFile = join(tmpdir(), `mimo-voice-out-${stamp}.mp3`)
  try {
    writeFileSync(inFile, Buffer.from(base64Audio, 'base64'))
    // 走真实文件而不是 pipe：宿主环境里 stdin 管道偶发不可用，读回也可能是空文件。
    const out = await runProcess(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inFile,
      '-filter:a',
      `atempo=${factor.toFixed(2)}`,
      '-b:a',
      '128k',
      outFile,
    ])
    if (out.code !== 0) return base64Audio
    if (!existsSync(outFile)) return base64Audio
    const result = readFileSync(outFile)
    return result.length > 1000 ? result.toString('base64') : base64Audio
  } catch {
    return base64Audio
  } finally {
    for (const file of [inFile, outFile]) {
      try {
        rmSync(file, { force: true })
      } catch {}
    }
  }
}

/** 跑一个子进程，stdin 喂 bytes，返回 { code }。 */
function runProcess(file, args, inputBytes) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { windowsHide: true })
    } catch {
      resolve({ code: -1 })
      return
    }
    child.on('error', () => resolve({ code: -1 }))
    child.on('close', (code) => resolve({ code }))
    try {
      if (inputBytes && child.stdin) child.stdin.end(inputBytes)
    } catch {}
  })
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

/**
 * 方言音色：方言被归置为「音色的一种」——选中即用预置音色 + 方言标签发音。
 * 只在语种为中文（zh）时出现在下拉框里：非中文语种要播外语，方言没有意义。
 * id 形如 dialect-yue，file 为空（不是真实采样文件，走预置音色路径）。
 */
export const DIALECT_PRESETS = [
  { id: 'dialect-yue', label: '粤语', dialect: 'yue' },
  { id: 'dialect-sc', label: '四川话', dialect: 'sc' },
  { id: 'dialect-ne', label: '东北话', dialect: 'ne' },
  { id: 'dialect-ha', label: '河南话', dialect: 'ha' },
  { id: 'dialect-sd', label: '山东话', dialect: 'sd' },
  { id: 'dialect-tw', label: '台湾腔', dialect: 'tw' },
]

/** 从 voiceSample 里解析方言音色 id（dialect-*）；不是方言音色返回空串。 */
export function dialectOfSample(sampleFile) {
  const file = String(sampleFile || '')
  const match = /^voice-sample-(dialect-[\w-]+)\.mp3$/i.exec(file)
  if (match) {
    const id = match[1].toLowerCase()
    return DIALECT_PRESETS.some((preset) => preset.id === id) ? id : ''
  }
  return ''
}

/**
 * 可选音色列表：内置两条在前，方言音色（仅中文语种）居中，插件目录其余采样按名序排后。
 * 标出当前选中的那条。标签从 PRESET_LABELS 取，没登记的用去前缀的文件名。
 */
export function voicePresets(cfg = {}) {
  const current = String(cfg.voiceSample || '')
  const lang = normalizeLanguage(cfg.language)
  const files = new Set(VOICE_PRESETS.map((preset) => preset.file))
  try {
    for (const name of readdirSync(HERE)) {
      if (/^voice-sample[-\w]*\.(mp3|wav)$/i.test(name)) files.add(name)
    }
  } catch {}
  const builtin = VOICE_PRESETS.filter((preset) => files.has(preset.file)).map((preset) => ({
    id: preset.id,
    label: PRESET_LABELS[preset.file] || preset.label,
    file: preset.file,
    kind: 'clone',
    selected: current === preset.file,
    exists: existsSync(join(HERE, preset.file)),
  }))
  // 方言只在中文下可选：选了外语还要方言，声音会说外语却按方言腔调，没有意义。
  const dialectPresets = lang === 'zh'
    ? DIALECT_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        file: `voice-sample-${preset.id}.mp3`,
        kind: 'dialect',
        dialect: preset.dialect,
        selected: current === `voice-sample-${preset.id}.mp3`,
        exists: true,
      }))
    : []
  const extras = Array.from(files)
    .filter((file) => !VOICE_PRESETS.some((preset) => preset.file === file))
    .filter((file) => !dialectOfSample(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const id = file.replace(/^voice-sample-?/i, '').replace(/\.(mp3|wav)$/i, '')
      return {
        id,
        label: PRESET_LABELS[file] || id,
        file,
        kind: 'clone',
        selected: current === file,
        exists: existsSync(join(HERE, file)),
      }
    })
  return builtin.concat(dialectPresets, extras)
}

/**
 * 采样文件 → 对应的固定试听文件。preview-* 不进入音色扫描，也不会误当克隆采样。
 * 没有固定试听时返回空字符串，设置卡会引导用户改走实时生成。
 */
export function previewFileFor(sampleFile) {
  const file = String(sampleFile || '')
  if (file === 'voice-sample.mp3') return 'preview-original.mp3'
  const match = /^voice-sample-([\w-]+)\.(mp3|wav)$/i.exec(file)
  return match ? `preview-${match[1].toLowerCase()}.mp3` : ''
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
    return { path: file, ok: true, bytes: info.size, mime, mtime: Math.round(info.mtimeMs) }
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
/** 音量收敛：0–1，非法值回落到 1（默认全音量）。 */
export function clampVolume(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100))
}

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

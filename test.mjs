/**
 * 纯函数自测（不碰网络、不需要 DSH 运行）：node test.mjs
 * 覆盖：文本清理、摘要截断、结束语库、错误分类（含原始状态码）、Key 掩码、熔断状态机。
 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { existsSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cleanText,
  summarize,
  composeReport,
  dedupeAnnounce,
  normalizeCustomLines,
  normalizeCustomLibrary,
  announcePool,
  kindBucketOf,
  classifyMimoError,
  maskKey,
  mimoBreaker,
  voicePresets,
  previewFileFor,
  apply,
  clampVolume,
  voicePersonaId,
  personaPromptFor,
  buildSummaryPrompt,
  normalizeLanguage,
  normalizeDialect,
  speechRateStyle,
  speechRateFactor,
  SPEECH_RATE_FACTORS,
  shouldResetRateOnLanguageChange,
  dialectOfSample,
  isSourceLanguageLeak,
  effectiveTtsModel,
  reportConfigFingerprint,
  createMimoBreaker,
  handleRequest,
  probeFfmpeg,
  applySpeechRate,
} from './index.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL ' + name + ' :: ' + (error && error.message))
  }
}

await test('cleanText 抹掉 Markdown 噪声', () => {
  const out = cleanText(
    '## 标题\n\n- **加粗**项\n\n```js\ncode\n```\n[链接](https://x.com)正文\n\n| 项目 | 结果 |\n| --- | --- |\n| TTS | 通过 |\n\nA|B 这种行内竖线保留'
  )
  assert.ok(!out.includes('#'), '不应保留标题井号')
  assert.ok(!out.includes('**'), '不应保留加粗符号')
  assert.ok(!out.includes('```'), '不应保留代码块')
  assert.ok(!out.includes('https://x.com'), '不应保留链接地址')
  assert.ok(!out.includes('通过'), '表格行应整行去掉')
  assert.ok(out.includes('加粗') && out.includes('链接'), '应保留正文文字')
  assert.ok(out.includes('A|B'), '行内竖线不是表格，应保留')
})

await test('summarize 截断到上限并补句号', () => {
  const out = summarize('这是一段很长很长的总结。'.repeat(20), 40)
  assert.ok(out.length <= 42, '超长未截断: ' + out.length)
  assert.ok(/[。！？]$/.test(out), '结尾应补句号')
})

await test('summarize 丢掉"已完成"样板开场', () => {
  const out = summarize('已完成。\n新增了语音插件，宿主半负责调用合成，浏览器半负责播放。', 90)
  assert.ok(!out.startsWith('已完成'), '样板句应被丢掉')
})

await test('composeReport 完成轮含结束语与总结', () => {
  const out = composeReport({ reason: 'completed', text: '结果已经写在对话里啦。' }, {})
  assert.ok(/完成|搞定|收工|跑完|做好/.test(out), '应含完成提示: ' + out)
  assert.ok(out.includes('结果'), '应含总结: ' + out)
})

await test('dedupeAnnounce 剥掉重复的完成提示', () => {
  assert.equal(dedupeAnnounce('任务完成啦，新增了插件。'), '新增了插件。')
  assert.equal(dedupeAnnounce('好的，任务完成啦！三个文件都改好了。'), '三个文件都改好了。')
})

await test('dedupeAnnounce 短样板句整句丢掉', () => {
  const out = dedupeAnnounce('任务完成啦。新增了插件并修好了构建流程。')
  assert.equal(out, '新增了插件并修好了构建流程。')
})

await test('normalizeCustomLines 限 20 句、每句 40 字', () => {
  const lines = Array.from({ length: 30 }, (_, i) => '第' + i + '句' + '很'.repeat(60))
  const out = normalizeCustomLines(lines)
  assert.equal(out.length, 20, '应只留 20 句')
  assert.ok(out.every((line) => line.length <= 40), '每句应 ≤40 字')
})

await test('normalizeCustomLibrary 兼容旧版平铺数组与按行字符串', () => {
  assert.equal(normalizeCustomLibrary(['a', 'b']).completed.length, 2)
  const lib = normalizeCustomLibrary({ completed: 'x\ny', error: [], aborted: null })
  assert.deepEqual(lib.completed, ['x', 'y'])
  assert.deepEqual(lib.error, [])
  assert.deepEqual(lib.aborted, [])
})

await test('announcePool 自定义并入、customOnly 只用自定义、无桶类别不掺', () => {
  const cfg = { customAnnounces: { completed: ['鱼干已备好，请查收。'] } }
  const mixed = announcePool('completed', cfg)
  assert.ok(mixed.length > 1, '应并入内置池')
  assert.ok(mixed.includes('鱼干已备好，请查收。'), '应含自定义句')
  assert.deepEqual(announcePool('completed', { ...cfg, customOnly: true }), ['鱼干已备好，请查收。'])
  assert.ok(announcePool('forked', cfg).every((line) => !line.includes('鱼干')), 'forked 不应掺自定义')
})

await test('kindBucketOf：被打断归中止桶，无桶类别为空', () => {
  assert.equal(kindBucketOf('interrupted'), 'aborted')
  assert.equal(kindBucketOf('completed'), 'completed')
  assert.equal(kindBucketOf('forked'), '')
})

await test('classifyMimoError 按 HTTP 状态分类并保留原始信息', () => {
  const mk = (status, body) => Object.assign(new Error('x'), { status, body })
  assert.equal(classifyMimoError(mk(401, '')).kind, 'auth')
  assert.equal(classifyMimoError(mk(403, '')).kind, 'auth')
  assert.equal(classifyMimoError(mk(402, '')).kind, 'quota')
  assert.equal(classifyMimoError(mk(429, '')).kind, 'quota')
  assert.equal(classifyMimoError(mk(503, '')).kind, 'server')
  assert.equal(classifyMimoError(mk(400, '')).kind, 'bad-request')
  const info = classifyMimoError(mk(429, '{"error":"rate  limited"}'))
  assert.equal(info.status, 429, '应带原始状态码')
  assert.equal(info.bodySnippet, '{"error":"rate limited"}', '应带压平后的响应片段')
  const abort = new Error('This operation was aborted')
  abort.name = 'AbortError'
  assert.equal(classifyMimoError(abort).kind, 'timeout')
  assert.equal(classifyMimoError(new Error('fetch failed')).kind, 'network')
})

await test('maskKey 只露头尾', () => {
  assert.equal(maskKey('tp-cjfbmedme1mfawtx02jpxtkhyrg1fh6866wjucjx08g14zcd'), 'tp-…4zcd')
  assert.equal(maskKey('short'), 'sh…')
  assert.equal(maskKey(''), '')
})

await test('mimoBreaker 三连败开冷却、成功即复位', () => {
  mimoBreaker.resetForTest()
  const cfg = { cooldownMs: 300000 }
  mimoBreaker.fail('tts', 'timeout', cfg)
  mimoBreaker.fail('tts', 'timeout', cfg)
  assert.equal(mimoBreaker.open('tts'), false, '两连败不应开冷却')
  mimoBreaker.fail('tts', 'timeout', cfg)
  assert.equal(mimoBreaker.open('tts'), true, '三连败应开冷却')
  assert.equal(mimoBreaker.state().tts.lastKind, 'timeout')
  mimoBreaker.success('tts')
  assert.equal(mimoBreaker.open('tts'), false, '成功应关闭冷却')
  assert.equal(mimoBreaker.state().tts.fails, 0)
})

await test('voicePresets 动态列出全部采样且标签正确', () => {
  const presets = voicePresets({ voiceSample: 'voice-sample-playful.mp3' })
  const files = presets.map((preset) => preset.file)
  for (const file of [
    'voice-sample.mp3',
    'voice-sample-playful.mp3',
    'voice-sample-tsundere.mp3',
    'voice-sample-kuudere.mp3',
    'voice-sample-genki.mp3',
    'voice-sample-onee.mp3',
    'voice-sample-yandere.mp3',
    'voice-sample-doll.mp3',
    'voice-sample-loli.mp3',
    'voice-sample-gyaru.mp3',
    'voice-sample-ojou.mp3',
    'voice-sample-tennen.mp3',
    'voice-sample-koakuma.mp3',
    'voice-sample-bokukko.mp3',
    'voice-sample-inkyo.mp3',
    'voice-sample-bunge.mp3',
  ]) {
    assert.ok(files.includes(file), '缺采样: ' + file)
  }
  const byFile = Object.fromEntries(presets.map((preset) => [preset.file, preset]))
  assert.equal(byFile['voice-sample-tsundere.mp3'].label, '傲娇小猫')
  assert.equal(byFile['voice-sample-kuudere.mp3'].label, '清冷药师')
  assert.equal(byFile['voice-sample-genki.mp3'].label, '元气应援')
  assert.equal(byFile['voice-sample-onee.mp3'].label, '温柔姐姐')
  assert.equal(byFile['voice-sample-yandere.mp3'].label, '病娇低语')
  assert.equal(byFile['voice-sample-doll.mp3'].label, '无口人偶')
  assert.equal(byFile['voice-sample-loli.mp3'].label, '软萌萝莉')
  assert.equal(byFile['voice-sample-gyaru.mp3'].label, '涩谷辣妹')
  assert.equal(byFile['voice-sample-ojou.mp3'].label, '名门大小姐')
  assert.equal(byFile['voice-sample-tennen.mp3'].label, '天然呆')
  assert.equal(byFile['voice-sample-koakuma.mp3'].label, '小恶魔')
  assert.equal(byFile['voice-sample-bokukko.mp3'].label, '假小子')
  assert.equal(byFile['voice-sample-inkyo.mp3'].label, '阴角少女')
  assert.equal(byFile['voice-sample-bunge.mp3'].label, '文学少女')
  assert.equal(byFile['voice-sample-playful.mp3'].selected, true, '当前采样应选中')
  assert.ok(presets.every((preset) => preset.exists), '列出的采样都应存在')
})

await test('previewFileFor 映射 16 条固定试听且文件都存在', () => {
  assert.equal(previewFileFor('voice-sample.mp3'), 'preview-original.mp3')
  const here = dirname(fileURLToPath(import.meta.url))
  for (const id of ['playful', 'tsundere', 'kuudere', 'genki', 'onee', 'yandere', 'doll', 'loli', 'gyaru', 'ojou', 'tennen', 'koakuma', 'bokukko', 'inkyo', 'bunge']) {
    const preview = previewFileFor(`voice-sample-${id}.mp3`)
    assert.equal(preview, `preview-${id}.mp3`)
    assert.ok(existsSync(join(here, preview)), '缺固定试听: ' + preview)
  }
  assert.ok(existsSync(join(here, 'preview-original.mp3')), '缺原版固定试听')
  assert.equal(previewFileFor('voice-sample-custom.wav'), 'preview-custom.mp3')
  assert.equal(previewFileFor(''), '')
  assert.equal(previewFileFor('../voice-sample-x.mp3'), '')
  assert.equal(previewFileFor('not-a-sample.mp3'), '')
  assert.equal(voicePresets({}).some((preset) => preset.file.startsWith('preview-')), false, '试听文件不得混入音色列表')
})

await test('/preview 直接返回固定 MP3，非法采样路径拒绝', async () => {
  let route = null
  const ctx = {
    on() {},
    effect(fn) { fn() },
    webServer: { register(value) { route = value } },
    get() { return null },
  }
  apply(ctx, { apiKey: '' })
  assert.ok(route && typeof route.handler === 'function', '应注册路由')
  async function request(path) {
    const chunks = []
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value },
      end(body) {
        if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
      },
    }
    await route.handler({ method: 'GET', url: path, on() {} }, res)
    return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }
  }
  const ok = await request('/mimo-voice/preview?voice=voice-sample-loli.mp3')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'audio/mpeg')
  assert.equal(ok.body.subarray(0, 3).toString('ascii'), 'ID3', '应返回真实 MP3')
  assert.ok(ok.body.length > 30000)
  const customSample = join(dirname(fileURLToPath(import.meta.url)), 'voice-sample-test-no-preview.mp3')
  writeFileSync(customSample, 'test')
  try {
    const missing = await request('/mimo-voice/preview?voice=voice-sample-test-no-preview.mp3')
    assert.equal(missing.status, 404)
    assert.ok(JSON.parse(missing.body.toString()).code === 'no-preview')
  } finally {
    unlinkSync(customSample)
  }
  const escaped = await request('/mimo-voice/preview?voice=..%2F..%2Fpackage.json')
  assert.equal(escaped.status, 400, '不得读取任意文件')
})

await test('clampVolume 收敛到 0–1 且非法值回落全音量', () => {
  assert.equal(clampVolume(0), 0)
  assert.equal(clampVolume(0.47), 0.47)
  assert.equal(clampVolume(1), 1)
  assert.equal(clampVolume(1.5), 1)
  assert.equal(clampVolume(-0.2), 0)
  assert.equal(clampVolume(Number.NaN), 1)
  assert.equal(clampVolume('x'), 1)
  assert.equal(clampVolume(undefined), 1)
})

await test('voicePersonaId 按采样文件名映射音色 id', () => {
  assert.equal(voicePersonaId('voice-sample.mp3'), 'original')
  assert.equal(voicePersonaId('voice-sample-tsundere.mp3'), 'tsundere')
  assert.equal(voicePersonaId('voice-sample-my-own.wav'), 'my-own')
  assert.equal(voicePersonaId(''), '')
  assert.equal(voicePersonaId('../evil.mp3'), '')
  assert.equal(voicePersonaId('preview-x.mp3'), '')
})

await test('personaPromptFor 自定义优先、未知音色回落鲸鱼娘', () => {
  const base = personaPromptFor({ voiceSample: 'voice-sample-tsundere.mp3' })
  assert.equal(base.id, 'tsundere')
  assert.equal(base.custom, false, '无自定义应用默认')
  assert.ok(base.text.includes('傲娇'), '默认人设应含角色关键词: ' + base.text.slice(0, 30))

  const custom = personaPromptFor({
    voiceSample: 'voice-sample-tsundere.mp3',
    personaPrompts: { tsundere: '你是毒舌但心软的狼少女。' },
  })
  assert.equal(custom.custom, true)
  assert.equal(custom.text, '你是毒舌但心软的狼少女。')

  const unknown = personaPromptFor({ voiceSample: 'voice-sample-my-own.mp3' })
  assert.equal(unknown.id, 'my-own')
  assert.equal(unknown.text, personaPromptFor({ voiceSample: 'voice-sample.mp3' }).text, '未知音色回落原版人设')

  const unknownWithCustom = personaPromptFor({
    voiceSample: 'voice-sample-my-own.mp3',
    personaPrompts: { 'my-own': '你是自定义采样里的角色。' },
  })
  assert.equal(unknownWithCustom.custom, true, '自定义采样也能配人设')
})

await test('方言音色各有内置人设且不回落原版', () => {
  const expected = {
    'dialect-yue': '粤语',
    'dialect-sc': '四川话',
    'dialect-ne': '东北话',
    'dialect-ha': '河南话',
    'dialect-sd': '山东话',
    'dialect-tw': '台湾腔',
  }
  const fallback = personaPromptFor({ voiceSample: 'voice-sample.mp3' }).text
  for (const [id, word] of Object.entries(expected)) {
    const p = personaPromptFor({ voiceSample: `voice-sample-${id}.mp3` })
    assert.equal(p.id, id, `${id} 应解析出正确的 id`)
    assert.equal(p.custom, false, `${id} 默认应走内置人设`)
    assert.notEqual(p.text, fallback, `${id} 不应回落原版人设`)
    assert.ok(p.text.includes(word), `${id} 人设应提到「${word}」: ` + p.text.slice(0, 40))
  }
  const custom = personaPromptFor({
    voiceSample: 'voice-sample-dialect-sc.mp3',
    personaPrompts: { 'dialect-sc': '你是温和的成都人。' },
  })
  assert.equal(custom.custom, true)
  assert.equal(custom.text, '你是温和的成都人。')
})

await test('六个方言音色只在中文下出现', () => {
  const zh = voicePresets({ language: 'zh' }).filter((p) => p.kind === 'dialect')
  assert.equal(zh.length, 6, '中文下应有 6 个方言音色')
  assert.deepEqual(zh.map((p) => p.label), ['粤语', '四川话', '东北话', '河南话', '山东话', '台湾腔'])
  for (const lang of ['en', 'ja', 'ko']) {
    assert.equal(voicePresets({ language: lang }).filter((p) => p.kind === 'dialect').length, 0, `${lang} 下不应有方言`)
  }
})

await test('buildSummaryPrompt 拼人设句与通用规则', () => {
  const plain = buildSummaryPrompt({}, 64, '')
  assert.ok(plain.includes('最多 64 个字'), '应含长度规则')
  assert.ok(plain.includes('不要 Markdown'), '应含格式规则')
  assert.ok(plain.includes('第一人称'), '应含人称规则')
  const withAnnounce = buildSummaryPrompt({}, 64, '任务完成啦。')
  assert.ok(withAnnounce.includes('不要再重复'), '有完成提示时应含去重规则')
  const customPrompt = buildSummaryPrompt({ voiceSample: 'voice-sample-loli.mp3', personaPrompts: { loli: '你是会数星星的小精灵。' } }, 64, '')
  assert.ok(customPrompt.startsWith('你是会数星星的小精灵。'), '自定义人设应拼在最前')
  assert.ok(customPrompt.includes('不要 Markdown'), '自定义人设也要带通用规则')
})

await test('normalizeLanguage 白名单收敛，非法值回落中文', () => {
  assert.equal(normalizeLanguage('zh'), 'zh')
  assert.equal(normalizeLanguage('en'), 'en')
  assert.equal(normalizeLanguage('JA'), 'ja')
  assert.equal(normalizeLanguage('ko'), 'ko')
  assert.equal(normalizeLanguage('fr'), 'zh', '白名单外语种回落 zh')
  assert.equal(normalizeLanguage(''), 'zh')
  assert.equal(normalizeLanguage(undefined), 'zh')
  assert.equal(normalizeLanguage('zh<script>'), 'zh')
})

await test('normalizeDialect 白名单收敛，非法值回落关闭', () => {
  assert.equal(normalizeDialect(''), '')
  assert.equal(normalizeDialect(undefined), '')
  assert.equal(normalizeDialect('yue'), 'yue')
  assert.equal(normalizeDialect('SC'), 'sc')
  assert.equal(normalizeDialect('ne'), 'ne')
  assert.equal(normalizeDialect('ha'), 'ha')
  assert.equal(normalizeDialect('tw'), 'tw')
  assert.equal(normalizeDialect('fr'), '', '白名单外方言回落关闭')
  assert.equal(normalizeDialect('yue<script>'), '')
})

await test('speechRateStyle 只拼用户 style（语速走 atempo，方言走音色/标签）', () => {
  assert.equal(speechRateStyle({}), '', '空配置应为空')
  assert.equal(speechRateStyle({ language: 'ja' }), '', '语速已改 atempo 后处理，style 通道不再注入语速')
  const withStyle = speechRateStyle({ language: 'ja', style: '温柔一点。' })
  assert.equal(withStyle, '温柔一点。', '只保留用户 style')
  const yueStyle = speechRateStyle({ language: 'zh', style: '俏皮一点。' })
  assert.equal(yueStyle, '俏皮一点。')
  assert.ok(!speechRateStyle({ language: 'zh', style: 'x' }).includes('粤语'), 'style 通道不再注入方言')
})

await test('dialectOfSample 从音色文件名解析方言', () => {
  assert.equal(dialectOfSample('voice-sample-dialect-yue.mp3'), 'dialect-yue')
  assert.equal(dialectOfSample('voice-sample-dialect-tw.mp3'), 'dialect-tw')
  assert.equal(dialectOfSample('voice-sample-loli.mp3'), '', '普通音色不是方言')
  assert.equal(dialectOfSample('voice-sample.mp3'), '')
  assert.equal(dialectOfSample(''), '')
  assert.equal(dialectOfSample('voice-sample-dialect-unknown.mp3'), '', '未登记的方言 id 不认')
})

await test('speechRateFactor 按语种给倍率且支持覆盖', () => {
  assert.equal(speechRateFactor({ language: 'zh' }), 1, '中文不变速')
  assert.equal(speechRateFactor({ language: 'ja' }), SPEECH_RATE_FACTORS.ja)
  assert.ok(SPEECH_RATE_FACTORS.ja > 1, '日语应当提速')
  assert.ok(SPEECH_RATE_FACTORS.ko > 1, '韩语应当提速')
  assert.ok(SPEECH_RATE_FACTORS.en > 1, '英语应当提速')
  assert.equal(speechRateFactor({ language: 'ja', speechRateFactor: 1.3 }), 1.3, '自定义倍率优先')
  assert.equal(speechRateFactor({ language: 'ja', speechRateFactor: 99 }), SPEECH_RATE_FACTORS.ja, '越界回落到语种默认')
  assert.equal(speechRateFactor({ language: 'ja', speechRateFactor: 'x' }), SPEECH_RATE_FACTORS.ja, '非法值回落默认')
  assert.equal(speechRateFactor({ language: 'zh', speechRateFactor: null }), 1, 'null 回落默认')
})

await test('切语种自动重置语速倍率', () => {
  assert.equal(shouldResetRateOnLanguageChange('zh', 'ja', false), true, '中文→日语应重置')
  assert.equal(shouldResetRateOnLanguageChange('ja', 'ko', false), true, '日语→韩语应重置')
  assert.equal(shouldResetRateOnLanguageChange('zh', 'ja', true), false, '显式设倍率时不重置')
  assert.equal(shouldResetRateOnLanguageChange('ja', 'ja', false), false, '语种未变不重置')
  assert.equal(shouldResetRateOnLanguageChange('ZH', 'ja', false), true, '大小写应归一化')
  assert.equal(shouldResetRateOnLanguageChange('zh', 'fr', false), false, '非法语种归一为 zh，等于没变')
})

await test('isSourceLanguageLeak 能识别"中文当译文"的偷懒输出', () => {
  assert.equal(isSourceLanguageLeak('任务完成了。', 'en'), true, '英文却返回中文应判失败')
  assert.equal(isSourceLanguageLeak('Task completed.', 'en'), false)
  assert.equal(isSourceLanguageLeak('任务完成了。', 'ko'), true)
  assert.equal(isSourceLanguageLeak('작업 완료했어요.', 'ko'), false)
  assert.equal(isSourceLanguageLeak('タスク完了です。', 'ja'), false, '日文含汉字但正常')
  assert.equal(isSourceLanguageLeak('任务完成了。', 'ja'), true, '纯中文且无假名判失败')
  assert.equal(isSourceLanguageLeak('任务完成了。', 'zh'), false)
  assert.equal(isSourceLanguageLeak('', 'en'), false)
})

await test('effectiveTtsModel：中文克隆、外语/方言自动预置', () => {
  const clone = { model: 'mimo-v2.5-tts-voiceclone', voiceSample: 'voice-sample-onee.mp3' }
  assert.equal(effectiveTtsModel({ ...clone, language: 'zh' }), 'mimo-v2.5-tts-voiceclone', '中文保持克隆')
  for (const lang of ['ja', 'ko', 'en']) {
    assert.equal(effectiveTtsModel({ ...clone, language: lang }), 'mimo-v2.5-tts', lang + ' 应自动用预置音色')
  }
  assert.equal(
    effectiveTtsModel({ ...clone, language: 'ko', keepCloneForOtherLanguages: true }),
    'mimo-v2.5-tts-voiceclone',
    '显式开启后仍可用克隆',
  )
  assert.equal(
    effectiveTtsModel({ model: 'mimo-v2.5-tts-voiceclone', voiceSample: 'voice-sample-dialect-yue.mp3', language: 'zh' }),
    'mimo-v2.5-tts',
    '方言音色强制预置',
  )
})

// ——— 第一阶段回归：缓存指纹 / force 并发替换 / 熔断器实例隔离 ———

await test('reportConfigFingerprint：影响生成的配置变化都会换缓存槽', () => {
  const base = { voiceSample: 'voice-sample.mp3', language: 'zh' }
  const a = reportConfigFingerprint(base)
  assert.equal(reportConfigFingerprint({ ...base }), a, '同配置指纹应稳定')
  assert.notEqual(reportConfigFingerprint({ ...base, callMe: '主人' }), a, '称呼变化应换指纹')
  assert.notEqual(reportConfigFingerprint({ ...base, language: 'ja' }), a, '语种变化应换指纹')
  assert.notEqual(reportConfigFingerprint({ ...base, voice: '茉莉' }), a, '预置音色变化应换指纹')
  assert.notEqual(reportConfigFingerprint({ ...base, voiceSample: 'voice-sample-loli.mp3' }), a, '采样变化应换指纹')
  assert.notEqual(
    reportConfigFingerprint({ ...base, personaPrompts: { original: '你是另一个角色。' } }),
    a,
    '人设变化应换指纹',
  )
  assert.equal(reportConfigFingerprint({ ...base, apiKey: 'tp-aaaaaaaaaaaaaaaaaaaa' }), a, 'apiKey 不参与指纹')
})

await test('createMimoBreaker：实例间状态隔离，listen 返回注销函数', () => {
  const cfg = { cooldownMs: 60000 }
  const b1 = createMimoBreaker()
  const b2 = createMimoBreaker()
  const events = []
  const unlisten = b1.listen((event) => events.push(event.type))
  b1.fail('tts', 'timeout', cfg)
  b1.fail('tts', 'timeout', cfg)
  b1.fail('tts', 'timeout', cfg)
  assert.equal(b1.open('tts'), true, '实例 1 三连败应开冷却')
  assert.equal(b2.open('tts'), false, '实例 2 不应被实例 1 带开')
  assert.equal(b2.state().tts.fails, 0, '实例 2 计数应为 0')
  assert.deepEqual(events, ['breaker-open'], '监听器应只收到自己实例的事件')
  unlisten()
  b1.fail('tts', 'timeout', cfg)
  assert.equal(events.length, 1, '注销后不再收到事件')
})

// ——— /report 集成：缓存按配置指纹、force 替换旧任务且旧任务不能回写缓存 ———

function mockRequest(body) {
  const payload = Buffer.from(JSON.stringify(body || {}))
  const closeCbs = []
  return {
    method: 'POST',
    url: '/mimo-voice/report',
    on(event, cb) {
      if (event === 'data') queueMicrotask(() => cb(payload))
      if (event === 'end') queueMicrotask(() => cb())
      if (event === 'close') closeCbs.push(cb)
    },
    __emitClose() { closeCbs.slice().forEach((cb) => cb()) },
  }
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(body) {
      this.writableEnded = true
      if (body) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    },
    bodyText() { return Buffer.concat(this.chunks).toString('utf8') },
  }
}

function ttsResponse(mark) {
  const audio = Buffer.from((`audio-${mark}-`).repeat(10)).toString('base64')
  return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { audio: { data: audio } } }] }) }
}

function chatResponse() {
  return {
    ok: true,
    text: async () => JSON.stringify({ choices: [{ message: { content: '我把这一轮的结果都整理好了。' } }] }),
  }
}

function makeReportHarness(cfgOverrides = {}) {
  const cfg = {
    apiKey: 'test-key-1234567890',
    baseUrl: 'https://mock.test/v1',
    model: 'mimo-v2.5-tts',
    voice: '冰糖',
    language: 'zh',
    summarizer: 'extract',
    staleMs: 25000,
    cooldownMs: 300000,
    ...cfgOverrides,
  }
  const rec = {
    turn: 1,
    text: '这是一段足够长的任务结果，用来触发正常的抽取式摘要路径。',
    reason: 'completed',
    endedAt: Date.now(),
    toolCalls: 2,
    startedAt: Date.now() - 1000,
    interrupted: false,
  }
  const state = {
    cfg,
    cache: new Map(),
    inflight: new Map(),
    latestReportGeneration: new Map(),
    host: {
      reports: 0, failures: 0, fallbacks: 0, sessionCount: 1,
      lastReport: null, lastError: null, lastClient: null, clientEvents: 0, events: [],
      nextReportGeneration: 0,
    },
    breaker: createMimoBreaker(),
    fetchCalls: [],
    pendingFetches: [],
    fetchMode: 'auto',
    chatFailStatus: 0,
    lastReq: null,
  }
  state.chatCalls = () => state.fetchCalls.filter((c) => !String(c.body).includes('"audio"'))
  state.translateCalls = () => state.fetchCalls.filter((c) => String(c.body).includes('专业翻译'))
  state.bilingualCalls = () => state.fetchCalls.filter((c) => String(c.body).includes('同时输出两行'))
  state.resolveNextFetch = (mark) => {
    const resolve = state.pendingFetches.shift()
    if (!resolve) throw new Error('没有在等的 fetch')
    resolve(ttsResponse(mark))
  }
  state.record = () => rec
  const realFetch = globalThis.fetch
  globalThis.fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      state.fetchCalls.push({ url: String(url), body: String(opts.body || '') })
      const onAbort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort()
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      if (state.fetchMode === 'manual') {
        state.pendingFetches.push(resolve)
        return
      }
      const isTts = String(opts.body || '').includes('"audio"')
      if (!isTts && state.chatFailStatus) {
        resolve({ ok: false, status: state.chatFailStatus, text: async () => '{"error":{"message":"mock auth failure"}}' })
        return
      }
      resolve(isTts ? ttsResponse(state.fetchCalls.length) : chatResponse())
    })
  state.restore = () => { globalThis.fetch = realFetch }
  state.request = async (body) => {
    const res = mockResponse()
    const req = mockRequest(body)
    state.lastReq = req
    await handleRequest({
      req,
      res,
      cfg: state.cfg,
      record: state.record,
      cache: state.cache,
      host: state.host,
      inflight: state.inflight,
      breaker: state.breaker,
      latestReportGeneration: state.latestReportGeneration,
      editor: () => null,
    })
    return res
  }
  return state
}

await test('缓存命中省一次合成；配置变化后同 turn 重新生成', async () => {
  const t = makeReportHarness()
  try {
    const first = await t.request({ sessionId: 's1' })
    assert.equal(first.statusCode, 200)
    const firstBody = JSON.parse(first.bodyText())
    assert.equal(firstBody.ok, true)
    assert.equal(firstBody.cached, false)
    assert.equal(t.fetchCalls.length, 1, '首次应调用一次 TTS')

    const second = await t.request({ sessionId: 's1' })
    const secondBody = JSON.parse(second.bodyText())
    assert.equal(secondBody.cached, true, '同配置同 turn 应命中缓存')
    assert.equal(t.fetchCalls.length, 1, '缓存命中不应再合成')

    t.cfg.callMe = '主人'
    const third = await t.request({ sessionId: 's1' })
    const thirdBody = JSON.parse(third.bodyText())
    assert.equal(thirdBody.cached, false, '配置变化后同 turn 不应复用旧缓存')
    assert.equal(t.fetchCalls.length, 2, '配置变化应重新合成一次')
    assert.ok(thirdBody.text.includes('主人'), '新结果应带新称呼: ' + thirdBody.text)
  } finally {
    t.restore()
  }
})

await test('force 替换旧任务：旧任务晚完成不得覆盖新缓存', async () => {
  const t = makeReportHarness()
  t.fetchMode = 'manual'
  try {
    const normal = t.request({ sessionId: 's1' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(t.fetchCalls.length, 1, '普通请求应发起一次生成')
    const merged = t.request({ sessionId: 's1' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(t.fetchCalls.length, 1, '并发普通请求应去重')
    const forced = t.request({ sessionId: 's1', force: true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(t.fetchCalls.length, 2, 'force 应发起新的生成')

    t.resolveNextFetch('old')
    const normalBody = JSON.parse((await normal).bodyText())
    assert.equal(normalBody.ok, true)
    t.resolveNextFetch('new')
    const forcedBody = JSON.parse((await forced).bodyText())
    assert.equal(forcedBody.ok, true)
    assert.ok(forcedBody.audio.length > 0)
    const mergedBody = JSON.parse((await merged).bodyText())
    assert.equal(mergedBody.cached, false)

    const after = await t.request({ sessionId: 's1' })
    const afterBody = JSON.parse(after.bodyText())
    assert.equal(afterBody.cached, true, 'force 完成后普通请求应命中缓存')
    assert.equal(
      Buffer.from(afterBody.audio, 'base64').toString('utf8').includes('audio-new-'),
      true,
      '缓存里的必须是 force 的新结果，而不是晚完成的旧任务',
    )
    assert.equal(t.fetchCalls.length, 2, '命中缓存不应再合成')
  } finally {
    t.restore()
  }
})

// ——— 第二阶段回归：双语失败收敛 / 预算封顶 / 断连取消 / ffmpeg 防护 ———

await test('双语鉴权类失败：不串行摘要与翻译，直接中文兜底', async () => {
  const t = makeReportHarness({ language: 'en', summarizer: 'model' })
  t.chatFailStatus = 401
  try {
    const res = await t.request({ sessionId: 's1' })
    const body = JSON.parse(res.bodyText())
    assert.equal(body.ok, true, '播报本体仍应成功（TTS 正常）')
    assert.ok(/完成|搞定|跑完|收工|做好/.test(body.text), '致命根因下应直接播中文抽取稿: ' + body.text)
    assert.equal(body.translateError, 'bilingual-failed', '应带回跳过原因')
    assert.equal(t.bilingualCalls().length, 1, '双语只调 1 次')
    assert.equal(t.chatCalls().length, 1, 'chat 总调用只应有双语的 1 次（不再串行摘要/翻译）')
    assert.equal(t.translateCalls().length, 0, '鉴权失败不应再浪费翻译调用')
    assert.equal(t.fetchCalls.length, 2, '总共只有 双语 + TTS 两次调用')
    assert.equal(t.breaker.state().summary.fails, 1, '双语失败应计入 summary 熔断')
    assert.ok(t.host.events.some((e) => e.type === 'bilingual-failed'), '应记录 bilingual-failed 事件')
  } finally {
    t.restore()
  }
})

await test('双语持续失败累计打开 summary 熔断，之后不再打双语/摘要模型', async () => {
  const t = makeReportHarness({ language: 'en', summarizer: 'model' })
  t.chatFailStatus = 401
  try {
    let n = 0
    while (!t.breaker.open('summary') && n < 5) {
      n++
      await t.request({ sessionId: 's' + n })
    }
    assert.equal(t.breaker.open('summary'), true, '三连败后 summary 熔断应打开')
    const bilingualBefore = t.bilingualCalls().length
    const chatBefore = t.chatCalls().length
    const res = await t.request({ sessionId: 'after-breaker' })
    const body = JSON.parse(res.bodyText())
    assert.equal(body.ok, true, '熔断期播报仍应走抽取稿 + TTS')
    assert.equal(t.bilingualCalls().length, bilingualBefore, '熔断打开后不再调用双语')
    assert.ok(t.chatCalls().length - chatBefore <= 1, '熔断后 chat 调用不得增加超过翻译 1 次')
  } finally {
    t.restore()
  }
})

await test('播报预算封顶：各阶段超时被剩余预算压制，最终快速兜底且不写缓存', async () => {
  const t = makeReportHarness({ reportBudgetMs: 6000, timeoutMs: 2000 })
  t.fetchMode = 'manual'
  try {
    const started = Date.now()
    const res = await t.request({ sessionId: 's1' })
    const elapsed = Date.now() - started
    const body = JSON.parse(res.bodyText())
    assert.equal(body.fallback, true, '预算内两次 TTS 超时后应走兜底')
    assert.equal(body.kind, 'timeout', '阶段超时应归类为 timeout（预算封顶）')
    assert.equal(t.fetchCalls.length, 2, '两次 TTS 尝试都被预算封顶的 2s 超时打断')
    assert.ok(elapsed < 5500, `应在预算附近收尾，实际 ${elapsed}ms`)
    assert.equal(t.cache.size, 0, '兜底结果不进缓存')
    assert.ok(t.breaker.state().tts.fails >= 1, 'TTS 失败仍计入熔断')
  } finally {
    t.restore()
  }
})

await test('浏览器断连：在途生成立即取消，不计熔断、不写缓存', async () => {
  const t = makeReportHarness()
  t.fetchMode = 'manual'
  try {
    const pending = t.request({ sessionId: 's1' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(t.fetchCalls.length, 1, 'TTS 应已发起并被挂起')
    t.lastReq.__emitClose()
    const res = await pending
    const body = JSON.parse(res.bodyText())
    assert.equal(body.ok, false)
    assert.equal(body.code, 'cancelled', '应返回 cancelled 而不是等 TTS 超时')
    assert.equal(t.cache.size, 0, '取消的结果不进缓存')
    assert.equal(t.breaker.state().tts.fails, 0, '取消不是 MiMo 的错，不计熔断')
    assert.equal(t.host.failures, 0, '取消不算失败次数')
    assert.ok(t.host.events.some((e) => e.type === 'report-cancelled'), '应记录 report-cancelled 事件')
  } finally {
    t.restore()
  }
})

await test('ffmpeg 防护：缺失路径探测为 false，语速处理原样返回', async () => {
  const missing = 'Z:/definitely-no-such-ffmpeg.exe'
  assert.equal(await probeFfmpeg({ ffmpegPath: missing }), false, '缺失路径应探测失败')
  const audio = Buffer.from('fake-mp3-bytes').toString('base64')
  const out = await applySpeechRate(audio, { ffmpegPath: missing, speechRateFactor: 1.25 })
  assert.equal(out, audio, 'ffmpeg 不可用时应原样返回，变速静默跳过')
})

// ——— 客户端结构测试（正则断言，防止重构时意外丢失关键逻辑） ———
import { readFileSync as readClient } from 'node:fs'
const clientSrc = readClient(new URL('./client.js', import.meta.url), 'utf8')

await test('客户端：startReveal 同步驱动原文+译文', () => {
  assert.ok(/function startReveal\(el, text, translation\)/.test(clientSrc), '签名应含 translation 参数')
  assert.ok(/emit\(\{ shown: shown, transShown: transShown \}\)/.test(clientSrc), '应同时发射 shown + transShown')
})

await test('客户端：自适应隐藏时间', () => {
  assert.ok(/Math\.min\(9000, 2800 \+ totalChars \* 60\)/.test(clientSrc), 'hideCardSoon 应按字数自适应')
})

await test('客户端：avatar 缓存击穿', () => {
  assert.ok(/avatarVersion \? '\?v=' \+ avatarVersion/.test(clientSrc), 'img src 应带 ?v= 版本参数')
})

await test('客户端：ja/ko UI 文案', () => {
  assert.ok(/ja:\s*\{/.test(clientSrc), '应有日语 TEXT 字典')
  assert.ok(/ko:\s*\{/.test(clientSrc), '应有韩语 TEXT 字典')
  assert.ok(/TEXT\[forced\]/.test(clientSrc), 'pickText 应按 locale 索引')
})

await test('客户端：aria-label 含译文', () => {
  assert.ok(/v\.translation/.test(clientSrc) && /aria-label/.test(clientSrc), 'aria-label 应拼接 translation')
})

await test('客户端：切语种记住克隆音色', () => {
  assert.ok(/lastCloneSample/.test(clientSrc), '应在 localStorage 记住上次克隆音色')
})

await test('客户端：请求代次与失效路径', () => {
  assert.ok(/function invalidateRequests\(\)/.test(clientSrc), '应有统一的请求失效入口')
  assert.ok(/const isCurrent = function \(\) \{\s*\n\s*return alive\.current && requestSeq\.current === seq/.test(clientSrc), 'speak 应校验请求代次')
  assert.ok(/return play\(data, isCurrent\)/.test(clientSrc), '播放应继承请求代次')
  assert.ok(/if \(!isCurrent\(\)\) return/.test(clientSrc), '过期响应应静默丢弃')
  assert.ok(/invalidateRequests\(\)\s*\n\s*beginLeave\(\)/.test(clientSrc), '关闭语音应让在途请求/播放失效')
  assert.ok(/requestAbort\.current\.abort\(\)/.test(clientSrc), '应 abort 在途请求')
})

await test('客户端：spoken 记录有上限', () => {
  assert.ok(/SPOKEN_MAX = 64/.test(clientSrc), '应有已播记录上限')
  assert.ok(/function rememberSpoken\(key\)/.test(clientSrc), '应走 rememberSpoken 写入')
  assert.ok(/while \(spoken\.size > SPOKEN_MAX\)/.test(clientSrc), '超上限应淘汰最旧记录')
})

await test('宿主：force 生成带代次，缓存回写前校验代次', () => {
  const hostSrc = readClient(new URL('./index.js', import.meta.url), 'utf8')
  assert.ok(/latestReportGeneration\.set\(turnKey, generation\)/.test(hostSrc), '新任务应登记代次')
  assert.ok(/latestReportGeneration\.get\(turnKey\) === generation\)\s*\{\s*\n\s*cache\.set\(turnKey, payload\)/.test(hostSrc), '只有最新代次能写缓存')
})

await test('客户端：立绘加载失败可自愈', () => {
  assert.ok(/if \(v\.visible\) setAvatarOk\(true\)/.test(clientSrc), '浮层重新弹出时应重置 avatarOk 重试立绘')
  assert.ok(/data\.avatarVersion\) avatarVersion = Number\(data\.avatarVersion\)/.test(clientSrc), '按钮挂载的 /config 拉取也应同步 avatarVersion')
})

await test('第二阶段结构：预算 / 取消 / ffmpeg / 状态文件', () => {
  const hostSrc = readClient(new URL('./index.js', import.meta.url), 'utf8')
  assert.ok(/reportBudgetMs: 90000/.test(hostSrc), 'DEFAULTS 应有 90s 播报预算')
  assert.ok(/ffmpegTimeoutMs: 15000/.test(hostSrc), 'DEFAULTS 应有 ffmpeg 超时')
  assert.ok(/function linkSignal\(external, controller\)/.test(hostSrc), '应有取消信号联动')
  assert.ok(/timedOut/.test(hostSrc), 'runProcess 应支持超时杀进程')
  assert.ok(/stageTimeout\(\)/.test(hostSrc) && /opts\.signal/.test(hostSrc), '各阶段应接受预算超时与取消信号')
  assert.ok(/String\(rec\.text \|\| ''\)\.slice\(0, 2400\)/.test(hostSrc), '状态文件正文应截断')
  assert.ok(/renameSync\(tmp, STATE_FILE\)/.test(hostSrc), '状态文件应原子写入')
  assert.ok(/report-cancelled/.test(hostSrc) && /budget-exhausted/.test(hostSrc), '应有取消/预算事件')
  assert.ok(/srffwarn/.test(clientSrc), '设置卡应有 ffmpeg 缺失警告')
  assert.ok(/runtime\.ffmpeg === true/.test(clientSrc), '设置卡应读取 runtime.ffmpeg')
})

await test('方言试听文件存在', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const code of ['yue', 'sc', 'ne', 'ha', 'sd', 'tw']) {
    const f = join(here, `preview-dialect-${code}.mp3`)
    assert.ok(existsSync(f), `缺方言试听: preview-dialect-${code}.mp3`)
    assert.ok(statSync(f).size > 10000, `方言试听太小: ${code}`)
  }
})

// ——— 第三阶段：客户端行为测试（真实运行组件函数，fake React/Audio/fetch/定时器） ———

function mountClientButton(options = {}) {
  const running = { value: options.running === undefined ? true : options.running }
  const fetchLog = []
  const reportDeferred = []
  const audioPlays = []
  const timeouts = []
  let timeoutSeq = 1

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    AbortController,
    setTimeout(fn, ms) {
      const id = timeoutSeq++
      timeouts.push({ id, fn, ms: Number(ms) || 0 })
      return id
    },
    clearTimeout(id) {
      const i = timeouts.findIndex((t) => t.id === id)
      if (i >= 0) timeouts.splice(i, 1)
    },
    setInterval(fn) { return fn },
    clearInterval(fn) {},
    requestAnimationFrame() { return 0 },
    cancelAnimationFrame() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    navigator: { languages: ['zh-CN'], language: 'zh-CN' },
    fetch: (url, opts = {}) =>
      new Promise((resolve, reject) => {
        const u = String(url)
        fetchLog.push({ url: u, signal: opts.signal })
        if (!options.noAbort && opts.signal) {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (opts.signal.aborted) return onAbort()
          opts.signal.addEventListener('abort', onAbort, { once: true })
        }
        if (u.includes('/mimo-voice/report')) {
          reportDeferred.push({ resolve, reject, url: u })
          return
        }
        resolve({ ok: true, json: async () => ({ ok: true, volume: 1, avatarVersion: 0 }) })
      }),
  }
  sandbox.Audio = class {
    constructor(src) {
      this.src = src || ''
      this.volume = 1
    }
    play() {
      audioPlays.push(this)
      return Promise.resolve()
    }
    pause() {}
    removeAttribute() {}
  }
  sandbox.window = sandbox
  sandbox.window.__ModuleLoader__ = { load(def) { sandbox.__def = def } }
  vm.createContext(sandbox)
  vm.runInContext(clientSrc, sandbox, { filename: 'client.js' })

  const H = { cursor: 0, states: [], effects: [], renderQueued: false }
  const React = {
    Fragment: '__mv_frag__',
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const i = H.cursor++
      if (!(i in H.states)) H.states[i] = typeof initial === 'function' ? initial() : initial
      const setValue = (v) => {
        H.states[i] = typeof v === 'function' ? v(H.states[i]) : v
        scheduleRender()
      }
      return [H.states[i], setValue]
    },
    useRef(initial) {
      const i = H.cursor++
      if (!(i in H.states)) H.states[i] = { current: initial }
      return H.states[i]
    },
    useEffect(fn, deps) {
      const i = H.cursor++
      const prev = H.effects[i]
      const changed =
        !prev || !deps || !prev.deps || deps.length !== prev.deps.length ||
        deps.some((d, k) => d !== prev.deps[k])
      H.effects[i] = { deps: deps || null, cleanup: prev ? prev.cleanup : null, run: changed ? fn : null }
    },
  }

  const props = {
    sessionId: options.sessionId || 's1',
    useSession(selector) { return selector({ running: running.value }) },
  }
  const slots = {}
  const slotsApi = { register(config, comp) { slots[config.name] = comp } }
  const clientModule = sandbox.__def.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  clientModule.apply({ get: (n) => (n === 'slots' ? slotsApi : null) })
  const Button = slots['conversation.input.right']
  assert.ok(typeof Button === 'function', '应注册小喇叭按钮组件')

  let tree = null
  let unmounted = false
  function render() {
    H.renderQueued = false
    if (unmounted) return
    H.cursor = 0
    tree = Button(props)
    for (const e of H.effects) {
      if (!e || !e.run) continue
      if (typeof e.cleanup === 'function') { try { e.cleanup() } catch {} }
      const ret = e.run()
      e.cleanup = typeof ret === 'function' ? ret : null
      e.run = null
    }
  }
  function scheduleRender() {
    if (H.renderQueued) return
    H.renderQueued = true
    Promise.resolve().then(render)
  }

  const harness = {
    reportDeferred,
    audioPlays,
    resolveReport(index, payload) {
      const d = reportDeferred[index]
      if (d) d.resolve({ ok: true, json: async () => payload })
    },
    setProps(patch) {
      if ('running' in patch) running.value = patch.running
      if ('sessionId' in patch) props.sessionId = patch.sessionId
      scheduleRender()
    },
    async flush() {
      scheduleRender()
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
    },
    runTimeouts(maxMs) {
      const due = timeouts.filter((x) => x.ms <= maxMs)
      for (const t of due) {
        try { t.fn() } catch {}
      }
      for (const t of due) {
        const i = timeouts.indexOf(t)
        if (i >= 0) timeouts.splice(i, 1)
      }
    },
    unmount() {
      unmounted = true
      for (const e of H.effects) {
        if (e && typeof e.cleanup === 'function') { try { e.cleanup() } catch {} }
      }
    },
    findSpeakerButton() {
      const walk = (node) => {
        if (!node || typeof node !== 'object') return null
        if (node.type === 'button' && node.props && 'data-mimo-voice' in node.props) return node
        for (const child of [].concat(node.children || [])) {
          const hit = walk(child)
          if (hit) return hit
        }
        return null
      }
      return walk(tree)
    },
    status() {
      const btn = harness.findSpeakerButton()
      return btn ? btn.props['data-mimo-voice'] : '(none)'
    },
    reportFetches() { return fetchLog.filter((c) => c.url.includes('/mimo-voice/report')) },
  }
  render()
  return harness
}

await test('行为：旧请求晚到不播放，只有最新请求出声', async () => {
  const c = mountClientButton({ noAbort: true })
  await c.flush()
  c.setProps({ running: false })
  await c.flush()
  c.runTimeouts(500)
  await c.flush()
  assert.equal(c.reportFetches().length, 1, '第一轮结束应发起一次 /report')

  c.setProps({ running: true })
  await c.flush()
  c.setProps({ running: false })
  await c.flush()
  c.runTimeouts(500)
  await c.flush()
  assert.equal(c.reportFetches().length, 2, '第二次轮次结束应再发起 /report')

  c.resolveReport(0, { ok: true, text: '旧响应', displayText: '旧响应', audio: 'AAAA', turn: 1, endedAt: 1 })
  await c.flush()
  assert.equal(c.audioPlays.length, 0, '晚到的旧响应绝不能播放')

  c.resolveReport(1, { ok: true, text: '最新响应', displayText: '最新响应', audio: 'BBBB', turn: 2, endedAt: 2 })
  await c.flush()
  assert.equal(c.audioPlays.length, 1, '只有最新请求能播放')
  assert.ok(String(c.audioPlays[0].src).includes('BBBB'), '播的必须是最新音频')
  c.unmount()
})

await test('行为：关闭语音立即中止在途请求与播放', async () => {
  const c = mountClientButton()
  await c.flush()
  c.setProps({ running: false })
  await c.flush()
  c.runTimeouts(500)
  await c.flush()
  assert.equal(c.reportFetches().length, 1)
  assert.equal(c.status(), 'loading', '请求中按钮应为 loading 态')

  const btn = c.findSpeakerButton()
  btn.props.onClick()
  await c.flush()
  assert.equal(c.reportFetches()[0].signal.aborted, true, '关闭语音应 abort 在途请求')
  assert.equal(c.audioPlays.length, 0, '不应有任何播放')
  assert.equal(c.status(), 'idle', '关闭后应回到 idle')
  c.unmount()
})

await test('行为：切换会话让上一会话的在途请求作废', async () => {
  const c = mountClientButton()
  await c.flush()
  c.setProps({ running: false })
  await c.flush()
  c.runTimeouts(500)
  await c.flush()
  assert.equal(c.reportFetches().length, 1)

  c.setProps({ sessionId: 's2' })
  await c.flush()
  assert.equal(c.reportFetches()[0].signal.aborted, true, '切会话应 abort 旧会话请求')
  assert.equal(c.audioPlays.length, 0)
  c.unmount()
})

await test('行为：组件卸载后晚到的响应静默丢弃', async () => {
  const c = mountClientButton({ noAbort: true })
  await c.flush()
  c.setProps({ running: false })
  await c.flush()
  c.runTimeouts(500)
  await c.flush()
  assert.equal(c.reportFetches().length, 1)

  c.unmount()
  c.resolveReport(0, { ok: true, text: '晚到', displayText: '晚到', audio: 'CCCC', turn: 1, endedAt: 1 })
  await c.flush()
  assert.equal(c.audioPlays.length, 0, '卸载后的响应不能触发播放')
  c.unmount()
})

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)

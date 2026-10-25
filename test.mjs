/**
 * 纯函数自测（不碰网络、不需要 DSH 运行）：node test.mjs
 * 覆盖：文本清理、摘要截断、结束语库、错误分类（含原始状态码）、Key 掩码、熔断状态机。
 */
import assert from 'node:assert/strict'
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
  // 方言人设也能被用户覆盖
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
  // 只改语种、没给倍率 → 应当清掉自定义，让新语种用默认值
  assert.equal(shouldResetRateOnLanguageChange('zh', 'ja', false), true, '中文→日语应重置')
  assert.equal(shouldResetRateOnLanguageChange('ja', 'ko', false), true, '日语→韩语应重置')
  // 显式给了倍率 → 尊重用户，不重置
  assert.equal(shouldResetRateOnLanguageChange('zh', 'ja', true), false, '显式设倍率时不重置')
  // 语种没变 → 不动
  assert.equal(shouldResetRateOnLanguageChange('ja', 'ja', false), false, '语种未变不重置')
  // 大小写/非法值按归一化处理
  assert.equal(shouldResetRateOnLanguageChange('ZH', 'ja', false), true, '大小写应归一化')
  assert.equal(shouldResetRateOnLanguageChange('zh', 'fr', false), false, '非法语种归一为 zh，等于没变')
})

await test('isSourceLanguageLeak 能识别"中文当译文"的偷懒输出', () => {
  // 英文里出现汉字 = 没翻译
  assert.equal(isSourceLanguageLeak('任务完成了。', 'en'), true, '英文却返回中文应判失败')
  assert.equal(isSourceLanguageLeak('Task completed.', 'en'), false)
  // 韩文同理
  assert.equal(isSourceLanguageLeak('任务完成了。', 'ko'), true)
  assert.equal(isSourceLanguageLeak('작업 완료했어요.', 'ko'), false)
  // 日语本身用汉字：只看有没有假名
  assert.equal(isSourceLanguageLeak('タスク完了です。', 'ja'), false, '日文含汉字但正常')
  assert.equal(isSourceLanguageLeak('任务完成了。', 'ja'), true, '纯中文且无假名判失败')
  // 中文语种不判定
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

await test('方言试听文件存在', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const code of ['yue', 'sc', 'ne', 'ha', 'sd', 'tw']) {
    const f = join(here, `preview-dialect-${code}.mp3`)
    assert.ok(existsSync(f), `缺方言试听: preview-dialect-${code}.mp3`)
    assert.ok(statSync(f).size > 10000, `方言试听太小: ${code}`)
  }
})

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)

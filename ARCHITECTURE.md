# MiMo 语音汇报 · 内部架构

本文记录 `index.js`（宿主半）与 `client.js`（浏览器半）的内部结构与职责边界，
供后续维护者定位代码、判断改动范围。**当前刻意保持单文件**——见文末「为什么还没拆分」。

## 宿主半 `index.js`（约 2100 行）

自上而下的职责分节（行号随版本变化，按注释标题定位）：

| 区块 | 职责 | 关键导出 |
|---|---|---|
| 音色预设与人设 | `PRESET_LABELS`、`PERSONA_PROMPTS`、`voicePersonaId`、`personaPromptFor`、`buildSummaryPrompt` | `voicePersonaId` `personaPromptFor` `buildSummaryPrompt` |
| 语言 / 方言 / 语速 | `LANGUAGES`、`DIALECTS`、`SPEECH_RATE_FACTORS`、白名单收敛 | `normalizeLanguage` `normalizeDialect` `speechRateFactor` `speechRateStyle` |
| 配置默认值 | `DEFAULTS`（含 `reportBudgetMs`、`ffmpegTimeoutMs`） | — |
| 会话折叠 | `session/event` 监听，把轮次收成轻量记录 | `apply` |
| HTTP 路由 | `/mimo-voice/*` 全部端点的请求分发 | `handleRequest` `inject` |
| 报告编排 | `produceReport`：预算、取消、双语收敛、熔断、缓存代次 | `reportConfigFingerprint` |
| 报告文案 | 结束语库、抽取式摘要、模型改写、双语生成、翻译 | `composeReport` `buildReportText` `generateBilingualReport` `summarize` `cleanText` `dedupeAnnounce` |
| 模型层 | MiMo 调用、错误分类、熔断器、取消信号联动 | `classifyMimoError` `createMimoBreaker` `summarizeWithModel` `translateReportDetailed` `isSourceLanguageLeak` |
| 音频层 | TTS 合成、ffmpeg atempo 变速、采样/立绘/兜底音读取 | `synthesize` `applySpeechRate` `probeFfmpeg` `estimateSeconds` `voiceSampleInfo` `avatarInfo` |
| Key / 凭据 | 解析顺序 config → env → credentials | `resolveApiKey` `describeKeySource` `maskKey` |
| 工具 | 音量收敛、JSON 读写、响应序列化 | `clampVolume` |

### 核心数据流

```
turn/end
  → apply() 折叠 sessions
  → POST /report → handleRequest
      → 生成任务（带代次 generation + 取消 controller）
      → produceReport：预算 stageOpts() → 双语/两步文案 → synthesize
      → 缓存（key = turnKey + reportConfigFingerprint(cfg)）
  → base64 mp3 → client.js 播放
```

### 关键不变量（改动时勿破坏）

- **缓存代次**：`latestReportGeneration` 保证 force 任务的旧结果不覆盖新缓存。
- **总预算**：各阶段超时被剩余 `reportBudgetMs` 封顶，保证浏览器 100s 放弃前宿主已收尾。
- **断连取消**：所有 `/report` 等待者断开才 abort；取消不计熔断、不写缓存。
- **双语失败收敛**：auth/no-key/quota 等致命根因不串行重打摘要/翻译。

## 浏览器半 `client.js`（约 1700 行）

`window.__ModuleLoader__.load` 的 factory，注册三个 slot：

| 组件 | slot | 职责 |
|---|---|---|
| `VoiceReportButton` | `conversation.input.right` | 小喇叭 + 齿轮；判断轮次结束、请求、播放 |
| `VoiceAvatarCard` | `shell.overlay` | 立绘 + 逐字气泡浮层 |
| `KeySettings` | `plugins.bundle.config` | 设置卡（音色/人设/音量/语种/语速/称呼/结束语/Key） |

模块级共享状态：`view`（浮层视图）、`spoken`（已播记录，上限 64）、`volumeState`、`navState`。

### 关键不变量

- **请求代次** `requestSeq` + **播放代次** `playbackSeq`：只有最新请求/播放能更新 UI。
- **失效路径** `invalidateRequests()`：关闭语音、切会话、卸载都中止在途请求与播放。
- **立绘自愈**：浮层每次弹出重置 `avatarOk`，热重载的瞬时 404 不永久关掉立绘。

## 测试 `test.mjs`（55 项）

三层覆盖：
1. **纯函数**：文本清理、摘要、结束语、错误分类、Key 掩码、熔断、语种/方言/语速白名单。
2. **`/report` 集成**：缓存指纹、force 并发替换、双语失败收敛、预算封顶、断连取消、ffmpeg 防护（mock fetch + mock req/res）。
3. **客户端行为**：vm 沙箱 + fake React/Audio/fetch，真实运行组件验证乱序/关闭/切会话/卸载。

外加客户端结构正则断言（防重构丢关键逻辑）与发布一致性检查（`.work/check-publish.mjs`）。

## 为什么还没拆分

`index.js` 内部函数高度内聚、相互交织：`handleRequest` 调用几乎所有辅助函数，
`produceReport` 串起文案 + 模型 + 音频 + 诊断。机械地切成多个模块需要
整团依赖一起搬运或反向注入大量参数——这是"搬运代码"而非"改进逻辑"，且会
在 55 项测试之外引入新的回归面，收益不抵风险。

**未来拆分的安全边界**（当文件继续增长、或需要独立测试某层时）：
1. 先拆 **模型层** `mimo.mjs`（`classifyMimoError`/`createMimoBreaker`/`summarizeWithModel`/`translateReportDetailed`/`isSourceLanguageLeak`/`sanitizeSpoken`/`dedupeAnnounce`）——依赖最少、最自洽。
2. 再拆 **音频层** `audio.mjs`（`synthesize`/`applySpeechRate`/`probeFfmpeg`/`estimateSeconds`/采样与立绘读取）。
3. 最后拆 **路由层** `routes.mjs`（`handleRequest` + `readJson`/`json`/`sayAllowed`）。
4. 每步保持 `index.js` 作为门面 re-export 全部现有符号，`test.mjs` 导入面零改动；每步跑一次全量测试再继续。

拆分的触发条件应是：文件超过 ~3000 行、或某层需要独立的集成测试、或多人并行开发冲突频发——而非"文件太大了"这一条。

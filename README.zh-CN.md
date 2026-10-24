# MiMo 语音汇报（mimo-voice-report）

[English](./README.md) · **中文**

一个给 [DeepSeek Harness](https://deepseek.com) 用的插件：**任务完成时，用小米 MiMo 声音模型播报一句完成提示 + 一两句结果总结**，同时弹出立绘和对话气泡，气泡里的文字跟着音频进度逐字出现。

`dsh-plugin` · `deepseek-harness` · `cordis-plugin` · `mimo` · `tts` · `voice-clone`

---

## 它能做什么

- **完成即播报**：一轮任务结束（`turn/end`）时自动说话，提示 + 总结一共两三句，不啰嗦
- **三种结束语**：完成是「任务完成啦。」，出错是「呜，任务出错了。」，中止是「任务先停在这里啦。」
- **结果总结**：默认让 MiMo 对话模型（`mimo-v2.6-flash`）把最后一轮助手回复改写成一句到两句能念的话；
  模型超时、被拒、输出不合格时自动退回规则摘要（去 Markdown、取前一两句），不会因为改写失败而没声音
- **不重复开场**：模型偶尔把「任务完成啦」再说一遍，插件会剥掉开头的完成提示（`dedupeAnnounce()`），
  剥空了就退回规则摘要
- **立绘 + 气泡**：播报时右下角弹出立绘和对话气泡，文字按 `currentTime / duration` 逐字显现，末尾有光标
- **随时开关**：输入框右侧的小喇叭，开/关状态存 `localStorage`
- **被拦截能补播**：浏览器拦截自动播放时按钮变橙提示，点一下或之后任意点击/按键自动补播
- **只在需要时花钱**：只对当前打开的会话合成一次，同一轮音频缓存；切走再回来不重复调用
- **Key 不出宿主**：API Key 只在宿主进程读取，浏览器只拿到 mp3 的 base64

## 怎么工作

```
一轮任务结束（session 日志新增 turn/end）
   │
   ▼
宿主半 index.js                             浏览器半 client.js
· 旁听 session/event，折叠出「这一轮最后一条    · 输入框工具行右侧的小喇叭
  助手回复 + 结束原因（completed/error/…）」    · useSession(s => s.running) 由 true 变 false
· POST /mimo-voice/report 时：                → POST /mimo-voice/report
  1. MiMo 对话模型改写口播稿（1~2 句）        · 收到 base64 mp3 → <audio> 播放
  2. MiMo TTS 合成 mp3                       · 同时浮层弹出立绘 + 气泡，
  3. base64 返回，按 turn 缓存                  文字按播放进度逐字显现
                                             · 播放 / 被拦截 / 失败都上报 /_client
```

逐字显现用 `requestAnimationFrame` 驱动：每帧读 `currentTime / duration`（加 0.12 秒提前量，避免字幕慢半拍），
乘字符数得到该显示几个字，**只有字变了才重新渲染**；`duration` 还没就绪时退回「每秒 4.5 字」估算。

## 安装

```bash
git clone https://github.com/387617119/mimo-voice-report.git
```

然后在 DSH 里把这个目录当 bundle 装进当前 profile：

```
plugin_manager  action: install_bundle  target: <仓库绝对路径>
```

装好后重载一次页面（Ctrl+R），输入框右侧会出现小喇叭。

## 音色选项：原版 / 俏皮版

仓库自带**两条合成采样**（都是 voice clone 生成的，不含原始录音），在「设置 → 插件 → MiMo 语音汇报 → 音色」里直接切换，
或者改 `cordis.patch.yml` 的 `voiceSample`：

| 选项 | 文件 | 特点 |
| --- | --- | --- |
| **原版** | `voice-sample.mp3` | 中性演示版（默认） |
| **俏皮版** | `voice-sample-playful.mp3` | 同一音色的俏皮演绎 |

下拉框会写回 `config.voiceSample`，切换立即生效。你丢进插件目录的任何 `*.mp3` / `*.wav` 也会出现在下拉框里
（宿主只接受插件目录中真实存在的文件，不会随便写路径）。

两条采样念的都是同一句测试台词：**「test，test，这里是音频测试，1，2，3，4，5，上山打老虎」**。

想换音色，三种办法：

| 想要的效果 | 怎么做 |
| --- | --- |
| 换成自己的声音 | 用 5–15 秒单人干声覆盖 `voice-sample.mp3`（或新增一个文件，自动出现在下拉框） |
| 换成 MiMo 预置音色 | `model: 'mimo-v2.5-tts'` + `voice: '冰糖'`/`茉莉`/`苏打`/`白桦`/`Mia`/`Chloe`/`Milo`/`Dean` |
| 只改语气不改音色 | 在 `style` 里写「怎么说话」（不会念出来），或用 `tags` 标签 |

默认配置：

```yaml
model: 'mimo-v2.5-tts-voiceclone'
voiceSample: 'voice-sample.mp3'
style: ''
tags: '(俏皮 稚嫩)'
```

立绘没有随仓库发布（`avatar.webp` 缺失时浮层只显示气泡，不会报错）。想显示头像：
把 `avatar.png` / `avatar.webp` 放到插件目录，`avatar: 'avatar.webp'` 即可。

## 配置项

全部在 `cordis.patch.yml` 里本插件那一行，**大部分也能在「设置 → 插件 → MiMo 语音汇报」里改**。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://token-plan-cn.xiaomimimo.com/v1` | OpenAI 兼容端点。Token Plan Key（`tp-*`）走 `token-plan-cn`；按量付费 Key 用 `https://api.xiaomimimo.com/v1` |
| `apiKey` | 空 | MiMo API Key。空则回落到 `MIMO_API_KEY` 环境变量，再回落到 `~/.dsh/.credentials.yaml` 的 refs |
| `model` | `mimo-v2.5-tts-voiceclone` | `mimo-v2.5-tts`（预置音色）/ `-voiceclone`（复刻采样）/ `-voicedesign`（文本设计音色，每次调用音色会漂） |
| `voice` | `冰糖` | 只在预置音色模式生效 |
| `voiceSample` | `voice-sample.mp3` | 复刻采样，相对插件目录或绝对路径；mp3/wav、单声道、5–15 秒干净人声最好 |
| `avatar` | `avatar.webp` | 浮层立绘（png/webp/jpeg/gif）；缺失或留空 = 只显示气泡 |
| `style` | 空 | 语气指令，走 `role: user`，不会念出来；留空 = 完全照采样说（最像） |
| `tags` | `(俏皮 稚嫩)` | 音频风格标签，贴正文开头（俏皮 + 少女感的可爱）；留空关闭，标签会盖掉一部分原始音色 |
| `summarizer` | `model` | `model` = MiMo 对话模型改写；`extract` = 纯规则抽取（少一次调用，更快） |
| `summaryModel` | `mimo-v2.6-flash` | 负责改写的对话模型 |
| `summaryMaxChars` | `64` | 口播稿长度上限 |
| `maxChars` | `90` | 退回规则摘要时的长度上限 |
| `staleMs` | `25000` | 一轮结束超过这么久就不再补播（避免打开旧会话突然出声） |
| `timeoutMs` | `30000` | 单次 MiMo 请求超时 |

### API Key 的三种配法

1. **界面里配**（推荐）：设置 → 插件 → *MiMo 语音汇报* → 粘贴 → 保存。
   会写回 profile 的 `cordis.patch.yml` 里本插件那一行（`config.apiKey`）并立即生效；
   点「清除」就删掉覆盖、回落到下面的来源。卡片上显示当前来源和掩码（前 3 位 + 后 4 位）。
2. **环境变量**：`MIMO_API_KEY`。
3. **凭据库**：`~/.dsh/.credentials.yaml` 的 `refs`，键名 `MIMO_API_KEY` 或 `MIMO_TTS_API_KEY`。

解析顺序：`config.apiKey` → 环境变量 → 凭据库。完整 Key 永远不出宿主进程，
`GET /mimo-voice/config` 只返回掩码。

## 音色复刻的坑（踩过才知道）

- `audio.voice` 必须是 **DataURL**（`data:audio/mpeg;base64,...`），裸 base64 会返回 400
  `audio.voice must be a DataURL for voice clone model`
- 采样不是越长越好：我们试过 5 秒、7 秒、9 秒、18 秒、21 秒，5 秒能和源声的中位音高完全对上，
  21 秒反而偏低；**用你的耳朵定**，别只看指标
- `seed` 会被接受但不起作用，`temperature: 0` 也不能让输出可复现：同一句话多次调用，
  中位音高可能相差好几个半音、时长 4–15 秒都可能。要「每次都一样」就回到预置音色
- 采样带 BGM 时，先用人声分离再复刻：
  ```bash
  python -m demucs --two-stems=vocals out.mp3   # 取 separated/htdemucs/out/vocals.wav
  ffmpeg -i vocals.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 -ac 1 -ar 44100 -b:a 128k voice-sample.mp3
  ```
- 加语气指令（`style`）会让音高整体偏移几 Hz，追求「像」就留空

## 调试端点

```bash
curl -s http://127.0.0.1:<端口>/mimo-voice/state      # 宿主快照：版本、采样、立绘、计数
curl -s http://127.0.0.1:<端口>/mimo-voice/config     # 当前生效的 Key 来源（掩码）
curl -s http://127.0.0.1:<端口>/mimo-voice/_client    # 浏览器半最近一次上报
curl -s -X POST http://127.0.0.1:<端口>/mimo-voice/say \
  -H 'content-type: application/json' \
  --data '{"text":"任务完成啦。这是一次试听。"}'        # 任意文本试听，返回 base64 mp3
```

## 隐私与安全

- API Key 只在宿主进程使用，不下发浏览器、不写日志
- 路由挂在本地 DSH Web 服务上，只从同源可达，不要把端口暴露到外网
- 不存会话内容：内存里每个会话只保留「最后一条助手文本 + 结束原因 + 时间」，最多 60 个会话
- `voice-sample.mp3` 是**合成音频**：用 voice clone 把测试台词在演示音色上念出来，仓库不含原始录音；想换成自己的声音，替换这个文件即可
- 想自己再生成一条示例音，用同一个玩法（换成你自己的参考音）：
  ```json
  {
    "model": "mimo-v2.5-tts-voiceclone",
    "messages": [{ "role": "assistant", "content": "test，test，这里是音频测试，1，2，3，4，5，上山打老虎" }],
    "audio": { "format": "mp3", "voice": "data:audio/mpeg;base64,<你的参考音>" }
  }
  ```
  拿到返回的 base64 存成 mp3，再 `loudnorm=I=-16` 归一（单声道 44.1k）就是一条新采样
- 声音复刻请自行确认授权范围，只克隆你有权使用的声音
- `.gitignore` 默认忽略 `avatar.*`、`*.wav`、密钥类文件，避免误传本地素材

## 已知限制

| 现象 | 原因 / 处理 |
| --- | --- |
| 没声音 | 浏览器自动播放策略；点一下小喇叭或页面任意处补播，按钮会变橙提示 |
| 改了代码/配置没生效 | 客户端模块需要重载页面（Ctrl+R） |
| 切到别的会话不播 | 设计如此：只在当前打开的会话结束时播报 |
| 同一句话每次听感略有不同 | 克隆模型的随机性（见上文），不是插件缓存问题 |
| 播报有 3–8 秒延迟 | 先改写再合成；期间气泡显示「正在准备语音汇报…」 |

## 目录结构

```
.
├── index.js            # 宿主半：会话事件折叠、HTTP 路由、MiMo TTS 调用
├── client.js           # 浏览器半：小喇叭、浮层立绘、逐字气泡、配置卡
├── cordis.patch.yml    # bundle 的 Loader patch（默认配置）
├── voice-sample.mp3    # 内置参考音（18 秒）
├── avatar.webp         # 可选，未随仓库发布
├── locale/{en,zh}.json # 插件管理页的标题与描述
├── icon.svg            # 插件图标
├── README.md           # English
└── README.zh-CN.md     # 本文件
```

## 许可证

MIT，见 [LICENSE](./LICENSE)。

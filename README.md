# MiMo Voice Report

**English** · [中文](./README.zh-CN.md)

A [DeepSeek Harness](https://deepseek.com) plugin that **speaks a short completion notice and a two-sentence summary** every time a task finishes — and pops up a portrait with a speech bubble whose text types itself out in step with the audio.

Powered by Xiaomi **MiMo TTS**. Ships with a 7.7-second reference clip, so the default setup already speaks in a cloned voice (`mimo-v2.5-tts-voiceclone`); switch one line to use a preset voice instead.

`dsh-plugin` · `deepseek-harness` · `cordis-plugin` · `mimo` · `tts` · `voice-clone`

---

## What it does

```
turn ends (session log gets turn/end)
   │
   ▼
Host half (index.js)                        Client half (client.js)
· folds the last assistant text +           · speaker button in the composer toolbar
  end reason from session/event             · useSession(s => s.running) true → false
· on POST /mimo-voice/report:               → POST /mimo-voice/report
  1. asks MiMo chat to rewrite the          · plays the base64 mp3
     result into 1–2 spoken sentences       · pops the portrait + speech bubble,
  2. synthesizes it with MiMo TTS              text revealed by audio progress
  3. returns base64 mp3 (cached per turn)
```

- **Completion line**: `任务完成啦。` (error / aborted / blocked have their own lines).
- **Summary**: one MiMo chat call (`mimo-v2.6-flash` by default) rewrites the last assistant message into one or two speakable sentences; if that call fails or is rejected, a deterministic extractive summary is used instead.
- **No duplicate openings**: the model sometimes repeats "任务完成啦"; `dedupeAnnounce()` strips a leading completion phrase and falls back to the extractive path if nothing is left.
- **Pay only when needed**: synthesis happens only for the session you are looking at, and the audio is cached per turn.
- **Key never reaches the browser**: the API key is read in the host process; the page only receives mp3 bytes.

## Install

```bash
git clone https://github.com/387617119/mimo-voice-report.git
```

Then install the directory as a bundle in your DSH profile:

```
plugin_manager  action: install_bundle  target: /absolute/path/to/mimo-voice-report
```

(Any equivalent "install a local bundle directory" flow works — the package declares `dsh.bundle.patch`.)

## Configure

Everything lives in this package's `cordis.patch.yml` row, and most of it can be edited at runtime in **Settings → Plugins → MiMo Voice Report**.

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://token-plan-cn.xiaomimimo.com/v1` | OpenAI-compatible endpoint. Token-plan keys use `token-plan-cn`; pay-as-you-go keys use `https://api.xiaomimimo.com/v1` |
| `apiKey` | `''` | MiMo API key. Empty falls back to `MIMO_API_KEY`, then `~/.dsh/.credentials.yaml` refs |
| `model` | `mimo-v2.5-tts-voiceclone` | `mimo-v2.5-tts` (preset voice), `mimo-v2.5-tts-voiceclone` (clone a clip), `mimo-v2.5-tts-voicedesign` (text-designed voice; timbre drifts per call) |
| `voice` | `冰糖` | Preset voice: `冰糖`, `茉莉`, `苏打`, `白桦`, `Mia`, `Chloe`, `Milo`, `Dean` |
| `voiceSample` | `voice-sample.mp3` | Reference clip for clone mode, relative to the package or absolute; mp3/wav, mono, 5–15 s of clean speech |
| `avatar` | `avatar.webp` | Portrait for the popup (png/webp/jpeg/gif); missing/empty = bubble only |
| `style` | `''` | Optional delivery instruction sent as a `role: user` message (never spoken). Leave empty for the most faithful clone |
| `tags` | `(俏皮 稚嫩)` | Audio style tag prepended to the text (playful + girlish-cute). `''` disables it; tags can shift timbre |
| `callMe` | `''` | How the whale girl addresses you, appended to the opening line (任务完成啦，主人。). CJK/Latin letters, digits or `·`, up to 16 chars; empty = no address |
| `summarizer` | `model` | `model` = rewrite with MiMo chat; `extract` = rule-based, one less API call |
| `summaryModel` | `mimo-v2.6-flash` | Model used for the rewrite |
| `summaryMaxChars` | `64` | Max length of the spoken summary |
| `maxChars` | `90` | Max length when falling back to the extractive summary |
| `staleMs` | `25000` | Don't speak for a turn that ended longer ago than this |
| `timeoutMs` | `30000` | Per-request timeout |

### API key

Three ways, in resolution order:

1. **In the UI** — Settings → Plugins → *MiMo Voice Report* → paste the key → Save. It is written back to this plugin's row in your profile patch (`config.apiKey`) and takes effect immediately. **Clear** removes the override and falls back to the sources below.
2. `MIMO_API_KEY` environment variable.
3. `refs` in `~/.dsh/.credentials.yaml` — `MIMO_API_KEY`, then `MIMO_TTS_API_KEY`.

The settings card shows the active source plus a masked hint (first 3 + last 4 characters). `GET /mimo-voice/config` never returns the full key.

## Voice presets

The repo ships **two synthetic reference clips**, both MiMo voice-clone renders (no original recording is bundled).
Switch between them in **Settings → Plugins → MiMo Voice Report → 音色**, or edit `voiceSample` in `cordis.patch.yml`:

| Preset | File | Character |
| --- | --- | --- |
| 原版 (original) | `voice-sample.mp3` | Neutral demo take of the test line |
| 俏皮版 (playful) | `voice-sample-playful.mp3` | Playful take of the same timbre |

The selector writes back `config.voiceSample` and takes effect immediately. Any `*.mp3` / `*.wav` you drop next to
`index.js` shows up in the same dropdown — the host only accepts files that actually exist in the package directory.

Both clips are **synthetic**: MiMo voice-clone rendered a test line
**「test, test, 这里是音频测试, 1, 2, 3, 4, 5, 上山打老虎」** in the author's chosen timbre. To use your own voice:

| Goal | How |
| --- | --- |
| Use your own voice | Overwrite `voice-sample.mp3` (or add a new file) with 5–15 s of single-speaker dry speech |
| Use a MiMo preset voice | `model: 'mimo-v2.5-tts'` + `voice: '冰糖'` (or `茉莉`, `苏打`, `白桦`, `Mia`, `Chloe`, `Milo`, `Dean`) |
| Only change the delivery | Put an instruction in `style` (sent as `role: user`, never spoken), or a tag in `tags` |

Normalize a new clip with:

```bash
ffmpeg -i raw.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11 -ac 1 -ar 44100 -b:a 128k voice-sample.mp3
```

The portrait is **not** bundled (`avatar.webp` missing → the popup shows the bubble only).
Drop your own `avatar.png`/`avatar.webp` next to `index.js` to get the character card.

Notes from building this:

- The clone model wants `audio.voice` as a **DataURL** (`data:audio/mpeg;base64,...`) — a bare base64 string is rejected with HTTP 400.
- Longer clips (15–20 s) are not automatically more faithful; measure your own result. A 5 s clip can give an exact pitch match while a longer one drifts.
- `seed` is accepted but ignored, and `temperature: 0` does not make takes reproducible: the same text can land a few semitones apart between calls. If consistency matters more than likeness, use a preset voice.
- If your reference has background music, isolate the vocal first, e.g. `python -m demucs --two-stems=vocals out.mp3` and use `vocals.wav`.
- The bundled clip is a **voice-clone render of a test line**, not a recording. Reproduce it with any reference clip you own:

  ```json
  {
    "model": "mimo-v2.5-tts-voiceclone",
    "messages": [{ "role": "assistant", "content": "test，test，这里是音频测试，1，2，3，4，5，上山打老虎" }],
    "audio": { "format": "mp3", "voice": "data:audio/mpeg;base64,<your reference clip>" }
  }
  ```

  Then normalize the returned audio (`loudnorm=I=-16`, mono, 44.1 kHz) and save it as `voice-sample.mp3`.
- Voice cloning carries its own responsibility: only clone voices you have the right to use.

## Endpoints (for debugging)

```bash
curl -s http://127.0.0.1:<port>/mimo-voice/state        # host snapshot: version, sample, avatar, counters
curl -s http://127.0.0.1:<port>/mimo-voice/config       # which key is in effect (masked)
curl -s http://127.0.0.1:<port>/mimo-voice/_client      # last browser-half report
curl -s -X POST http://127.0.0.1:<port>/mimo-voice/say \
  -H 'content-type: application/json' \
  --data '{"text":"任务完成啦。这是一次试听。"}'          # returns base64 mp3
```

## Privacy & security

- The API key lives only in the host process; it is never sent to the page or written into logs.
- All routes are served by the local DSH web server and are only reachable from that origin — do not expose the port to a network.
- The plugin stores no conversation content beyond one in-memory record per session (last assistant text, end reason, timestamp), capped at 60 sessions.

## License

MIT — see [LICENSE](./LICENSE).

Voice cloning is powerful and easy to misuse: only clone voices you have the right to use, and say so when you publish the result.

---

## 中文说明

一个 [DeepSeek Harness](https://deepseek.com) 插件：**任务完成时用小米 MiMo TTS 播报一句完成提示 + 一两句结果总结**，同时弹出立绘和对话气泡，气泡里的文字跟着音频进度逐字出现。

- 音色二选一：MiMo 预置音色开箱即用（`冰糖` 等 8 个），或自带 5–15 秒干声做 **voice clone**
- 口播稿由 MiMo 对话模型改写成"一句提示 + 两句总结"，失败时退回规则摘要
- 输入框右侧小喇叭可随时开关；被浏览器拦截自动播放时点一下补播
- MiMo API Key 三种配法：插件配置页粘贴（会写回 profile 的 patch）、`MIMO_API_KEY` 环境变量、`~/.dsh/.credentials.yaml` 的 refs；Key 只在宿主进程使用

安装：把本仓库克隆成目录后，用 `plugin_manager` 的 `install_bundle` 指向该目录即可。

> 声音复刻请自行确认授权范围；发布克隆结果时也请说明来源。

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
- **Persona-aware summaries** (v1.20.0): every voice ships a persona prompt that steers the summary model's tone — the tsundere reports "hmph, it's not like I did it for you", the cool pharmacist keeps it clipped and precise, the ojou-sama stays refined. 16 built-in prompts; override or add your own per voice (including custom samples) in the settings card's **人设提示词** editor (`config.personaPrompts[id]`, max 200 chars — describe *who* and *how they speak*; structural rules are appended by the plugin). The emergency extractive fallback bypasses personas.
- **No duplicate openings**: the model sometimes repeats "任务完成啦"; `dedupeAnnounce()` strips a leading completion phrase and falls back to the extractive path if nothing is left.
- **Pay only when needed**: synthesis happens only for the session you are looking at; audio is **cached per turn** (a cache hit skips even the summary call), and concurrent requests for the same turn (two tabs, rapid clicks, a force retry) are merged into a single generation.
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
| `customAnnounces` | `{}` | Your own lines per bucket — `{completed, error, aborted}` (one per line, max 20 × 40 chars each) — shuffled into the matching built-in pool; "interrupted" shares the aborted bucket. Write the address into a line itself if you want it |
| `customOnly` | `false` | `true` = a bucket with custom lines uses only yours, none of its built-ins |
| `volume` | `1` | Playback volume 0–1 (0–100%). The settings-card slider applies live while dragging; **Save** writes back here. The browser half applies it to `audio.volume` |
| `personaPrompts` | `{}` | Per-voice persona prompts (`voiceId: sentence`) steering the summary model's tone; empty uses built-in defaults; the settings-card editor writes back here |
| `language` | `zh` | Report language (`zh`/`en`/`ja`/`ko`). Other languages **switch the spoken audio to that language** (the whole Chinese report is MiMo-translated, persona tone kept); the bubble subtitle follows the spoken text and **appends the Chinese original as a translation** once the audio finishes. Falls back to Chinese for that turn if translation fails. **Dialect voices only show up under `zh`** — switching to another language hides them and falls back to the original voice if one was selected |
| `speechRateFactor` | `''` | Speech-rate multiplier (0.5–2). Empty uses per-language defaults: zh 1.00 / en 1.08 / ja 1.12 / ko 1.10. **Switching language automatically drops any custom factor** and applies the new language's default (set it again to pin it). Applied **after synthesis with ffmpeg atempo** (pitch preserved) — prompt/tag-based rate control proved unreliable on MiMo (same Japanese line ranged 9.02–11.74 s) |
| `personaPrompts` | `{}` | Per-voice persona prompts; the six **dialects ship their own** (`dialect-yue`/`-sc`/`-ne`/`-ha`/`-sd`/`-tw`): Cantonese pragmatic warmth, Sichuan hot temper straight talk, Northeastern open-hearted bluster, Henan plain-spoken honesty, Shandong generous down-to-earth reliability, Taiwan soft cutesy — all overridable |
| `fallbackDing` | `fallback-ding.wav` | Bundled chime played when MiMo is unavailable (path relative to the package); `''` disables the fallback |
| `cooldownMs` | `300000` | Cooldown after 3 consecutive MiMo failures — the API is skipped entirely; clicking the speaker (force) bypasses it |
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

The repo ships **sixteen synthetic reference clips** — all rendered by MiMo itself, no original recording is bundled.
Switch between them in **Settings → Plugins → MiMo Voice Report → 音色**, or edit `voiceSample` in `cordis.patch.yml`:

| Preset | File | Character |
| --- | --- | --- |
| 原版 (original) | `voice-sample.mp3` | Neutral demo take of the test line |
| 俏皮版 (playful) | `voice-sample-playful.mp3` | Playful take of the same timbre |
| 傲娇小猫 (tsundere) | `voice-sample-tsundere.mp3` | Bright teen voice, brisk, prickly-outside-caring-inside |
| 清冷药师 (kuudere) | `voice-sample-kuudere.mp3` | Cool mid-low voice, calm, clipped, deadpan wit |
| 元气应援 (genki) | `voice-sample-genki.mp3` | High, cheery, cheerleader energy, rising endings |
| 温柔姐姐 (onee-san) | `voice-sample-onee.mp3` | Soft breathy mid-low voice, unhurried, reassuring |
| 病娇低语 (yandere) | `voice-sample-yandere.mp3` | Sweet whisper, breathy, slow, clinging undertone |
| 无口人偶 (doll) | `voice-sample-doll.mp3` | Flat, quiet, minimal affect, doll-like recital |
| 软萌萝莉 (loli) | `voice-sample-loli.mp3` | Very high round childlike voice, milky articulation |
| 涩谷辣妹 (gyaru) | `voice-sample-gyaru.mp3` | Loud bright brash gal voice, teasing, drawn-out accents |
| 名门大小姐 (ojou-sama) | `voice-sample-ojou.mp3` | Refined elegant lady, precise diction, politely lofty |
| 天然呆 (airhead) | `voice-sample-tennen.mp3` | Soft warm voice, relaxed half-a-beat-off rhythm, innocent |
| 小恶魔 (little devil) | `voice-sample-koakuma.mp3` | Silky nimble voice, loves to tease, smug rising endings |
| 假小子 (tomboy) | `voice-sample-bokukko.mp3` | Mid-low crisp voice, boyish and loyal, no-nonsense |
| 阴角少女 (introvert) | `voice-sample-inkyo.mp3` | Light timid voice, small and hesitant yet articulate |
| 文学少女 (bookworm) | `voice-sample-bunge.mp3` | Quiet clear voice, read-aloud clarity, bookish calm |

The fourteen archetype voices are **fully synthetic**: `mimo-v2.5-tts-voicedesign` rendered each from a
textual acoustic description of a popular anime-girl voice archetype (tsundere / kuudere / genki / onee-san /
yandere / emotionless / loli / gyaru / ojou-sama / airhead / little devil / tomboy / introvert / bookworm).
No real person's or voice actress's recording is cloned, and the preset names are original aliases with no
reference to any specific character — the descriptions stay at the acoustic-archetype level on purpose.
Every sample is screened by objective F0 metrics (median pitch, spread, duration); the third batch onward
follows a uniform "natural tone, moderate pace" recipe.

The selector writes back `config.voiceSample` and takes effect immediately. The **试听 (preview)** button next to it
**plays the bundled fixed persona-line MP3 for the selected voice** (`preview-<id>.mp3`, generated by cloning the matching
sample with a persona-matched line — instant, local, zero MiMo usage). To hear custom text, type a line below and press
**生成试听** (or Enter) — that synthesizes on the fly via `/say` (rate-limited to 6/min).
Next to the speaker on the conversation page there is a **gear button** (shown when the host exposes
`pluginNavigation`, dsh 0.2.1+) that jumps straight to this plugin's settings page — voice, volume and key all live there.
The settings card also has a **volume slider** (0–100%): dragging applies live to the next playback;
**Save** persists it to `config.volume`.
Any `voice-sample-*.mp3` / `.wav` you drop next to `index.js` shows up in the same dropdown (fixed preview optional;
without one the button falls back to custom-line generation) — the host only accepts files that actually exist in the package directory.

The two base clips are **synthetic**: MiMo voice-clone rendered a test line
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

`<port>` is whatever port the DSH web GUI is on this session (it changes on every start).

```bash
curl -s http://127.0.0.1:<port>/mimo-voice/state        # host snapshot: version, sample, avatar, counters
                                                        #   + `events`: last 50 diagnostic events (failures,
                                                        #     breaker open/recovered, fallbacks, cache hits)
                                                        #   + `lastError` with the raw HTTP status & body snippet
curl -s http://127.0.0.1:<port>/mimo-voice/config       # which key is in effect (masked)
curl -s http://127.0.0.1:<port>/mimo-voice/_client      # last browser-half report
curl -s "http://127.0.0.1:<port>/mimo-voice/preview?voice=voice-sample-loli.mp3" -o loli.mp3 \
                                                        # fixed persona-line preview (mp3, zero MiMo usage)
curl -s -X POST http://127.0.0.1:<port>/mimo-voice/say \
  -H 'content-type: application/json' \
  --data '{"text":"任务完成啦。这是一次试听。"}'          # custom-line synthesis (base64 mp3; rate-limited: 6/min)
```

## Development

Pure-function unit tests, no network needed:

```bash
npm test        # = node test.mjs
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

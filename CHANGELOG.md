# Changelog

## v1.31.0 (2026-10-25)

### Optimizations
- **Merged bilingual generation**: non-Chinese completed turns now use a single model call to produce both the target-language spoken text and the Chinese companion line, halving latency (was: summarize + translate = 2 calls)
- **Dialect voice previews**: all 6 dialect voices (粤语/四川话/东北话/河南话/山东话/台湾腔) now ship fixed persona-line preview MP3s — no more real-time synthesis needed for preview
- **Adaptive bubble hide time**: auto-dismiss delay scales with total character count (base 2.8s + 60ms/char, capped 9s), so bilingual subtitles have enough reading time
- **Avatar cache-busting**: image URL includes `?v=<mtime>` so replacing avatar.webp takes effect immediately without waiting for browser cache expiry
- **ja/ko UI strings**: card labels, button titles, and status messages now render in Japanese/Korean when the DSH locale matches
- **aria-label includes translation**: screen readers announce both the spoken text and the Chinese translation
- **Remember clone voice across language switch**: when switching away from Chinese (which hides dialect voices), the previously selected clone sample is saved to localStorage and auto-restored when switching back
- **Configurable timeouts**: `otherLanguageTimeoutMs` (default 60000) and `longAudioSeconds` (default 22) are now exposed as config keys instead of hardcoded constants
- **ffmpeg availability detection**: lazy-probed at first speech-rate application; `/config` exposes `runtime.ffmpeg` so the settings card can warn if missing

### Tests
- 7 new assertions: client structural tests (sync reveal, adaptive hide, avatar version, ja/ko TEXT, aria translation, clone memory) + dialect preview file existence
- Total: **37 passed**

## v1.30.9 (2026-10-25)

- Synchronized subtitle reveal: original and translation appear character-by-character in step with audio progress
- Git release automation groundwork

## v1.30.8 (2026-10-25)

- Non-Chinese languages auto-switch to preset voice (cloned Mandarin timbre reads foreign languages unreliably)
- Korean default speech rate raised to 1.25×
- Translation prompt rewritten to prevent verbatim Chinese echo for en/ko
- Source-language leak detector rejects untranslated output
- Transient translation failures retry once

## v1.30.7 (2026-10-25)

- Fixed client-side ReferenceError from stale dialect state references that disabled language/speech-rate selectors

## v1.30.6 (2026-10-25)

- Portrait animation fix: bob the clipping frame instead of the image — eliminates both black-edge leaks and foot-clipping

## v1.30.5 (2026-10-25)

- Portrait animation rework: staggered entrance (glow → portrait → bubble), reversed exit, reduced-motion support

## v1.30.4 (2026-10-25)

- Portrait black-edge fix: padded avatar vertically + cover fit with bottom alignment

## v1.30.3 (2026-10-25)

- Portrait black-edge fix attempt: inner wrapper with overscan (superseded by v1.30.6)

## v1.30.2 (2026-10-25)

- Portrait black-edge fix attempt: negative top/bottom offsets (superseded by v1.30.6)

## v1.30.1 (2026-10-25)

- Portrait animation optimization: three-stage staggered entrance/exit

## v1.30.0 (2026-10-25)

- Shandong dialect added (6th dialect voice)
- Per-dialect persona prompts

## v1.29.0 (2026-10-25)

- Dialect voices folded into the voice list (Chinese-only)
- Per-dialect built-in persona prompts

## v1.28.0 (2026-10-25)

- Dialects merged into voice presets; removed standalone dialect selector
- Language-gated dialect visibility

## v1.27.0 (2026-10-25)

- Dialect support via MiMo-TTS audio-tag channel
- Auto-switch to preset voice for dialect (clone accent cannot be overridden)

## v1.26.0 (2026-10-25)

- Language switch auto-resets speech rate to new language's default

## v1.25.0 (2026-10-25)

- Speech rate slider in settings card

## v1.24.0 (2026-10-25)

- Per-language speech rate factors (zh 1.00 / en 1.08 / ja 1.12 / ko 1.10→1.25)
- ffmpeg atempo deterministic speed control

## v1.23.0 (2026-10-25)

- Multi-language report (zh/en/ja/ko): speech switches to target language
- Subtitle shows original + Chinese translation appended after playback
- Translation retry on transient network errors

## v1.22.0 (2026-10-25)

- Language selector in settings card
- Translation pipeline (summarize → translate → synthesize)

## v1.21.0 (2026-10-25)

- Per-voice persona prompts (built-in defaults + custom override)
- Persona-aware summary generation

## v1.20.0 (2026-10-25)

- Settings card: volume slider, language select, speech rate, persona editor
- Gear button on conversation page jumps to plugin settings

## v1.19.0 (2026-10-25)

- Volume configuration (0–1)
- Settings card overhaul

## v1.18.0 (2026-10-25)

- Session persistence across plugin reloads (10-minute TTL)
- Translation failure diagnostics in events and lastError

## v1.17.0 (2026-10-25)

- Turn-level response cache with in-flight deduplication
- /say rate limiting (6/min)
- Diagnostic event ring buffer (50 entries)
- lastError with raw HTTP status and body snippet

## v1.16.0 (2026-10-25)

- 14 anime voice archetypes (voicedesign synthetic)
- F0-based quality screening for generated samples

## v1.15.0 (2026-10-25)

- Fixed persona-line preview MP3s for all voices
- Preview endpoint (/mimo-voice/preview)

## v1.14.0 (2026-10-25)

- De-essing for tsundere voice sample
- Dynamic voice preset scanning (voice-sample-*.mp3 auto-discovery)

## v1.13.0 (2026-10-25)

- Initial 16-voice library with persona prompts

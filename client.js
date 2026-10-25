/**
 * MiMo 语音汇报 · Client half
 *
 * 两个部件共用一份模块级状态：
 *  1. 输入框工具行右侧的小喇叭（conversation.input.right）：判断"一轮任务结束"、
 *     向宿主要语音、播放音频；
 *  2. 鲸鱼娘浮层（shell.overlay）：播放时弹出立绘 + 对话气泡，
 *     气泡里的文字按音频播放进度逐字显现。
 */
window.__ModuleLoader__.load({
  id: 'mimo-voice-report',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ENABLED_KEY = 'dsh.mimoVoiceReport.enabled'
    const LANG_KEY = 'dsh.mimoVoiceReport.lang'
    const CLIENT_VERSION = '1.31.0'
    const spoken = new Set()

    // ——— 播放音量：设置卡写、播放侧读（持久化真身在宿主 config.volume） ———
    const volumeState = { value: 1 }
    let avatarVersion = 0
    function setCurrentVolume(value) {
      const n = Number(value)
      volumeState.value = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
    }

    // ——— 跳转插件配置页：宿主 pluginNavigation（dsh 0.2.1+）挂上后置 ready ———
    const navState = { ready: false }
    let openBundleNav = null
    const navListeners = new Set()
    function notifyNav() {
      navListeners.forEach(function (fn) { fn() })
    }

    // ——— 共享视图状态：按钮写、浮层读 ———
    const listeners = new Set()
    const view = { visible: false, phase: 'idle', text: '', shown: 0, leaving: false, fallback: '', noCaret: false, translation: '', transShown: 0 }
    let hideTimer = 0
    let revealRaf = 0
    let currentAudio = null

    function emit(patch) {
      Object.assign(view, patch)
      listeners.forEach(function (fn) {
        fn()
      })
    }

    function subscribe(fn) {
      listeners.add(fn)
      return function () {
        listeners.delete(fn)
      }
    }

    function useView() {
      const [, bump] = React.useState(0)
      React.useEffect(function () {
        return subscribe(function () {
          bump(function (n) {
            return n + 1
          })
        })
      }, [])
      return view
    }

    /** pluginNavigation 挂上后重渲染（齿轮按钮随宿主能力出现/消失）。 */
    function useNavReady() {
      const [, bump] = React.useState(0)
      React.useEffect(function () {
        const fn = function () {
          bump(function (n) {
            return n + 1
          })
        }
        navListeners.add(fn)
        return function () {
          navListeners.delete(fn)
        }
      }, [])
      return navState.ready
    }

    function stopReveal() {
      if (revealRaf) {
        cancelAnimationFrame(revealRaf)
        revealRaf = 0
      }
    }

    /** 先播完离场动画（最长 340ms：立绘 40ms 延迟 + 300ms），再真正卸载浮层。 */
    function beginLeave() {
      if (!view.visible || view.leaving) return
      emit({ leaving: true })
      clearTimeout(hideTimer)
      hideTimer = setTimeout(function () {
        stopReveal()
        emit({ visible: false, phase: 'idle', text: '', shown: 0, leaving: false, noCaret: false, translation: '', transShown: 0 })
      }, 360)
    }

    function hideCardSoon(ms) {
      clearTimeout(hideTimer)
      hideTimer = setTimeout(beginLeave, ms || 0)
    }

    function showCard(patch) {
      clearTimeout(hideTimer)
      emit(Object.assign({ visible: true, shown: 0, leaving: false, fallback: '', noCaret: false, translation: '', transShown: 0 }, patch))
    }

    /** 按音频播放进度推进逐字显现（timeupdate 只有 ~4Hz，这里用 rAF 平滑）。
     *  原文与译文共用同一个进度比，所以两者是「同步逐字」出现的，不是原文播完译文才整段弹出。 */
    function startReveal(el, text, translation) {
      stopReveal()
      const total = Array.from(text).length
      const trans = Array.from(String(translation || ''))
      const transTotal = trans.length
      let last = -1
      let lastTrans = -1
      function tick() {
        if (!el || el.paused || el.ended) {
          revealRaf = 0
          return
        }
        const duration = el.duration
        const time = el.currentTime || 0
        let ratio
        if (isFinite(duration) && duration > 0) ratio = Math.min(1, (time + 0.12) / duration)
        else ratio = Math.min(1, time / Math.max(1, total / 4.5))
        const shown = Math.max(0, Math.min(total, Math.floor(ratio * total)))
        const transShown = Math.max(0, Math.min(transTotal, Math.floor(ratio * transTotal)))
        if (shown !== last || transShown !== lastTrans) {
          last = shown
          lastTrans = transShown
          emit({ shown: shown, transShown: transShown })
        }
        revealRaf = requestAnimationFrame(tick)
      }
      revealRaf = requestAnimationFrame(tick)
    }

    const TEXT = {
      zh: {
        titleOn: '语音汇报已开启：任务完成后自动播报',
        titleOff: '语音汇报已关闭',
        loading: '正在生成语音汇报…',
        playing: '正在播报…',
        blocked: '浏览器拦截了自动播放，点击重试',
        error: '语音汇报失败，点击重试',
        noAudio: '当前浏览器不支持音频播放',
        preparing: '正在准备语音汇报…',
        cardMeta: '鲸鱼娘 · 语音汇报',
        blockedMeta: '浏览器拦了自动播放 · 点一下小喇叭',
        fallbackMeta: '语音暂不可用 · 已用提示音',
        translateFailed: '语种翻译失败 · 本轮用中文播报',
        close: '关闭',
        avatarAlt: '鲸鱼娘',
        settings: '打开语音设置（音色 / 音量 / Key）',
      },
      en: {
        titleOn: 'Voice report on: speaks when a task finishes',
        titleOff: 'Voice report off',
        loading: 'Generating the voice report…',
        playing: 'Speaking…',
        blocked: 'Autoplay was blocked — click to retry',
        error: 'Voice report failed — click to retry',
        noAudio: 'This browser cannot play audio',
        preparing: 'Preparing the voice report…',
        cardMeta: 'Voice report',
        blockedMeta: 'Autoplay blocked · tap the speaker to retry',
        fallbackMeta: 'TTS unavailable · chime instead',
        translateFailed: 'Translation failed · speaking Chinese this turn',
        close: 'Close',
        avatarAlt: 'Whale girl',
        settings: 'Open voice settings (voice / volume / key)',
      },
      ja: {
        titleOn: '音声レポート ON：タスク完了時に自動で読み上げます',
        titleOff: '音声レポート OFF',
        loading: '音声レポートを生成中…',
        playing: '読み上げ中…',
        blocked: '自動再生がブロックされました — クリックで再試行',
        error: '音声レポート失敗 — クリックで再試行',
        noAudio: 'このブラウザは音声を再生できません',
        preparing: '音声レポートを準備中…',
        cardMeta: '音声レポート',
        blockedMeta: '自動再生ブロック · スピーカーをタップして再試行',
        fallbackMeta: 'TTS 利用不可 · チャイムで代用',
        translateFailed: '翻訳失敗 · 今回は中国語で読み上げます',
        close: '閉じる',
        avatarAlt: 'クジラ娘',
        settings: '音声設定を開く（ボイス / 音量 / Key）',
      },
      ko: {
        titleOn: '음성 리포트 켜짐: 작업 완료 시 자동 재생',
        titleOff: '음성 리포트 꺼짐',
        loading: '음성 리포트 생성 중…',
        playing: '재생 중…',
        blocked: '자동 재생이 차단되었습니다 — 클릭하여 재시도',
        error: '음성 리포트 실 — 클릭하여 재시도',
        noAudio: '이 브라우저는 오디오를 재생할 수 없습니다',
        preparing: '음성 리포트 준비 중…',
        cardMeta: '음성 리포트',
        blockedMeta: '자동 재생 차단 · 스피커를 탭하여 재시도',
        fallbackMeta: 'TTS 사용 불가 · 알림음으로 대체',
        translateFailed: '번역 실패 · 이번에는 중국어로 읽습니다',
        close: '닫기',
        avatarAlt: '고래 소녀',
        settings: '음성 설정 열기 (보이스 / 볼륨 / Key)',
      },
    }

    const CSS = [
      '.mv-report{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s ease,color .15s ease,opacity .15s ease}',
      '.mv-report:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.mv-report:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.mv-report svg{width:16px;height:16px;display:block}',
      '.mv-report.is-off{opacity:.55}',
      '.mv-report.is-loading svg{opacity:.5}',
      '.mv-report.is-playing{color:var(--dsw-alias-brand-primary)}',
      '.mv-report.is-playing svg{animation:mv-pulse 1.1s ease-in-out infinite}',
      '.mv-report.is-blocked,.mv-report.is-error{color:var(--dsw-alias-state-warn-primary)}',
      '@keyframes mv-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      '@media (prefers-reduced-motion: reduce){.mv-report.is-playing svg{animation:none}}',
    ].join('\n')

    const CARD_CSS = [
      // 容器只管定位；动效放在立绘/气泡/光晕三个子元素上，各自错峰入场。
      '.mv-card{position:fixed;right:24px;bottom:112px;z-index:80;display:flex;align-items:flex-end;gap:12px;max-width:min(440px,calc(100vw - 48px));pointer-events:none}',
      /* —— 入场：从右下角"生长"出来，而不是整体平移 ——
         光晕先亮（0ms）→ 立绘跟进（60ms，带轻微过冲）→ 气泡最后弹出（150ms，
         从立绘一侧展开：transform-origin 设在左下角，配 scaleX 起手，像"被说出来"）。
         三段错峰 + 不同缓动，比原来的同时缩放更有层次。 */
      '.mv-glow{animation:mv-glow-in .5s ease both}',
      // 入场/退场放在外层包裹 .mv-figwrap；浮动放在裁剪框 .mv-figure 本身。
      '.mv-figwrap{flex:0 0 auto;animation:mv-fig-in .52s cubic-bezier(.16,1.02,.3,1.12) 60ms both}',
      '.mv-bubble{animation:mv-bubble-in .46s cubic-bezier(.16,1.06,.32,1.1) 150ms both;transform-origin:0% 100%}',
      '@keyframes mv-glow-in{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:none}}',
      '@keyframes mv-fig-in{0%{opacity:0;transform:translate(14px,22px) scale(.82) rotate(-2.5deg)}70%{opacity:1}100%{opacity:1;transform:none}}',
      '@keyframes mv-bubble-in{0%{opacity:0;transform:translate(-6px,10px) scale(.9)}60%{opacity:1;transform:translate(0,-2px) scale(1.008)}100%{opacity:1;transform:none}}',
      /* —— 退场：反向收回，比入场快（0.3s），气泡先走、立绘后走 —— */
      '.mv-card.is-leaving .mv-bubble{animation:mv-bubble-out .22s ease-in forwards}',
      '.mv-card.is-leaving .mv-figwrap{animation:mv-fig-out .3s ease-in 40ms forwards}',
      '.mv-card.is-leaving .mv-glow{animation:mv-glow-out .34s ease-in forwards}',
      '@keyframes mv-bubble-out{to{opacity:0;transform:translate(-4px,6px) scale(.94)}}',
      '@keyframes mv-fig-out{to{opacity:0;transform:translate(10px,16px) scale(.88) rotate(-1.5deg)}}',
      '@keyframes mv-glow-out{to{opacity:0;transform:scale(.85)}}',
      // 品牌色光晕：垫在卡片后面，准备/播放时最亮，播完慢慢暗下去。
      '.mv-glow{position:absolute;right:-30px;bottom:-34px;width:230px;height:190px;border-radius:50%;background:var(--dsw-alias-brand-primary);opacity:0;filter:blur(46px);pointer-events:none;z-index:-1;transition:opacity .5s ease}',
      '.mv-card.is-loading .mv-glow,.mv-card.is-playing .mv-glow{opacity:.28}',
      '.mv-card.is-done .mv-glow{opacity:.10}',
      // 立绘：圆角小卡 + 顶部高光 + 呼吸浮动。
      // 浮动的正确做法：位移加在「裁剪框」上，而不是图片上。
      // 图片永远 100% 填满裁剪框（cover），框整体上下平移 —— 内容和框之间没有相对位移，
      // 所以既不会露出一丝底色（黑边），也不会因为位移把人物头顶/脚裁掉。
      // cover 每侧只裁 1.6px（原图人物上下各有 8px 白边），人物完整。
      '.mv-figure{position:relative;width:118px;height:154px;flex:0 0 auto;border-radius:18px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 16px 34px rgba(0,0,0,.32);pointer-events:auto;transition:border-color .3s ease;animation:mv-bob 3.8s ease-in-out infinite;will-change:transform}',
      '.mv-figure:before{content:"";position:absolute;inset:0;background:radial-gradient(130% 100% at 50% 0%,rgba(255,255,255,.16),transparent 55%);pointer-events:none;z-index:1}',
      '.mv-figure img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 50%;display:block}',
      '.mv-card.is-playing .mv-figure{border-color:var(--dsw-alias-brand-primary)}',
      '@keyframes mv-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
      // 气泡：毛玻璃、大圆角、靠尾巴一侧收小角。
      '.mv-bubble{position:relative;min-width:150px;max-width:300px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:18px;border-bottom-left-radius:8px;padding:12px 30px 10px 14px;box-shadow:0 18px 40px rgba(0,0,0,.30);backdrop-filter:blur(16px) saturate(1.3);-webkit-backdrop-filter:blur(16px) saturate(1.3);pointer-events:auto;transition:border-color .25s ease}',
      '.mv-bubble:after{content:"";position:absolute;left:-5.5px;bottom:18px;width:11px;height:11px;background:var(--dsw-alias-bg-overlay);border-left:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);transform:rotate(45deg);border-bottom-left-radius:3px}',
      // 正文：每个新出现的字带一次 4px 上浮。
      '.mv-text{font-size:14px;line-height:1.75;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;min-height:1.75em}',
      '.mv-c{display:inline-block;animation:mv-char .24s ease both}',
      '@keyframes mv-char{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
      '.mv-caret{display:inline-block;width:2.5px;height:1em;margin-left:2px;vertical-align:-2px;border-radius:2px;background:var(--dsw-alias-brand-primary);animation:mv-blink 1s steps(2,start) infinite}',
      '.mv-dim{color:var(--dsw-alias-label-secondary)}',
      '.mv-trans{margin-top:7px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
      // 进度线：准备时来回扫，播放时跟音频走，播完停在满格再淡出。
      '.mv-bar{position:relative;height:2px;margin:9px 2px 7px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden;opacity:0;transition:opacity .3s ease}',
      '.mv-card.is-loading .mv-bar,.mv-card.is-playing .mv-bar{opacity:1}',
      '.mv-card.is-done .mv-bar{opacity:.45}',
      '.mv-bar>i{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:2px;background:var(--dsw-alias-brand-primary);transition:width .2s linear}',
      '.mv-card.is-loading .mv-bar>i{width:34%;animation:mv-sweep 1.1s ease-in-out infinite}',
      '@keyframes mv-sweep{0%{left:-34%}100%{left:100%}}',
      // 状态行：小圆点 + 说明，播放中圆点呼吸。
      '.mv-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.9}',
      '.mv-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.mv-card.is-loading .mv-dot,.mv-card.is-playing .mv-dot{background:var(--dsw-alias-brand-primary);animation:mv-dot 1.2s ease-in-out infinite}',
      '@keyframes mv-dot{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.6);opacity:.55}}',
      '.mv-close{position:absolute;top:6px;right:6px;width:20px;height:20px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;transition:background .15s ease,color .15s ease,transform .15s ease}',
      '.mv-close:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);transform:scale(1.06)}',
      // 被拦 / 出错：警示描边 + 整卡轻抖一下。
      '.mv-card.is-blocked .mv-bubble,.mv-card.is-error .mv-bubble{border-color:var(--dsw-alias-state-warn-primary)}',
      '.mv-card.is-blocked .mv-meta,.mv-card.is-error .mv-meta{color:var(--dsw-alias-state-warn-primary)}',
      '.mv-card.is-blocked .mv-dot,.mv-card.is-error .mv-dot{background:var(--dsw-alias-state-warn-primary)}',
      // 兜底提示音：正常播出但用警示色说明"语音暂不可用"。
      '.mv-card.is-fallback .mv-meta{color:var(--dsw-alias-state-warn-primary)}',
      '.mv-card.is-fallback .mv-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.mv-card.is-blocked,.mv-card.is-error{animation:mv-shake .3s ease}',
      '@keyframes mv-shake{0%,100%{transform:none}25%{transform:translateX(-3px)}60%{transform:translateX(2px)}}',
      '@keyframes mv-blink{0%,100%{opacity:1}50%{opacity:0}}',
      // 动效敏感用户：全部换成纯淡入淡出，浮动/呼吸/抖动一律关掉。
      '@media (prefers-reduced-motion: reduce){.mv-figwrap,.mv-bubble{animation:mv-fade .18s ease both}.mv-card.is-leaving .mv-figwrap,.mv-card.is-leaving .mv-bubble{animation:mv-fadeout .18s ease forwards}.mv-glow{animation:none}.mv-figure,.mv-figure img,.mv-c,.mv-card.is-blocked,.mv-card.is-error,.mv-dot,.mv-card.is-loading .mv-bar>i,.mv-caret{animation:none}}',
      '@keyframes mv-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes mv-fadeout{from{opacity:1}to{opacity:0}}',
      '@media (max-width:720px){.mv-card{right:14px;bottom:96px;gap:8px}.mv-figure{width:92px;height:122px;border-radius:14px}.mv-bubble{max-width:calc(100vw - 150px);border-radius:16px;border-bottom-left-radius:7px;padding:10px 26px 9px 12px}.mv-text{font-size:13.5px}}',
    ].join('\n')

    function readEnabled() {
      try {
        const raw = localStorage.getItem(ENABLED_KEY)
        return raw === null ? true : raw === '1'
      } catch {
        return true
      }
    }

    function writeEnabled(value) {
      try {
        localStorage.setItem(ENABLED_KEY, value ? '1' : '0')
      } catch {}
    }

    function report(payload) {
      try {
        fetch('/mimo-voice/_client', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: Date.now(), ...payload }),
        }).catch(function () {})
      } catch {}
    }

    /** 宿主 DSH 的界面语言，例如 'zh-CN' / 'en-US'；读不到返回 ''。 */
    function hostLocale() {
      const svc = localeRef.current
      try {
        const snap = svc && typeof svc.getSnapshot === 'function' ? svc.getSnapshot() : undefined
        // DSH locale 服务的快照形状是 { active: 'zh-CN' }（dshmarket 也这么读）；
        // 旧实现找的是 locale / id / current —— 真实快照上都没有，于是永远命中不了。
        const value = snap ? String(snap.active || snap.locale || snap.id || snap.current || '') : ''
        return value.toLowerCase()
      } catch {}
      return ''
    }

    /** 浏览器自己的偏好列表，作为宿主语言缺失时的兜底。 */
    function browserLocales() {
      const list = []
      try {
        if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
          list.push(document.documentElement.lang)
        }
        if (typeof navigator !== 'undefined') {
          if (Array.isArray(navigator.languages)) list.push.apply(list, navigator.languages)
          if (navigator.language) list.push(navigator.language)
        }
      } catch {}
      return list.filter(Boolean).map(function (tag) { return String(tag).toLowerCase() })
    }

    /** 诊断用：界面语言取自哪、浏览器偏好是什么（排查"为什么是英文"）。 */
    function localeInfo() {
      const host = hostLocale()
      const hints = browserLocales()
      if (host) return { tag: host, from: 'dsh', browser: hints[0] || '' }
      return { tag: '', from: hints.length ? 'browser-only' : 'none', browser: hints[0] || '' }
    }

    /** 手动指定语言的开关（'zh' / 'en'）；不设就是 auto。 */
    function readLangOverride() {
      try {
        const raw = localStorage.getItem(LANG_KEY)
        return raw === 'zh' || raw === 'en' ? raw : ''
      } catch {
        return ''
      }
    }

    /**
     * 判定用：只有 DSH 自己说界面是英文才切英文，否则一律中文。
     * 播报正文永远是中文（「任务完成啦。」+ 中文总结），英文字配中文声音并不配套；
     * 而浏览器偏好（navigator.language = en-US）不代表界面语言——旧实现正是被它带偏的。
     * 想强制某一种：控制台执行 localStorage.setItem('dsh.mimoVoiceReport.lang', 'zh'|'en'|'')。
     */
    function pickText() {
      const forced = readLangOverride()
      if (forced) return TEXT[forced] || TEXT.zh
      const locale = hostLocale()
      if (/^ja([-_]|$)/.test(locale)) return TEXT.ja
      if (/^ko([-_]|$)/.test(locale)) return TEXT.ko
      if (/^en([-_]|$)/.test(locale)) return TEXT.en
      return TEXT.zh
    }

    function SpeakerIcon(props) {
      const muted = props.muted
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4.5 9.5h3.1L11.8 6v12L7.6 14.5H4.5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
          fill: muted ? 'none' : 'currentColor',
          fillOpacity: muted ? 0 : 0.18,
        }),
        muted
          ? h('path', { d: 'M15.5 9.2l4 5.6M19.5 9.2l-4 5.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })
          : [
              h('path', { key: 'w1', d: 'M15.2 9.1a4.1 4.1 0 0 1 0 5.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
              h('path', { key: 'w2', d: 'M17.8 7a7.4 7.4 0 0 1 0 10', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', opacity: 0.55 }),
            ]
      )
    }

    /** 齿轮图标：对话页直达插件设置页。 */
    function SettingsIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 3.1, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', {
          d: 'M19.2 14.4a1.5 1.5 0 0 0 .3 1.65l.05.06a1.8 1.8 0 1 1-2.55 2.55l-.06-.05a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37v.17a1.8 1.8 0 1 1-3.6 0v-.09a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.06.05a1.8 1.8 0 1 1-2.55-2.55l.05-.06a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H3.6a1.8 1.8 0 1 1 0-3.6h.09a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.05-.06A1.8 1.8 0 1 1 7.26 4.3l.06.05a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37V3.1a1.8 1.8 0 1 1 3.6 0v.09a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.06-.05a1.8 1.8 0 1 1 2.55 2.55l-.05.06a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.17a1.8 1.8 0 1 1 0 3.6h-.09a1.5 1.5 0 0 0-1.37.9Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        })
      )
    }

    /** 播放用的 <audio>：统一在这里创建，浮层的关闭按钮也能停掉它。 */
    function ensureAudio(ref) {
      if (ref.current) return ref.current
      const el = new Audio()
      el.preload = 'auto'
      ref.current = el
      currentAudio = el
      return el
    }

    // ——— 小喇叭：触发 + 播放 ———
    function VoiceReportButton(props) {
      const sessionId = props.sessionId
      const useSession = props.useSession
      const running = typeof useSession === 'function' ? useSession(function (snapshot) { return Boolean(snapshot && snapshot.running) }) : false
      const L = pickText()
      const navReady = useNavReady()
      const [enabled, setEnabled] = React.useState(readEnabled)
      const [status, setStatus] = React.useState('idle')
      const [detail, setDetail] = React.useState('')
      const statusRef = React.useRef('idle')
      statusRef.current = status
      const prevRunning = React.useRef(running)
      const alive = React.useRef(true)
      const audio = React.useRef(null)
      const timer = React.useRef(0)
      const retryCleanup = React.useRef(null)

      React.useEffect(function () {
        const loc = localeInfo()
        report({ event: 'mounted', v: CLIENT_VERSION, sessionId: sessionId, enabled: readEnabled(), hasAudio: typeof Audio !== 'undefined', lang: pickText() === TEXT.en ? 'en' : 'zh', dshLocale: loc.tag, localeFrom: loc.from, browserLocale: loc.browser })
        // 播放音量从宿主配置来（设置卡保存后写回，页面刷新/重开在这里重新同步）。
        fetch('/mimo-voice/config')
          .then(function (response) { return response.json() })
          .then(function (data) {
            if (data && Number.isFinite(Number(data.volume))) setCurrentVolume(data.volume)
          })
          .catch(function () {})
        const heartbeat = setInterval(function () {
          if (typeof document !== 'undefined' && document.hidden) return
          report({ event: 'heartbeat', v: CLIENT_VERSION, sessionId: sessionId, status: statusRef.current })
        }, 15000)
        return function () {
          clearInterval(heartbeat)
          alive.current = false
          if (timer.current) clearTimeout(timer.current)
          if (retryCleanup.current) retryCleanup.current()
          stopReveal()
          try {
            if (audio.current) {
              audio.current.pause()
              audio.current.removeAttribute('src')
            }
          } catch {}
        }
      }, [])

      React.useEffect(function () {
        const before = prevRunning.current
        prevRunning.current = running
        if (!before || running) return
        if (!readEnabled()) return
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(function () {
          if (alive.current) speak(false)
        }, 400)
        return function () {
          if (timer.current) clearTimeout(timer.current)
        }
      }, [running, sessionId])

      function armGestureRetry() {
        if (retryCleanup.current) return
        const el = audio.current
        if (!el || !el.src) return
        const tryPlay = function () {
          if (retryCleanup.current) retryCleanup.current()
          retryCleanup.current = null
          const playing = el.play()
          if (playing && typeof playing.then === 'function') {
            playing
              .then(function () {
                if (alive.current) setStatus('playing')
                report({ event: 'played-after-gesture', sessionId: sessionId })
              })
              .catch(function (error) {
                if (alive.current) setStatus('blocked')
                report({ event: 'play-blocked-again', sessionId: sessionId, message: String((error && error.message) || error) })
              })
          }
        }
        const cleanup = function () {
          try {
            document.removeEventListener('pointerdown', tryPlay, true)
            document.removeEventListener('keydown', tryPlay, true)
          } catch {}
        }
        retryCleanup.current = cleanup
        try {
          document.addEventListener('pointerdown', tryPlay, true)
          document.addEventListener('keydown', tryPlay, true)
        } catch {}
      }

      function play(data) {
        return new Promise(function (resolve) {
          if (typeof Audio === 'undefined') {
            setStatus('error')
            setDetail(L.noAudio)
            emit({ phase: 'error', text: L.noAudio })
            hideCardSoon(4000)
            report({ event: 'no-audio-api', sessionId: sessionId })
            resolve()
            return
          }
          const text = String(data.text || '')
          // 兜底提示音不到一秒，逐字显现没有意义：直接整句亮出、不挂闪烁光标。
          const isFallback = data.fallback === true
          // 译文（语种 ≠ zh 时宿主在 displayText 里追加）：与原文同步逐字显现。
          const display = String(data.displayText || '')
          const translation = display && display !== text ? display.slice(text.length).replace(/^\s*\n\s*/, '').trim() : ''
          const transTotal = Array.from(translation).length
          const el = ensureAudio(audio)
          el.volume = volumeState.value
          let started = false
          el.onplaying = function () {
            if (started) return
            started = true
            if (!alive.current) return
            // 被自动播放拦下后靠用户手势补播时，浮层可能已在离场路上，这里重新亮出来。
            showCard({
              phase: 'playing',
              text: text,
              shown: isFallback ? Array.from(text).length : 0,
              noCaret: isFallback,
              translation: translation,
              // 兜底「叮」时没有播放进度可跟，原文/译文直接全显。
              transShown: isFallback ? transTotal : 0,
            })
            if (!isFallback) startReveal(el, text, translation)
            report({ event: 'card-playing', sessionId: sessionId, chars: Array.from(text).length, duration: Math.round((el.duration || 0) * 100) / 100 })
          }
          el.onended = function () {
            stopReveal()
            emit({ phase: 'done', shown: Array.from(text).length, transShown: transTotal })
            // 自适应停留：基础 2.8s + 每字 60ms（原文+译文），上限 9s，保证双语字幕读得完。
            const totalChars = Array.from(text).length + transTotal
            hideCardSoon(Math.min(9000, 2800 + totalChars * 60))
            if (alive.current) setStatus('idle')
            report({ event: 'card-done', sessionId: sessionId, chars: Array.from(text).length })
          }
          el.onerror = function () {
            stopReveal()
            emit({ phase: 'error', text: text })
            hideCardSoon(4000)
            if (alive.current) setStatus('error')
            report({ event: 'audio-error', sessionId: sessionId })
          }
          el.src = 'data:' + (data.mime || 'audio/mpeg') + ';base64,' + data.audio
          const started_ = el.play()
          if (started_ && typeof started_.then === 'function') {
            started_
              .then(function () {
                if (!alive.current) return
                setStatus('playing')
                report({ event: 'played', sessionId: sessionId, turn: data.turn, chars: Array.from(text).length, bytes: String(data.audio || '').length })
              })
              .catch(function (error) {
                if (alive.current) {
                  setStatus('blocked')
                  setDetail(String((error && error.message) || error))
                }
                emit({ phase: 'blocked', text: text })
                hideCardSoon(6000)
                report({ event: 'play-blocked', sessionId: sessionId, message: String((error && error.message) || error) })
                armGestureRetry()
              })
              .then(resolve, resolve)
          } else {
            setStatus('playing')
            resolve()
          }
        })
      }

      function speak(force) {
        if (!sessionId) return Promise.resolve()
        setStatus('loading')
        showCard({ phase: 'loading', text: '', shown: 0 })
        // 宿主最坏要等 摘要 + TTS（各带一次重试）两段超时；给请求一个总上限，别让按钮无限转圈。
        const signal =
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(100000) : undefined
        return fetch('/mimo-voice/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, force: force === true }),
          signal: signal,
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            if (!alive.current) return
            if (!data || data.ok !== true) {
              if (data && (data.code === 'stale' || data.code === 'no-turn')) {
                setStatus('idle')
                beginLeave()
                return
              }
              setStatus('error')
              setDetail(String((data && data.message) || (data && data.code) || ''))
              emit({ phase: 'error', text: String((data && data.message) || '语音汇报失败') })
              hideCardSoon(4500)
              report({ event: 'report-failed', sessionId: sessionId, code: data && data.code, message: data && data.message })
              return
            }
            const key = sessionId + ':' + data.turn + ':' + data.endedAt
            if (!force && spoken.has(key)) {
              setStatus('idle')
              beginLeave()
              return
            }
            spoken.add(key)
            // MiMo 不可用时宿主会返回内置提示音（fallback:true）：照播，但气泡要说明原因。
            const isFallback = data.fallback === true
            // 语种翻译失败时宿主回落中文播报，并带回 translateError——必须让用户看见原因。
            if (data.translateError) report({ event: 'translate-failed', sessionId: sessionId, reason: data.translateError })
            const metaNote = isFallback
              ? String(data.message || L.fallbackMeta)
              : data.translateError
                ? L.translateFailed
                : ''
            setDetail((metaNote ? metaNote + ' · ' : '') + String(data.displayText || data.text || ''))
            showCard({
              phase: 'loading',
              text: String(data.text || ''),
              shown: 0,
              fallback: metaNote,
              translation: String(data.displayText || '') !== String(data.text || '')
                ? String(data.displayText).slice(String(data.text || '').length).replace(/^\s*\n\s*/, '').trim()
                : '',
            })
            if (isFallback) report({ event: 'report-fallback', sessionId: sessionId, kind: data.kind, message: data.message })
            return play(data)
          })
          .catch(function (error) {
            if (!alive.current) return
            const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError')
            const why = timedOut ? '等太久了，这次先放弃（宿主可能仍在处理，稍后点小喇叭重试）' : String((error && error.message) || error)
            setStatus('error')
            setDetail(why)
            emit({ phase: 'error', text: why })
            hideCardSoon(4500)
            report({ event: 'report-error', sessionId: sessionId, message: why })
          })
      }

      function onClick() {
        if (status === 'blocked' || status === 'error') {
          speak(true)
          return
        }
        const next = !enabled
        setEnabled(next)
        writeEnabled(next)
        if (!next) {
          try {
            if (audio.current) audio.current.pause()
          } catch {}
          stopReveal()
          beginLeave()
          setStatus('idle')
        }
        report({ event: 'toggle', sessionId: sessionId, enabled: next })
      }

      const label =
        status === 'loading'
          ? L.loading
          : status === 'playing'
            ? L.playing
            : status === 'blocked'
              ? L.blocked
              : status === 'error'
                ? L.error
                : enabled
                  ? L.titleOn
                  : L.titleOff
      const title = detail ? label + '\n' + detail : label

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CSS),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'mv-report' + (enabled ? '' : ' is-off') + (status === 'idle' ? '' : ' is-' + status),
            title: title,
            'aria-label': label,
            'aria-pressed': enabled,
            'data-mimo-voice': status,
            onClick: onClick,
          },
          h(SpeakerIcon, { muted: !enabled })
        ),
        navReady
          ? h(
              'button',
              {
                key: 'settings',
                type: 'button',
                className: 'mv-report',
                title: L.settings,
                'aria-label': L.settings,
                onClick: function () {
                  if (openBundleNav) openBundleNav('mimo-voice-report')
                },
              },
              h(SettingsIcon)
            )
          : null
      )
    }

    // ——— 浮层：鲸鱼娘立绘 + 对话气泡（按播放进度逐字显现） ———
    function VoiceAvatarCard() {
      const v = useView()
      const L = pickText()
      const [avatarOk, setAvatarOk] = React.useState(true)
      if (!v.visible) return null

      const full = String(v.text || '')
      const chars = Array.from(full)
      const total = chars.length
      const shownCount = v.phase === 'playing' ? Math.min(total, v.shown) : v.phase === 'loading' ? 0 : total
      const pct = total ? Math.round((Math.max(0, shownCount) / total) * 100) : 0

      function close() {
        stopReveal()
        try {
          if (currentAudio) currentAudio.pause()
        } catch {}
        beginLeave()
      }

      // 已显示的字逐个变成 span：新 mount 的那个会播一次 4px 上浮，老的字保持不动。
      const spokenSpans = chars.slice(0, Math.max(0, shownCount)).map(function (ch, i) {
        if (ch === '\n') return h('br', { key: 'c' + i })
        return h('span', { key: 'c' + i, className: 'mv-c' }, ch === ' ' ? '\u00A0' : ch)
      })

      // 译文与原文共用播放进度：playing 时按 transShown 逐字，done/error 时整段补齐。
      const transChars = Array.from(v.translation || '')
      const transCount =
        v.phase === 'done' || v.phase === 'error' ? transChars.length : Math.max(0, Math.min(transChars.length, v.transShown || 0))
      const transText = transChars.slice(0, transCount).join('')

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CARD_CSS),
        h(
          'div',
          {
            key: 'card',
            className: 'mv-card is-' + v.phase + (v.leaving ? ' is-leaving' : '') + (v.fallback ? ' is-fallback' : ''),
            role: 'status',
            'aria-live': 'polite',
            'aria-label': v.phase === 'loading' || !full ? L.preparing : full + (v.translation ? '\n' + v.translation : ''),
          },
          h('div', { className: 'mv-glow', key: 'glow', 'aria-hidden': true }),
          avatarOk
            ? h(
                'div',
                { className: 'mv-figwrap', key: 'figure' },
                h(
                  'div',
                  { className: 'mv-figure' },
                  h('img', {
                    src: '/mimo-voice/avatar' + (avatarVersion ? '?v=' + avatarVersion : ''),
                    alt: L.avatarAlt,
                    draggable: false,
                    onError: function () {
                      setAvatarOk(false)
                      report({ event: 'avatar-failed' })
                    },
                  })
                )
              )
            : null,
          h(
            'div',
            { className: 'mv-bubble', key: 'bubble' },
            h(
              'button',
              { type: 'button', className: 'mv-close', 'aria-label': L.close, title: L.close, onClick: close, key: 'close' },
              '×'
            ),
            h(
              'div',
              { className: 'mv-text', key: 'text', 'aria-hidden': true },
              v.phase === 'loading'
                ? h('span', { className: 'mv-dim', key: 'prep' }, L.preparing)
                : spokenSpans,
              v.phase === 'playing' && !v.noCaret ? h('span', { className: 'mv-caret', key: 'caret' }) : null
            ),
            // 译文（语种 ≠ zh 时）：与原文共用同一个播放进度比，同步逐字显现；
            // 播完 / 出错时整段补齐（transCount 已按阶段算好）。
            transText
              ? h('div', { className: 'mv-trans', key: 'trans' }, transText)
              : null,
            h('div', { className: 'mv-bar', key: 'bar', 'aria-hidden': true }, h('i', { key: 'fill', style: v.phase === 'loading' ? undefined : { width: pct + '%' } })),
            h(
              'div',
              { className: 'mv-meta', key: 'meta' },
              h('span', { className: 'mv-dot', key: 'dot' }),
              v.fallback ? L.fallbackMeta : v.phase === 'blocked' ? L.blockedMeta : L.cardMeta
            )
          )
        )
      )
    }

    const KEY_CSS = [
      '.mv-key{display:flex;flex-direction:column;gap:8px;padding:12px 0}',
      '.mv-key-row{display:flex;gap:8px;align-items:center}',
      '.mv-key input{flex:1 1 auto;min-width:0;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
      '.mv-key input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.mv-key button{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.mv-key button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.mv-key button:disabled{opacity:.5;cursor:default}',
      '.mv-key button.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.mv-key-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mv-key-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
      '.mv-key-ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.mv-key-select{height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
      '.mv-key-range{flex:1 1 auto;min-width:0;height:30px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.mv-key-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mv-key-textarea{width:100%;min-height:66px;max-height:150px;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;outline:none;resize:vertical;box-sizing:border-box}',
      '.mv-key-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.mv-key-textarea:disabled{opacity:.55}',
      '.mv-key-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.mv-key-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.mv-key-check:has(input:disabled){cursor:default;opacity:.7}',
      '.mv-key-sub{margin-top:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
    ].join('\n')

    /** 插件详情页里的配置卡：音色选择 + 称呼 + MiMo API Key。 */
    function KeySettings(props) {
      const isSummary = Boolean(props && props.view === 'summary')
      const [state, setState] = React.useState({ loading: true, keySource: '', keyHint: '' })
      const [voice, setVoice] = React.useState({ sample: '', presets: [] })
      const [callMe, setCallMe] = React.useState('')
      const [nick, setNick] = React.useState('')
      // 宿主半 < 1.10.0 不认识 callMe：能读旧 /config 但存不进称呼，这里直接禁用并提示重启。
      const [hostOld, setHostOld] = React.useState(false)
      // /config 的能力标记：3 = 结束语库按 完成/出错/中止 三桶分别配；4 = 每音色人设提示词。
      const [hostApi, setHostApi] = React.useState(0)
      const [drafts, setDrafts] = React.useState({ completed: '', error: '', aborted: '' })
      const [counts, setCounts] = React.useState({ completed: 0, error: 0, aborted: 0 })
      const [builtin, setBuiltin] = React.useState({ completed: [], error: [], aborted: [] })
      const [onlyMine, setOnlyMine] = React.useState(false)
      const [value, setValue] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [previewing, setPreviewing] = React.useState(false)
      const [customText, setCustomText] = React.useState('')
      const [volume, setVolumeState] = React.useState(1)
      const [personaId, setPersonaId] = React.useState('original')
      const [personaText, setPersonaText] = React.useState('')
      const [personaCustom, setPersonaCustom] = React.useState(false)
      const [language, setLanguageState] = React.useState('zh')
      const [languages, setLanguages] = React.useState({ zh: '中文（不翻译）', en: 'English', ja: '日本語', ko: '한국어' })
      const [speechRate, setSpeechRate] = React.useState(1)
      const previewAudio = React.useRef(null)

      function applyPersonaPrompt(p) {
        if (!p || typeof p !== 'object') return
        setPersonaId(String(p.id || 'original'))
        setPersonaText(String(p.text || ''))
        setPersonaCustom(Boolean(p.custom))
      }

      function applyPersona(p) {
        const lib = p && typeof p === 'object' ? p.customAnnounces : null
        const norm = Array.isArray(lib) ? { completed: lib } : lib && typeof lib === 'object' ? lib : {}
        const next = { completed: '', error: '', aborted: '' }
        const cnt = { completed: 0, error: 0, aborted: 0 }
        const bl = p && p.builtinAnnounces && typeof p.builtinAnnounces === 'object' ? p.builtinAnnounces : {}
        const bn = { completed: [], error: [], aborted: [] }
        for (const kind of ['completed', 'error', 'aborted']) {
          const arr = Array.isArray(norm[kind]) ? norm[kind] : []
          next[kind] = arr.join('\n')
          cnt[kind] = arr.length
          bn[kind] = Array.isArray(bl[kind]) ? bl[kind] : []
        }
        setDrafts(next)
        setCounts(cnt)
        setBuiltin(bn)
        setOnlyMine(Boolean(p && p.customOnly === true))
      }

      function load() {
        fetch('/mimo-voice/config')
          .then(function (response) { return response.json() })
          .then(function (data) {
            setState({ loading: false, keySource: String(data.keySource || ''), keyHint: String(data.keyHint || '') })
            const v = (data && data.voice) || {}
            setVoice({ sample: String(v.sample || ''), presets: Array.isArray(v.presets) ? v.presets : [] })
            const vol = Number(data && data.volume)
            if (Number.isFinite(vol)) {
              const clamped = Math.min(1, Math.max(0, vol))
              setVolumeState(clamped)
              setCurrentVolume(clamped)
            }
            if (data && data.language) setLanguageState(String(data.language))
            if (data && data.languages && typeof data.languages === 'object') setLanguages(data.languages)
            if (data && data.speechRate && Number.isFinite(Number(data.speechRate.factor))) setSpeechRate(Number(data.speechRate.factor))
            if (data && data.avatarVersion) avatarVersion = Number(data.avatarVersion) || 0
            const p = (data && data.persona) || {}
            setCallMe(String(p.callMe || ''))
            setHostOld(!data || !data.persona)
            setHostApi(Number(data && data.api) || 0)
            applyPersona(p)
            applyPersonaPrompt(data && data.personaPrompt)
          })
          .catch(function (error) {
            setState({ loading: false, keySource: 'error', keyHint: '' })
            setNote(String((error && error.message) || error))
          })
      }

      React.useEffect(load, [])

      React.useEffect(function () {
        return function () {
          try {
            if (previewAudio.current) previewAudio.current.pause()
          } catch {}
        }
      }, [])

      function pickVoice(file) {
        if (!file) return
        setBusy(true)
        setNote('')
        fetch('/mimo-voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voiceSample: file }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '切换失败'))
              return
            }
            const v = (data && data.voice) || {}
            setVoice({ sample: String(v.sample || file), presets: Array.isArray(v.presets) ? v.presets : [] })
            // 切音色 = 换人设：新音色的生效提示词回填编辑框。
            applyPersonaPrompt(data && data.personaPrompt)
            setNote('音色已切换并生效')
          })
          .catch(function (error) {
            setBusy(false)
            setNote(String((error && error.message) || error))
          })
      }

      /** 默认播放当前音色随包发布的人设台词 MP3：本地秒播、不产生 MiMo 调用。 */
      function previewVoice() {
        const file = voice.sample
        if (!file || previewing) return
        if (typeof Audio === 'undefined') {
          setNote('当前浏览器不支持音频播放')
          return
        }
        setPreviewing(true)
        setNote('')
        try {
          if (previewAudio.current) previewAudio.current.pause()
        } catch {}
        const el = new Audio('/mimo-voice/preview?voice=' + encodeURIComponent(file))
        el.volume = volumeState.value
        previewAudio.current = el
        let settled = false
        el.onplaying = function () {
          settled = true
          setPreviewing(false)
          setNote('正在试听')
        }
        el.onerror = function () {
          setPreviewing(false)
          setNote('这条音色没有固定试听，请在下方输入台词后点「生成试听」。')
        }
        const playing = el.play()
        if (playing && typeof playing.then === 'function') {
          playing.catch(function () {
            setPreviewing(false)
            if (el.error) setNote('这条音色没有固定试听，请在下方输入台词后点「生成试听」。')
            else setNote('浏览器拦了自动播放；点一下页面任意处后再试')
          })
        }
        setTimeout(function () {
          if (!settled && previewAudio.current === el) setPreviewing(false)
        }, 5000)
      }

      /** 可选：用当前音色实时念用户输入的台词（走宿主 /say，限 6 次/分钟）。 */
      function previewCustom() {
        const text = customText.trim().slice(0, 120)
        if (!text || previewing) return
        setPreviewing(true)
        setNote('')
        fetch('/mimo-voice/say', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setPreviewing(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '试听失败'))
              return
            }
            if (typeof Audio === 'undefined') {
              setNote('当前浏览器不支持音频播放')
              return
            }
            try {
              if (previewAudio.current) previewAudio.current.pause()
            } catch {}
            const el = new Audio('data:' + (data.mime || 'audio/mpeg') + ';base64,' + data.audio)
            el.volume = volumeState.value
            previewAudio.current = el
            const playing = el.play()
            if (playing && typeof playing.catch === 'function') {
              playing.catch(function () { setNote('浏览器拦了自动播放；点一下页面任意处后再试') })
            }
            setNote('正在试听')
          })
          .catch(function (error) {
            setPreviewing(false)
            setNote(String((error && error.message) || error))
          })
      }

      /** 语速倍率：null = 清除自定义、回落按语种默认。 */
      function saveSpeechRate(next) {
        setBusy(true)
        setNote('')
        fetch('/mimo-voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ speechRateFactor: next === null ? null : next }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '保存失败'))
              return
            }
            if (data.speechRate && Number.isFinite(Number(data.speechRate.factor))) setSpeechRate(Number(data.speechRate.factor))
            setNote('语速已保存并生效')
          })
          .catch(function (error) {
            setBusy(false)
            setNote(String((error && error.message) || error))
          })
      }


      /** 汇报语种：非中文时字幕/悬停文字在中文后追加译文（语音仍播中文）。 */
      function saveLanguage(next) {
        setBusy(true)
        setNote('')
        fetch('/mimo-voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ language: next }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '保存失败'))
              return
            }
            setLanguageState(String(data.language || next))
            // 切语种后宿主会自动清掉自定义倍率，这里同步滑杆到新语种的默认倍率。
            if (data.speechRate && Number.isFinite(Number(data.speechRate.factor))) setSpeechRate(Number(data.speechRate.factor))
            // 音色列表要按语种重算：方言音色只在中文语种下提供。
            const v2 = (data && data.voice) || {}
            if (Array.isArray(v2.presets) && v2.presets.length) {
              setVoice({ sample: String(v2.sample || voice.sample), presets: v2.presets })
            }
            // 若当前音色是方言而语种切到了非中文，回落到原版音色（方言项已隐藏）。
            // 回落前记住用户之前选的克隆音色，切回中文时自动恢复。
            const stillDialect = String(v2.sample || '').indexOf('dialect-') >= 0
            const targetLang = String(data.language || next)
            if (stillDialect && targetLang !== 'zh') {
              try { localStorage.setItem('dsh.mimoVoiceReport.lastCloneSample', v2.sample) } catch {}
              pickVoice('voice-sample.mp3')
            } else if (!stillDialect && targetLang === 'zh') {
              // 切回中文：如果之前记住了克隆音色且当前是原版，自动恢复。
              let remembered = ''
              try { remembered = localStorage.getItem('dsh.mimoVoiceReport.lastCloneSample') || '' } catch {}
              if (remembered && v2.sample === 'voice-sample.mp3' && remembered !== 'voice-sample.mp3') {
                pickVoice(remembered)
                try { localStorage.removeItem('dsh.mimoVoiceReport.lastCloneSample') } catch {}
              }
            }
            setNote('语种已保存并生效')
          })
          .catch(function (error) {
            setBusy(false)
            setNote(String((error && error.message) || error))
          })
      }

      /** 人设提示词：保存为当前音色的自定义；text 传空串 = 恢复该音色的内置默认。 */
      function savePersona(text) {
        setBusy(true)
        setNote('')
        fetch('/mimo-voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ personaPrompt: { id: personaId, text: text } }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '保存失败'))
              return
            }
            applyPersonaPrompt(data && data.personaPrompt)
            setNote(text ? '人设已保存并生效' : '已恢复默认人设')
          })
          .catch(function (error) {
            setBusy(false)
            setNote(String((error && error.message) || error))
          })
      }

      /** 音量：拖动即时生效（下次播放就按这个音量），「保存」写回 config.volume 持久化。 */
      function saveVolume(next) {
        setBusy(true)
        setNote('')
        fetch('/mimo-voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ volume: next }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '保存失败'))
              return
            }
            const vol = Number(data && data.volume)
            if (Number.isFinite(vol)) {
              setVolumeState(vol)
              setCurrentVolume(vol)
            }
            setNote('音量已保存并生效')
          })
          .catch(function (error) {
            setBusy(false)
            setNote(String((error && error.message) || error))
          })
      }

      function saveCall(next) {
        setBusy(true)
        setNote('')
        fetch('/mimo-voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ callMe: next }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '保存失败'))
              return
            }
            const p = (data && data.persona) || {}
            setCallMe(String(p.callMe !== undefined ? p.callMe : next))
            setNick('')
            setNote('称呼已保存并生效')
          })
          .catch(function (error) {
            setBusy(false)
            setNote(String((error && error.message) || error))
          })
      }

      function saveLines() {
        const payload = { completed: [], error: [], aborted: [] }
        for (const kind of ['completed', 'error', 'aborted']) {
          payload[kind] = String(drafts[kind] || '').split(/\n+/).map(function (s) { return s.trim() }).filter(Boolean)
        }
        setBusy(true)
        setNote('')
        fetch('/mimo-voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ customAnnounces: payload, customOnly: onlyMine }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '保存失败'))
              return
            }
            applyPersona((data && data.persona) || { customAnnounces: payload, customOnly: onlyMine })
            setNote('结束语库已保存并生效')
          })
          .catch(function (error) {
            setBusy(false)
            setNote(String((error && error.message) || error))
          })
      }

      function save(next) {
        setBusy(true)
        setNote('')
        fetch('/mimo-voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: next }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '保存失败'))
              return
            }
            setValue('')
            setNote(next ? '已保存并生效（写入本插件 config.apiKey）' : '已清除，回落到环境变量 / 凭据库')
            load()
          })
          .catch(function (error) {
            setBusy(false)
            setNote(String((error && error.message) || error))
          })
      }

      const source = state.keySource || '…'
      const hint = state.keyHint ? '（' + state.keyHint + '）' : ''

      if (isSummary) {
        return h(
          'div',
          { key: 'summary', className: 'mv-key-note' },
          '称呼：', callMe || '未设置', ' · API Key 来源：',
          source,
          hint,
          state.keySource === 'missing' ? ' · 还没配置，点开本插件的配置填写' : ''
        )
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, KEY_CSS),
        h(
          'div',
          { className: 'mv-key', key: 'key' },
          h('div', { className: 'mv-key-title', key: 'vt' }, '音色'),
          h(
            'div',
            { className: 'mv-key-row', key: 'vrow' },
            h(
              'select',
              {
                key: 'voice',
                className: 'mv-key-select',
                value: voice.sample || '',
                disabled: busy || !voice.presets.length,
                onChange: function (event) { pickVoice(event.target.value) },
              },
              voice.presets.length
                ? voice.presets.map(function (preset) {
                    return h(
                      'option',
                      { key: preset.id, value: preset.file, disabled: preset.exists === false },
                      String(preset.label || preset.id) + (preset.exists === false ? '（缺失）' : '')
                    )
                  })
                : h('option', { key: 'none', value: '' }, state.loading ? '读取中…' : '没有可用采样')
            ),
            h(
              'button',
              { key: 'vprev', type: 'button', disabled: busy || previewing || !voice.sample, onClick: previewVoice },
              previewing ? '播放中…' : '试听'
            ),
            note === '音色已切换并生效'
              ? h('span', { key: 'vok', className: 'mv-key-ok' }, '已切换')
              : null
          ),
          h(
            'div',
            { className: 'mv-key-row', key: 'vcustom' },
            h('input', {
              key: 'vcustomtext',
              type: 'text',
              autoComplete: 'off',
              spellCheck: false,
              maxLength: 120,
              placeholder: '想听别的台词？在这里输入（最多 120 字）',
              value: customText,
              disabled: busy || previewing,
              onChange: function (event) { setCustomText(event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter') previewCustom()
              },
            }),
            h('button', {
              key: 'vcustomgo',
              type: 'button',
              disabled: busy || previewing || !customText.trim(),
              onClick: previewCustom,
            }, '生成试听')
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'vnote' },
            '默认播放这条音色的固定人设台词 MP3，本地秒播、不花 MiMo 额度；「生成试听」才实时合成（限 6 次/分钟）。自定义采样：把 5–15 秒的 voice-sample-名字.mp3 丢进插件目录即可。'
          ),
          h('div', { className: 'mv-key-title', key: 'ppt' }, '人设提示词'),
          h('textarea', {
            key: 'ppta',
            className: 'mv-key-textarea',
            rows: 3,
            maxLength: 200,
            spellCheck: false,
            placeholder: state.loading ? '读取中…' : '这个音色是什么角色、怎么说话（只写人设句，最长 200 字）',
            value: personaText,
            disabled: busy || hostApi < 4,
            onChange: function (event) { setPersonaText(event.target.value) },
          }),
          h(
            'div',
            { className: 'mv-key-row', key: 'pprow' },
            h('button', { key: 'ppsave', type: 'button', className: 'primary', disabled: busy || hostApi < 4 || !personaId || !personaText.trim(), onClick: function () { savePersona(personaText.trim()) } }, '保存'),
            personaCustom && hostApi >= 4
              ? h('button', { key: 'ppreset', type: 'button', disabled: busy, onClick: function () { savePersona('') } }, '恢复默认')
              : null,
            note === '人设已保存并生效' || note === '已恢复默认人设'
              ? h('span', { key: 'ppok', className: 'mv-key-ok' }, '已生效')
              : null
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'ppnote' },
            hostApi < 4
              ? '宿主半还是旧版本（重启 DSH 后这里才能编辑人设）。'
              : h(React.Fragment, { key: 'ppn' }, '当前音色「', personaId || 'original', '」', personaCustom ? '用的是你的自定义人设' : '用的是内置默认人设',
                 '。汇报口播稿会按这个人设的口吻生成（走摘要模型时生效；紧急兜底的抽取式摘要不经过人设）。切到别的音色时这里会跟着切换。')
          ),
          h('div', { className: 'mv-key-title', key: 'volt' }, '音量'),
          h(
            'div',
            { className: 'mv-key-row', key: 'volrow' },
            h('input', {
              key: 'volrange',
              type: 'range',
              min: 0,
              max: 1,
              step: 0.05,
              className: 'mv-key-range',
              value: volume,
              disabled: busy,
              onChange: function (event) {
                const v = Number(event.target.value)
                setVolumeState(v)
                setCurrentVolume(v)
              },
            }),
            h('span', { key: 'volpct', className: 'mv-key-note' }, Math.round(volume * 100) + '%'),
            h('button', { key: 'volsave', type: 'button', className: 'primary', disabled: busy, onClick: function () { saveVolume(volume) } }, '保存'),
            note === '音量已保存并生效'
              ? h('span', { key: 'volok', className: 'mv-key-ok' }, '已生效')
              : null
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'volnote' },
            '拖动即时生效（下一次播放就按这个音量）；「保存」写回 config.volume 持久化，范围 0–100%，默认 100%。'
          ),
          h('div', { className: 'mv-key-title', key: 'lt2' }, '汇报语种'),
          h(
            'div',
            { className: 'mv-key-row', key: 'lrow2' },
            h(
              'select',
              {
                key: 'langsel',
                className: 'mv-key-select',
                value: language,
                disabled: busy || hostApi < 4,
                onChange: function (event) { saveLanguage(event.target.value) },
              },
              Object.keys(languages).map(function (code) {
                return h('option', { key: code, value: code }, languages[code])
              })
            ),
            note === '语种已保存并生效'
              ? h('span', { key: 'lok2', className: 'mv-key-ok' }, '已生效')
              : null
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'lnote2' },
            hostApi < 4
              ? '宿主半还是旧版本（重启 DSH 后这里才能选语种）。'
              : '选择其他语种后，语音汇报会切换成该语种（中文稿由 MiMo 整段翻译，保留人设口吻）；气泡字幕随语音显示该语种原文，播完后追加中文译文。翻译失败时本轮回落中文播报。方言音色只在中文语种下出现在上面的音色列表里。'
          ),
          h('div', { className: 'mv-key-title', key: 'srt' }, '语速'),
          h('div', { className: 'mv-key-title', key: 'srt' }, '语速'),
          h(
            'div',
            { className: 'mv-key-row', key: 'srrow' },
            h('input', {
              key: 'srrange',
              type: 'range',
              min: 0.7,
              max: 1.5,
              step: 0.02,
              className: 'mv-key-range',
              value: speechRate,
              disabled: busy || hostApi < 4,
              onChange: function (event) { setSpeechRate(Number(event.target.value)) },
            }),
            h('span', { key: 'srpct', className: 'mv-key-note' }, speechRate.toFixed(2) + '×'),
            h('button', { key: 'srsave', type: 'button', className: 'primary', disabled: busy || hostApi < 4, onClick: function () { saveSpeechRate(speechRate) } }, '保存'),
            h('button', { key: 'srreset', type: 'button', disabled: busy || hostApi < 4, onClick: function () { saveSpeechRate(null) } }, '按语种默认'),
            note === '语速已保存并生效'
              ? h('span', { key: 'srok', className: 'mv-key-ok' }, '已生效')
              : null
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'srnote' },
            hostApi < 4
              ? '宿主半还是旧版本（重启 DSH 后这里才能调语速）。'
              : '合成后用 ffmpeg 变速不变调（确定可控）。默认：中文 1.00× / 英语 1.08× / 日语 1.12× / 韩语 1.10×；**切换语种会自动套用该语种默认值**（想固定就用这里的滑杆覆盖）。'
          ),
          h('div', { className: 'mv-key-title', key: 'ct' }, '称呼'),
          h(
            'div',
            { className: 'mv-key-row', key: 'crow' },
            h('input', {
              key: 'call',
              type: 'text',
              autoComplete: 'off',
              spellCheck: false,
              maxLength: 16,
              placeholder: state.loading ? '读取中…' : '怎么称呼你（如：主人 / 老板 / 名字）',
              value: nick,
              disabled: busy || hostOld,
              onChange: function (event) { setNick(event.target.value) },
            }),
            h('button', { key: 'csave', type: 'button', className: 'primary', disabled: busy || hostOld || nick.trim() === callMe, onClick: function () { saveCall(nick.trim()) } }, '保存'),
            callMe && !hostOld
              ? h('button', { key: 'cclear', type: 'button', disabled: busy, onClick: function () { saveCall('') } }, '清除')
              : null,
            note === '称呼已保存并生效'
              ? h('span', { key: 'cok', className: 'mv-key-ok' }, '已生效')
              : null
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'cnote' },
            hostOld
              ? '宿主半还是旧版本（重启 DSH 后这里才能保存称呼）。'
              : h(React.Fragment, { key: 'cn' }, '当前：', callMe || '（不称呼）', '。会缀在结束提示后，如「任务完成啦，', callMe || '主人', '。」；留空则不称呼，写回本插件 config.callMe。')
          ),
          h('div', { className: 'mv-key-title', key: 'lt' }, '结束语库'),
          ['completed', 'error', 'aborted'].map(function (kind) {
            const label = kind === 'completed' ? '完成' : kind === 'error' ? '出错' : '中止（含被打断）'
            return h(
              React.Fragment,
              { key: 'lb-' + kind },
              h('div', { className: 'mv-key-sub', key: 'sub-' + kind }, label, ' · 已存 ', String(counts[kind]), ' 句'),
              h('textarea', {
                key: 'ta-' + kind,
                className: 'mv-key-textarea',
                rows: 2,
                maxLength: 900,
                spellCheck: false,
                placeholder: builtin[kind] && builtin[kind].length ? '内置默认：' + builtin[kind].join(' / ') : '一行一句',
                value: drafts[kind],
                disabled: busy || hostApi < 3,
                onChange: function (event) {
                  const next = Object.assign({}, drafts)
                  next[kind] = event.target.value
                  setDrafts(next)
                },
              })
            )
          }),
          h(
            'div',
            { className: 'mv-key-row', key: 'lrow' },
            h(
              'label',
              { className: 'mv-key-check', key: 'lchk' },
              h('input', {
                type: 'checkbox',
                checked: onlyMine,
                disabled: busy || hostApi < 3,
                onChange: function (event) { setOnlyMine(event.target.checked) },
              }),
              '只用我写的，不掺内置款'
            ),
            h('span', { key: 'lfill', style: { flex: '1 1 auto' } }),
            h('button', { key: 'lsave', type: 'button', className: 'primary', disabled: busy || hostApi < 3, onClick: saveLines }, '保存'),
            note === '结束语库已保存并生效'
              ? h('span', { key: 'lok', className: 'mv-key-ok' }, '已生效')
              : null
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'lnote' },
            hostApi < 3
              ? '宿主半还是旧版本（重启 DSH 后这里才能分桶保存结束语库）。'
              : h(React.Fragment, { key: 'ln' }, '按 完成 / 出错 / 中止 三类分别配，随机并入对应内置池；每类最多 20 句、每句 40 字。想带称呼就直接写进句子里，写了就不再自动缀。')
          ),
          h('div', { className: 'mv-key-title', key: 't' }, 'MiMo API Key'),
          h(
            'div',
            { className: 'mv-key-row', key: 'row' },
            h('input', {
              key: 'input',
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: state.loading ? '读取中…' : '粘贴 MiMo API Key（tp-… 或 sk-…）',
              value: value,
              disabled: busy,
              onChange: function (event) { setValue(event.target.value) },
            }),
            h('button', { key: 'save', type: 'button', className: 'primary', disabled: busy || !value.trim(), onClick: function () { save(value.trim()) } }, '保存'),
            h('button', { key: 'clear', type: 'button', disabled: busy, onClick: function () { save('') } }, '清除')
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'note' },
            '当前来源：', source, hint, '。留空时按 config.apiKey → 环境变量 MIMO_API_KEY → ~/.dsh/.credentials.yaml 的顺序取用；Key 只在宿主进程使用，不会下发到浏览器。'
          ),
          note && note !== '音色已切换并生效' && note !== '称呼已保存并生效' && note !== '结束语库已保存并生效' && note !== '音量已保存并生效' && note !== '人设已保存并生效' && note !== '已恢复默认人设' && note !== '语种已保存并生效' && note !== '方言已保存并生效' && note !== '语速已保存并生效' && note !== '正在试听' ? h('div', { className: 'mv-key-warn', key: 'msg' }, note) : null
        )
      )
    }

    /** 宿主的 locale 服务；读不到就留 null，此时 pickText() 一律用中文（浏览器偏好只用于诊断）。 */
    const localeRef = { current: null }

    function readLocaleService(ctx) {
      try {
        if (ctx && typeof ctx.get === 'function') return ctx.get('locale') || null
      } catch {}
      try {
        if (ctx && ctx.locale) return ctx.locale
      } catch {}
      return null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        localeRef.current = readLocaleService(ctx)
        const slots = ctx.get ? ctx.get('slots') : ctx.slots
        if (!slots || typeof slots.register !== 'function') return

        // 对话页齿轮按钮的跳转通道：宿主 pluginNavigation（dsh 0.2.1+）可用才显示。
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['pluginNavigation'], function (scoped) {
              const nav = scoped && scoped.pluginNavigation
              if (nav && typeof nav.openBundle === 'function') {
                openBundleNav = function (name) {
                  try {
                    nav.openBundle(name)
                  } catch {}
                }
                navState.ready = true
                notifyNav()
              }
            })
          }
        } catch {}

        const registerButton = function () {
          return slots.register(
            { name: 'conversation.input.right', id: 'mimo-voice-report', order: 40 },
            VoiceReportButton
          )
        }
        const registerCard = function () {
          return slots.register(
            { name: 'shell.overlay', id: 'mimo-voice-report-avatar', order: 90 },
            VoiceAvatarCard
          )
        }
        const registerSettings = function () {
          return slots.register({ name: 'plugins.bundle.config', key: 'mimo-voice-report' }, KeySettings)
        }

        if (typeof slots.inject === 'function') {
          try {
            slots.inject('conversation.input.right', registerButton)
            slots.inject('shell.overlay', registerCard)
            slots.inject('plugins.bundle.config', registerSettings)
            return
          } catch {}
        }
        registerButton()
        registerCard()
      },
    }
  },
})

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
    const CLIENT_VERSION = '1.11.0'
    const spoken = new Set()

    // ——— 共享视图状态：按钮写、浮层读 ———
    const listeners = new Set()
    const view = { visible: false, phase: 'idle', text: '', shown: 0, leaving: false }
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

    function stopReveal() {
      if (revealRaf) {
        cancelAnimationFrame(revealRaf)
        revealRaf = 0
      }
    }

    /** 先播 240ms 离场动画，再真正卸载浮层。 */
    function beginLeave() {
      if (!view.visible || view.leaving) return
      emit({ leaving: true })
      clearTimeout(hideTimer)
      hideTimer = setTimeout(function () {
        stopReveal()
        emit({ visible: false, phase: 'idle', text: '', shown: 0, leaving: false })
      }, 250)
    }

    function hideCardSoon(ms) {
      clearTimeout(hideTimer)
      hideTimer = setTimeout(beginLeave, ms || 0)
    }

    function showCard(patch) {
      clearTimeout(hideTimer)
      emit(Object.assign({ visible: true, shown: 0, leaving: false }, patch))
    }

    /** 按音频播放进度推进逐字显现（timeupdate 只有 ~4Hz，这里用 rAF 平滑）。 */
    function startReveal(el, text) {
      stopReveal()
      const total = Array.from(text).length
      let last = -1
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
        if (shown !== last) {
          last = shown
          emit({ shown: shown })
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
        close: '关闭',
        avatarAlt: '鲸鱼娘',
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
        close: 'Close',
        avatarAlt: 'Whale girl',
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
      // 容器只管定位；入场动效放在立绘/气泡两个子元素上，气泡比立绘晚 90ms 弹出。
      '.mv-card{position:fixed;right:24px;bottom:112px;z-index:80;display:flex;align-items:flex-end;gap:12px;max-width:min(440px,calc(100vw - 48px));pointer-events:none}',
      '.mv-figure,.mv-bubble{animation:mv-rise .38s cubic-bezier(.18,.89,.32,1.18) both}',
      '.mv-bubble{animation-delay:.09s}',
      '.mv-card.is-leaving .mv-figure,.mv-card.is-leaving .mv-bubble{animation:mv-sink .24s ease forwards}',
      '@keyframes mv-rise{from{opacity:0;transform:translateY(16px) scale(.95)}to{opacity:1;transform:none}}',
      '@keyframes mv-sink{from{opacity:1;transform:none}to{opacity:0;transform:translateY(10px) scale(.97)}}',
      // 品牌色光晕：垫在卡片后面，准备/播放时最亮，播完慢慢暗下去。
      '.mv-glow{position:absolute;right:-30px;bottom:-34px;width:230px;height:190px;border-radius:50%;background:var(--dsw-alias-brand-primary);opacity:0;filter:blur(46px);pointer-events:none;z-index:-1;transition:opacity .5s ease}',
      '.mv-card.is-loading .mv-glow,.mv-card.is-playing .mv-glow{opacity:.28}',
      '.mv-card.is-done .mv-glow{opacity:.10}',
      // 立绘：圆角小卡 + 顶部高光 + 呼吸浮动（img 本身在窗口里轻轻上下）。
      '.mv-figure{position:relative;width:118px;height:154px;flex:0 0 auto;border-radius:18px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 16px 34px rgba(0,0,0,.32);pointer-events:auto;transition:border-color .3s ease}',
      '.mv-figure:before{content:"";position:absolute;inset:0;background:radial-gradient(130% 100% at 50% 0%,rgba(255,255,255,.16),transparent 55%);pointer-events:none;z-index:1}',
      '.mv-figure img{width:100%;height:100%;object-fit:contain;object-position:50% 100%;display:block;animation:mv-bob 3.8s ease-in-out infinite}',
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
      '.mv-card.is-blocked,.mv-card.is-error{animation:mv-shake .3s ease}',
      '@keyframes mv-shake{0%,100%{transform:none}25%{transform:translateX(-3px)}60%{transform:translateX(2px)}}',
      '@keyframes mv-blink{0%,100%{opacity:1}50%{opacity:0}}',
      // 动效敏感用户：全部换成纯淡入淡出，浮动/呼吸/抖动一律关掉。
      '@media (prefers-reduced-motion: reduce){.mv-figure,.mv-bubble{animation:mv-fade .18s ease both}.mv-card.is-leaving .mv-figure,.mv-card.is-leaving .mv-bubble{animation:mv-fadeout .18s ease forwards}.mv-figure img,.mv-c,.mv-card.is-blocked,.mv-card.is-error,.mv-dot,.mv-card.is-loading .mv-bar>i,.mv-caret{animation:none}}',
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
      if (forced) return forced === 'en' ? TEXT.en : TEXT.zh
      return /^en([-_]|$)/.test(hostLocale()) ? TEXT.en : TEXT.zh
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
          const el = ensureAudio(audio)
          let started = false
          el.onplaying = function () {
            if (started) return
            started = true
            if (!alive.current) return
            // 被自动播放拦下后靠用户手势补播时，浮层可能已在离场路上，这里重新亮出来。
            showCard({ phase: 'playing', text: text, shown: 0 })
            startReveal(el, text)
            report({ event: 'card-playing', sessionId: sessionId, chars: Array.from(text).length, duration: Math.round((el.duration || 0) * 100) / 100 })
          }
          el.onended = function () {
            stopReveal()
            emit({ phase: 'done', shown: Array.from(text).length })
            hideCardSoon(2800)
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
        return fetch('/mimo-voice/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, force: force === true }),
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
            setDetail(String(data.text || ''))
            showCard({ phase: 'loading', text: String(data.text || ''), shown: 0 })
            return play(data)
          })
          .catch(function (error) {
            if (!alive.current) return
            setStatus('error')
            setDetail(String((error && error.message) || error))
            emit({ phase: 'error', text: String((error && error.message) || '语音汇报失败') })
            hideCardSoon(4500)
            report({ event: 'report-error', sessionId: sessionId, message: String((error && error.message) || error) })
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
        )
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

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CARD_CSS),
        h(
          'div',
          {
            key: 'card',
            className: 'mv-card is-' + v.phase + (v.leaving ? ' is-leaving' : ''),
            role: 'status',
            'aria-live': 'polite',
            'aria-label': v.phase === 'loading' || !full ? L.preparing : full,
          },
          h('div', { className: 'mv-glow', key: 'glow', 'aria-hidden': true }),
          avatarOk
            ? h(
                'div',
                { className: 'mv-figure', key: 'figure' },
                h('img', {
                  src: '/mimo-voice/avatar',
                  alt: L.avatarAlt,
                  draggable: false,
                  onError: function () {
                    setAvatarOk(false)
                    report({ event: 'avatar-failed' })
                  },
                })
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
              v.phase === 'playing' ? h('span', { className: 'mv-caret', key: 'caret' }) : null
            ),
            h('div', { className: 'mv-bar', key: 'bar', 'aria-hidden': true }, h('i', { key: 'fill', style: v.phase === 'loading' ? undefined : { width: pct + '%' } })),
            h(
              'div',
              { className: 'mv-meta', key: 'meta' },
              h('span', { className: 'mv-dot', key: 'dot' }),
              v.phase === 'blocked' ? L.blockedMeta : L.cardMeta
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
      '.mv-key-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mv-key-textarea{width:100%;min-height:66px;max-height:150px;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;outline:none;resize:vertical;box-sizing:border-box}',
      '.mv-key-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.mv-key-textarea:disabled{opacity:.55}',
      '.mv-key-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.mv-key-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.mv-key-check:has(input:disabled){cursor:default;opacity:.7}',
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
      // /config 的能力标记：2 = 支持结束语库（customAnnounces / customOnly）。
      const [hostApi, setHostApi] = React.useState(0)
      const [lines, setLines] = React.useState('')
      const [savedLines, setSavedLines] = React.useState(0)
      const [onlyMine, setOnlyMine] = React.useState(false)
      const [value, setValue] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      function load() {
        fetch('/mimo-voice/config')
          .then(function (response) { return response.json() })
          .then(function (data) {
            setState({ loading: false, keySource: String(data.keySource || ''), keyHint: String(data.keyHint || '') })
            const v = (data && data.voice) || {}
            setVoice({ sample: String(v.sample || ''), presets: Array.isArray(v.presets) ? v.presets : [] })
            const p = (data && data.persona) || {}
            setCallMe(String(p.callMe || ''))
            setHostOld(!data || !data.persona)
            setHostApi(Number(data && data.api) || 0)
            const custom = Array.isArray(p.customAnnounces) ? p.customAnnounces : []
            setLines(custom.join('\n'))
            setSavedLines(custom.length)
            setOnlyMine(p.customOnly === true)
          })
          .catch(function (error) {
            setState({ loading: false, keySource: 'error', keyHint: '' })
            setNote(String((error && error.message) || error))
          })
      }

      React.useEffect(load, [])

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
            setNote('音色已切换并生效')
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
        const list = lines.split(/\n+/).map(function (s) { return s.trim() }).filter(Boolean)
        setBusy(true)
        setNote('')
        fetch('/mimo-voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ customAnnounces: list, customOnly: onlyMine }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setNote(String((data && data.message) || '保存失败'))
              return
            }
            const p = (data && data.persona) || {}
            const custom = Array.isArray(p.customAnnounces) ? p.customAnnounces : list
            setLines(custom.join('\n'))
            setSavedLines(custom.length)
            setOnlyMine(p.customOnly === true)
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
            note === '音色已切换并生效'
              ? h('span', { key: 'vok', className: 'mv-key-ok' }, '已切换')
              : null
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'vnote' },
            '切换后立即生效（写回本插件 config.voiceSample）。想加新音色：把 5–15 秒的 mp3/wav 丢进插件目录即可出现在这里。'
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
          h('textarea', {
            key: 'ltext',
            className: 'mv-key-textarea',
            rows: 3,
            maxLength: 900,
            spellCheck: false,
            placeholder: state.loading ? '读取中…' : '一行一句，随机用于「任务完成」的开场；留空用内置款。如：\n鱼干已备好，请查收。\n这一网打满了。',
            value: lines,
            disabled: busy || hostApi < 2,
            onChange: function (event) { setLines(event.target.value) },
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
                disabled: busy || hostApi < 2,
                onChange: function (event) { setOnlyMine(event.target.checked) },
              }),
              '只用我写的，不掺内置款'
            ),
            h('span', { key: 'lfill', style: { flex: '1 1 auto' } }),
            h('button', { key: 'lsave', type: 'button', className: 'primary', disabled: busy || hostApi < 2, onClick: saveLines }, '保存'),
            note === '结束语库已保存并生效'
              ? h('span', { key: 'lok', className: 'mv-key-ok' }, '已生效')
              : null
          ),
          h(
            'div',
            { className: 'mv-key-note', key: 'lnote' },
            hostApi < 2
              ? '宿主半还是旧版本（重启 DSH 后这里才能保存结束语库）。'
              : h(React.Fragment, { key: 'ln' }, '只作用于「任务完成」的开场；最多 20 句、每句 40 字。当前自定义 ', String(savedLines), ' 句', onlyMine ? '（只用自定义）' : '', '。想带称呼就直接写进句子里，写了就不再自动缀。')
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
          note && note !== '音色已切换并生效' && note !== '称呼已保存并生效' && note !== '结束语库已保存并生效' ? h('div', { className: 'mv-key-warn', key: 'msg' }, note) : null
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

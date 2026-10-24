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
    const CLIENT_VERSION = '1.9.1'
    const spoken = new Set()

    // ——— 共享视图状态：按钮写、浮层读 ———
    const listeners = new Set()
    const view = { visible: false, phase: 'idle', text: '', shown: 0 }
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

    function hideCardSoon(ms) {
      clearTimeout(hideTimer)
      hideTimer = setTimeout(function () {
        stopReveal()
        emit({ visible: false, phase: 'idle', text: '', shown: 0 })
      }, ms || 0)
    }

    function showCard(patch) {
      clearTimeout(hideTimer)
      emit(Object.assign({ visible: true, shown: 0 }, patch))
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
      '.mv-card{position:fixed;right:24px;bottom:112px;z-index:80;display:flex;align-items:flex-end;gap:10px;max-width:min(430px,calc(100vw - 48px));pointer-events:none;animation:mv-card-in .22s cubic-bezier(.2,.9,.3,1.2)}',
      '@keyframes mv-card-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}',
      '.mv-figure{width:112px;height:148px;flex:0 0 auto;border-radius:14px;overflow:hidden;background:#f7f9ff;border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 26px rgba(0,0,0,.28);pointer-events:auto}',
      '.mv-figure img{width:100%;height:100%;object-fit:contain;object-position:50% 50%;display:block}',
      '.mv-bubble{position:relative;min-width:140px;max-width:280px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:11px 30px 9px 13px;box-shadow:0 12px 30px rgba(0,0,0,.24);pointer-events:auto}',
      '.mv-bubble:after{content:"";position:absolute;left:-6px;bottom:16px;width:12px;height:12px;background:var(--dsw-alias-bg-overlay);border-left:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);transform:rotate(45deg);border-bottom-left-radius:3px}',
      '.mv-text{font-size:13.5px;line-height:1.68;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}',
      '.mv-caret{display:inline-block;width:2px;height:1em;margin-left:1px;vertical-align:-2px;background:currentColor;animation:mv-blink 1s steps(2,start) infinite}',
      '.mv-dim{color:var(--dsw-alias-label-secondary)}',
      '.mv-meta{margin-top:5px;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85}',
      '.mv-close{position:absolute;top:5px;right:5px;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer}',
      '.mv-close:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.mv-card.is-blocked .mv-meta,.mv-card.is-error .mv-meta{color:var(--dsw-alias-state-warn-primary)}',
      '@keyframes mv-blink{0%,100%{opacity:1}50%{opacity:0}}',
      '@media (prefers-reduced-motion: reduce){.mv-card{animation:none}}',
      '@media (max-width:720px){.mv-card{right:14px;bottom:96px;gap:8px}.mv-figure{width:88px;height:116px}.mv-bubble{max-width:calc(100vw - 150px)}}',
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

    function resolveText(ctx) {
      let id = ''
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        const snapshot = locale && (locale.getSnapshot ? locale.getSnapshot() : locale.getLocale ? locale.getLocale() : undefined)
        if (snapshot) id = String(snapshot.locale || snapshot.id || snapshot.current || '')
      } catch {}
      if (!id) {
        try {
          id = String(document.documentElement.lang || navigator.language || '')
        } catch {}
      }
      return id.toLowerCase().indexOf('en') === 0 ? TEXT.en : TEXT.zh
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
      const L = textRef.current
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
        report({ event: 'mounted', v: CLIENT_VERSION, sessionId: sessionId, enabled: readEnabled(), hasAudio: typeof Audio !== 'undefined' })
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
            // 被自动播放拦下后靠用户手势补播时，浮层可能已经收起，这里重新亮出来。
            emit({ visible: true, phase: 'playing', text: text, shown: 0 })
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
                emit({ visible: false })
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
              emit({ visible: false })
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
          emit({ visible: false })
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
      const L = textRef.current
      const [avatarOk, setAvatarOk] = React.useState(true)
      if (!v.visible) return null

      const full = String(v.text || '')
      const total = Array.from(full).length
      const shownCount = v.phase === 'playing' ? Math.min(total, v.shown) : v.phase === 'loading' ? 0 : total
      const shownText = Array.from(full).slice(0, Math.max(0, shownCount)).join('')

      function close() {
        stopReveal()
        try {
          if (currentAudio) currentAudio.pause()
        } catch {}
        clearTimeout(hideTimer)
        emit({ visible: false, phase: 'idle', text: '', shown: 0 })
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CARD_CSS),
        h(
          'div',
          { key: 'card', className: 'mv-card is-' + v.phase, role: 'status', 'aria-live': 'polite' },
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
              { className: 'mv-text', key: 'text' },
              v.phase === 'loading'
                ? h('span', { className: 'mv-dim' }, L.preparing)
                : shownText,
              v.phase === 'playing' ? h('span', { className: 'mv-caret', key: 'caret' }) : null
            ),
            h('div', { className: 'mv-meta', key: 'meta' }, v.phase === 'blocked' ? L.blockedMeta : L.cardMeta)
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
      '.mv-key-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
    ].join('\n')

    /** 插件详情页里的 "MiMo API Key" 配置卡：写入本插件 config.apiKey，空值则回落到环境变量/凭据库。 */
    function KeySettings(props) {
      const isSummary = Boolean(props && props.view === 'summary')
      const [state, setState] = React.useState({ loading: true, keySource: '', keyHint: '' })
      const [value, setValue] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      function load() {
        fetch('/mimo-voice/config')
          .then(function (response) { return response.json() })
          .then(function (data) {
            setState({ loading: false, keySource: String(data.keySource || ''), keyHint: String(data.keyHint || '') })
          })
          .catch(function (error) {
            setState({ loading: false, keySource: 'error', keyHint: '' })
            setNote(String((error && error.message) || error))
          })
      }

      React.useEffect(load, [])

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
          'API Key 来源：',
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
          note ? h('div', { className: 'mv-key-warn', key: 'msg' }, note) : null
        )
      )
    }

    const textRef = { current: TEXT.zh }

    return {
      inject: ['slots'],
      apply(ctx) {
        textRef.current = resolveText(ctx)
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

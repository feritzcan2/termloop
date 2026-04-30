export function getTerminalHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.css" />
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0/lib/addon-web-links.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #282a36; touch-action: none; -webkit-user-select: none; user-select: none; }
    #terminal { width: 100%; height: 100%; }
    .xterm { height: 100%; }
    .xterm-viewport { overflow: hidden !important; }
    #mode-indicator {
      position: absolute; top: 4px; right: 8px;
      padding: 2px 8px; border-radius: 10px;
      font: 11px -apple-system, system-ui, sans-serif;
      color: #282a36; background: #50fa7b;
      pointer-events: none; opacity: 0;
      transition: opacity 120ms linear;
      z-index: 10;
    }
    #mode-indicator.visible { opacity: 0.95; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <div id="mode-indicator">SELECT</div>
  <script>
    const term = new window.Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      allowProposedApi: true,
      scrollback: 100000,
      scrollOnUserInput: true,
    });

    const fitAddon = new window.FitAddon.FitAddon();
    const webLinksAddon = new window.WebLinksAddon.WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    const terminalEl = document.getElementById('terminal');
    term.open(terminalEl);
    fitAddon.fit();

    // Suppress automatic Device Attributes (DA) responses. xterm.js would
    // otherwise answer every CSI c / CSI >c / CSI ?c with its version string,
    // which inside tmux gets echoed back through the PTY and re-parsed as a
    // new DA query — an infinite feedback loop that floods the pane with
    // "[;0;276;0c" garbage. Modern shells and tmux rely on TERMINFO (TERM
    // env var), not DA queries, so silencing the response is safe.
    term.parser.registerCsiHandler({ final: 'c' }, () => true);
    term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => true);
    term.parser.registerCsiHandler({ prefix: '?', final: 'c' }, () => true);

    // Mode: 'scroll' = pan to scrollback; 'select' = pan to extend selection
    let mode = 'scroll';
    const indicator = document.getElementById('mode-indicator');

    function setMode(next) {
      mode = next;
      if (mode === 'select') {
        indicator.classList.add('visible');
        cancelMomentum();
        // Hand control to iOS's native text selection: long-press inside the
        // terminal div brings up selection handles + system Copy menu, which
        // writes straight to the iPhone clipboard. This is more reliable than
        // xterm.js's own select() which can fail to render across rows.
        terminalEl.style.webkitUserSelect = 'text';
        terminalEl.style.userSelect = 'text';
        terminalEl.style.touchAction = 'auto';
        terminalEl.style.webkitTouchCallout = 'default';
      } else {
        indicator.classList.remove('visible');
        term.clearSelection();
        terminalEl.style.webkitUserSelect = 'none';
        terminalEl.style.userSelect = 'none';
        terminalEl.style.touchAction = 'none';
        terminalEl.style.webkitTouchCallout = 'none';
      }
    }

    // ---- cell dimension helpers ----
    function getCellDims() {
      const rect = terminalEl.getBoundingClientRect();
      return {
        w: rect.width / Math.max(term.cols, 1),
        h: rect.height / Math.max(term.rows, 1),
      };
    }

    function pointToCell(clientX, clientY) {
      const rect = terminalEl.getBoundingClientRect();
      const { w, h } = getCellDims();
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor((clientX - rect.left) / w)));
      const vRow = Math.max(0, Math.min(term.rows - 1, Math.floor((clientY - rect.top) / h)));
      const absRow = term.buffer.active.viewportY + vRow;
      return { col: col, row: absRow };
    }

    // ---- scroll momentum ----
    let momentumRaf = null;
    function cancelMomentum() {
      if (momentumRaf !== null) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = null;
      }
    }

    // ---- touch state machine ----
    let touch = null;
    const DRAG_THRESHOLD = 4; // px before we consume the gesture
    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    const DOUBLE_TAP_MS = 300;
    const DOUBLE_TAP_DIST = 30; // px

    function onTouchStart(e) {
      // In select mode, fall through to the native iOS selection gesture.
      if (mode === 'select') { touch = null; return; }
      if (e.touches.length !== 1) { touch = null; return; }
      cancelMomentum();
      const t = e.touches[0];
      touch = {
        startX: t.clientX,
        startY: t.clientY,
        lastX: t.clientX,
        lastY: t.clientY,
        lastT: performance.now(),
        vy: 0,
        moved: false,
        accum: 0,
        startedAt: performance.now(),
        startCell: null,
      };
    }

    function onTouchMove(e) {
      if (mode === 'select') return; // native iOS selection
      if (!touch || e.touches.length !== 1) return;
      const t = e.touches[0];
      const now = performance.now();
      const dy = t.clientY - touch.lastY;

      if (!touch.moved) {
        const totalDx = t.clientX - touch.startX;
        const totalDy = t.clientY - touch.startY;
        if (Math.abs(totalDx) + Math.abs(totalDy) > DRAG_THRESHOLD) {
          touch.moved = true;
        }
      }
      if (!touch.moved) return;

      e.preventDefault();

      const { h } = getCellDims();
      touch.accum += -dy / h;
      const whole = touch.accum >= 0 ? Math.floor(touch.accum) : Math.ceil(touch.accum);
      if (whole !== 0) {
        term.scrollLines(whole);
        touch.accum -= whole;
      }
      const dt = Math.max(now - touch.lastT, 1);
      touch.vy = 0.6 * touch.vy + 0.4 * (dy / dt);

      touch.lastX = t.clientX;
      touch.lastY = t.clientY;
      touch.lastT = now;
    }

    function onTouchEnd() {
      if (mode === 'select') { touch = null; return; } // native iOS selection
      if (!touch) return;
      const wasMoved = touch.moved;
      const startVy = touch.vy;
      const endX = touch.lastX;
      const endY = touch.lastY;
      const tapDuration = performance.now() - touch.startedAt;
      touch = null;

      if (!wasMoved) {
        // Tap (no drag). Check for double-tap → toggle keyboard.
        const now = performance.now();
        const dt = now - lastTapAt;
        const dx = Math.abs(endX - lastTapX);
        const dy = Math.abs(endY - lastTapY);
        if (dt < DOUBLE_TAP_MS && dx < DOUBLE_TAP_DIST && dy < DOUBLE_TAP_DIST && tapDuration < 250) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'doubleTap' }));
          lastTapAt = 0; // consume — don't trigger triple-tap
          return;
        }
        lastTapAt = now;
        lastTapX = endX;
        lastTapY = endY;
        return;
      }

      const { h } = getCellDims();
      let vLines = -startVy / h; // lines per ms (positive = scroll down)
      if (Math.abs(vLines) < 0.002) return;
      let lastTick = performance.now();
      let remainder = 0;
      const tick = (now) => {
        const dt = now - lastTick;
        lastTick = now;
        remainder += vLines * dt;
        const whole = remainder >= 0 ? Math.floor(remainder) : Math.ceil(remainder);
        if (whole !== 0) {
          term.scrollLines(whole);
          remainder -= whole;
        }
        vLines *= Math.pow(0.94, dt / 16);
        if (Math.abs(vLines) > 0.0005) {
          momentumRaf = requestAnimationFrame(tick);
        } else {
          momentumRaf = null;
        }
      };
      momentumRaf = requestAnimationFrame(tick);
    }

    document.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });

    // Clipboard helpers — use Async Clipboard API when available, fallback to execCommand.
    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => copyViaExec(text));
      }
      return Promise.resolve(copyViaExec(text));
    }
    function copyViaExec(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch { return false; }
    }
    function readClipboard() {
      if (navigator.clipboard && navigator.clipboard.readText) {
        return navigator.clipboard.readText().catch(() => '');
      }
      return Promise.resolve('');
    }

    // Send typed data to React Native
    term.onData((data) => {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'data',
        payload: data,
      }));
    });

    term.onTitleChange((title) => {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'title',
        payload: title,
      }));
    });

    term.onBell(() => {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'bell',
      }));
    });

    let ctrlActive = false;

    // Listen on window only — TerminalView dispatches to window only. Listening
    // on both window AND document fires the handler twice for every message
    // (duplicate term.write → "ramsie" rendered as "ramamsie").
    window.addEventListener('message', (event) => { handleMessage(event.data); });

    function handleMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'write':
          term.write(msg.payload);
          break;
        case 'input':
          term.write(msg.payload);
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'data',
            payload: msg.payload,
          }));
          break;
        case 'ctrl':
          ctrlActive = msg.active;
          break;
        case 'resize':
          term.resize(msg.cols, msg.rows);
          fitAddon.fit();
          break;
        case 'theme':
          term.options.theme = msg.payload;
          break;
        case 'fontSize':
          term.options.fontSize = msg.payload;
          fitAddon.fit();
          notifySize();
          break;
        case 'setMode':
          setMode(msg.payload === 'select' ? 'select' : 'scroll');
          break;
        case 'refit':
          fitAddon.fit();
          notifySize();
          break;
        case 'scrollLines':
          cancelMomentum();
          term.scrollLines(msg.payload | 0);
          break;
        case 'clearSelection':
          term.clearSelection();
          break;
        case 'paste':
          readClipboard().then((text) => {
            if (text && text.length > 0) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'data',
                payload: text,
              }));
            }
          });
          break;
        case 'focusInput':
          term.focus();
          break;
      }
    }

    function notifySize() {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'resize',
        cols: term.cols,
        rows: term.rows,
      }));
    }

    term.attachCustomKeyEventHandler((event) => {
      if (ctrlActive && event.type === 'keydown' && event.key.length === 1) {
        const code = event.key.toUpperCase().charCodeAt(0) - 64;
        if (code > 0 && code < 27) {
          const ctrlChar = String.fromCharCode(code);
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'data',
            payload: ctrlChar,
          }));
          ctrlActive = false;
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'ctrlConsumed',
          }));
          return false;
        }
      }
      return true;
    });

    window.addEventListener('resize', () => {
      fitAddon.fit();
      notifySize();
    });

    setTimeout(() => {
      fitAddon.fit();
      notifySize();
    }, 100);

    term.write('Terminal ready.\\r\\n');
  </script>
</body>
</html>`;
}

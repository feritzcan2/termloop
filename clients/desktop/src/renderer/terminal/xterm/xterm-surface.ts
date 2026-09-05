import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./ghostty-font.css";
import type { TerminalBufferProbe, TerminalSurface } from "../surface.js";
import { clipboardKeyDecision } from "./clipboard.js";
import { sgrWheelReports, wheelToArrowLines } from "./wheel.js";
import type { AppearanceTheme } from "../../appearance-theme.js";

let liveWebglContexts = 0;
let webglContextsCreated = 0;
let webglContextsDisposed = 0;
let mountCalls = 0;
let unmountCalls = 0;

const GHOSTTY_FONT_FAMILY = '"JetBrains Mono", "SFMono-Regular", Menlo, monospace';
const ghosttyFontReady = "fonts" in document
  ? Promise.all([
      document.fonts.load(`350 13px ${GHOSTTY_FONT_FAMILY}`),
      document.fonts.load(`600 13px ${GHOSTTY_FONT_FAMILY}`),
      document.fonts.load(`italic 350 13px ${GHOSTTY_FONT_FAMILY}`),
      document.fonts.load(`italic 600 13px ${GHOSTTY_FONT_FAMILY}`),
    ]).catch(() => [])
  : Promise.resolve([]);

export function terminalThemeForAppearance(theme: AppearanceTheme) {
  return theme === "light" ? {
    background: "#f9f9f9",
    foreground: "#2a2c33",
    cursor: "#555963",
    cursorAccent: "#ffffff",
    selectionBackground: "#d9ddf2",
    selectionForeground: "#20222a",
    black: "#000000",
    red: "#de3e35",
    green: "#3f953a",
    yellow: "#9a6c16",
    blue: "#2f5af3",
    magenta: "#950095",
    cyan: "#197a73",
    white: "#bbbbbb",
    brightBlack: "#5d626b",
    brightRed: "#c9342d",
    brightGreen: "#327b2e",
    brightYellow: "#7c5812",
    brightBlue: "#244bd5",
    brightMagenta: "#7f007f",
    brightCyan: "#14645f",
    brightWhite: "#ffffff",
  } : {
    background: "#282c34",
    foreground: "#d8dce3",
    cursor: "#ffffff",
    cursorAccent: "#282c34",
    selectionBackground: "#ffffff",
    selectionForeground: "#282c34",
    black: "#1d1f21",
    red: "#cc6666",
    green: "#b5bd68",
    yellow: "#f0c674",
    blue: "#81a2be",
    magenta: "#b294bb",
    cyan: "#8abeb7",
    white: "#c5c8c6",
    brightBlack: "#666666",
    brightRed: "#d54e53",
    brightGreen: "#b9ca4a",
    brightYellow: "#e7c547",
    brightBlue: "#7aa6da",
    brightMagenta: "#c397d8",
    brightCyan: "#70c0b1",
    brightWhite: "#eaeaea",
  };
}

export class XtermSurface implements TerminalSurface {
  readonly #terminal: Terminal;
  readonly #fit = new FitAddon();
  readonly #host = document.createElement("div");
  #webgl: WebglAddon | undefined;
  #opened = false;
  #resizeObserver: ResizeObserver | undefined;
  #wheelRemainder = 0;

  constructor(
    onInput: (data: string) => void,
    onResize: (rows: number, cols: number) => void,
    onImagePaste: () => void,
  ) {
    // Distinct from the sidebar's `.session-item.terminal` kind modifier, which
    // otherwise matches the same bare `.terminal` selector and inherits the
    // terminal surface colour.
    this.#host.className = "terminal-surface";
    // Ghostty's built-in defaults, read from the vendored source: background,
    // the sixteen named entries from `Name.default` in `src/terminal/color.zig`,
    // block cursor, and the unconfigured selection which Ghostty renders as
    // foreground-on-background. Two deliberate deviations for readability:
    // Chromium's canvas rasterises the glyph atlas with macOS stem darkening,
    // so Ghostty's #ffffff foreground at Regular weight reads as glaring, thick
    // text next to a native terminal. The foreground is softened below and the
    // body weight sits under Regular on the variable font to compensate; bold
    // drops to 600 for the same reason.
    this.#terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: GHOSTTY_FONT_FAMILY,
      fontSize: 13,
      fontWeight: 350,
      fontWeightBold: 600,
      lineHeight: 1,
      scrollback: 2_000,
      // Opaque: the theme background below is solid, and transparency makes
      // xterm leave `.xterm-viewport` on the `#000` its own stylesheet sets,
      // which then shows through as a black frame around the inset grid.
      allowTransparency: false,
      // The theme below only names the sixteen ANSI entries; the 256-color
      // grey ramp (indices 232–255) stays at xterm defaults, and its low end
      // sits at or below this background's luminance. Claude Code paints most
      // secondary text from that ramp, so without a floor it renders
      // near-invisible. 3:1 nudges only foregrounds that fall below it and
      // leaves compliant colors untouched.
      minimumContrastRatio: 3,
      // No overviewRuler: any truthy width instantiates xterm's
      // OverviewRulerRenderer, which repaints its (stylesheet-hidden) canvas on
      // every normal-buffer scroll and forces a clientHeight layout read on
      // every rendered frame. The cost of leaving it out is the fit addon
      // reserving its default 14px scrollbar band as a dead gutter beside the
      // last column; reclaiming that band means replacing fit-addon sizing,
      // which is a separate slice.
      theme: terminalThemeForAppearance("dark"),
    });
    this.#terminal.loadAddon(this.#fit);
    this.#host.addEventListener("paste", (event) => {
      if (event.clipboardData?.getData("text/plain")) return;
      if (![...(event.clipboardData?.items ?? [])]
        .some((item) => item.kind === "file" && item.type.startsWith("image/"))) return;
      event.preventDefault();
      event.stopPropagation();
      onImagePaste();
    }, true);
    this.#terminal.attachCustomKeyEventHandler((event) => {
      // Explicit Ctrl+Shift+V paste / Ctrl+Shift+C copy for the xterm path
      // (Windows/Linux). `term.paste` preserves bracketed-paste semantics.
      // Plain Ctrl+V stays untouched so terminal apps still receive ^V.
      // The renderer's Chromium async clipboard is the smallest correct
      // path here: no permission handler is installed in main, so the
      // sandboxed renderer's user-gesture read/write is granted.
      const decision = clipboardKeyDecision(event, this.#terminal.hasSelection());
      if (!decision.handled) return true;
      event.preventDefault();
      if (decision.action === "paste") {
        void (async () => {
          const text = await navigator.clipboard.readText().catch(() => "");
          if (text.length > 0) {
            this.#terminal.paste(text);
            return;
          }
          const items = await navigator.clipboard.read().catch(() => []);
          if (items.some((item) => item.types.some((type) => type.startsWith("image/")))) {
            onImagePaste();
          }
        })();
      } else if (decision.action === "copy") {
        void navigator.clipboard.writeText(this.#terminal.getSelection()).catch(() => {});
      }
      return false;
    });
    this.#terminal.onData(onInput);
    this.#terminal.onResize(({ rows, cols }) => onResize(rows, cols));
    this.#terminal.attachCustomWheelEventHandler((event) => {
      // Only the alternate screen needs help: xterm's own wheel forwarding
      // quantises to roughly one step per ~100px and drops sub-line trackpad
      // deltas, so full-screen TUIs crawl. The normal buffer scrolls its own
      // scrollback and keeps default handling, as does press-only X10 tracking
      // (it has no wheel vocabulary at all).
      if (event.type !== "wheel" || this.#terminal.buffer.active.type !== "alternate") {
        return true;
      }
      const tracking = this.#terminal.modes.mouseTrackingMode;
      if (tracking === "x10") return true;
      const rows = this.#terminal.rows;
      const cellHeight = this.#host.clientHeight > 0 && rows > 0
        ? this.#host.clientHeight / rows
        : 16;
      const { lines, remainder } = wheelToArrowLines(
        event.deltaY,
        event.deltaMode,
        cellHeight,
        this.#wheelRemainder,
      );
      this.#wheelRemainder = remainder;
      if (lines !== 0 && tracking !== "none") {
        // Wheel-tracking TUIs (Claude Code sets 1003+1006) take SGR reports at
        // the pointer cell, one per line.
        const rect = this.#host.getBoundingClientRect();
        const cellWidth = this.#host.clientWidth > 0 && this.#terminal.cols > 0
          ? this.#host.clientWidth / this.#terminal.cols
          : 8;
        const column = Math.min(this.#terminal.cols, Math.floor((event.clientX - rect.left) / cellWidth) + 1);
        const row = Math.min(rows, Math.floor((event.clientY - rect.top) / cellHeight) + 1);
        onInput(sgrWheelReports(lines, column, row));
      } else if (lines !== 0) {
        const sequence = (this.#terminal.modes.applicationCursorKeysMode ? "O" : "[")
          + (lines < 0 ? "A" : "B");
        onInput(sequence.repeat(Math.abs(lines)));
      }
      return false;
    });
    this.#host.addEventListener("mousedown", () => this.#terminal.focus());
    void ghosttyFontReady.then(() => {
      if (!this.#opened) return;
      this.#terminal.clearTextureAtlas();
      this.#terminal.refresh(0, this.#terminal.rows - 1);
      this.#fitIfVisible();
    });
  }

  setAppearanceTheme(theme: AppearanceTheme): void {
    this.#terminal.options.theme = terminalThemeForAppearance(theme);
  }

  mount(container: HTMLElement, preferWebgl: boolean): void {
    mountCalls += 1;
    if (!this.#opened) {
      this.#terminal.open(this.#host);
      this.#opened = true;
    }
    container.append(this.#host);
    // Before any byte is written: the terminal opens at xterm's default 80x24
    // and the daemon takes the reported grid as the PTY size, so fitting only
    // on the next frame lets a Session's first output be laid out for a width
    // the pane does not have and then reflow when the real grid arrives.
    this.#fitIfVisible();
    if (preferWebgl && !this.#webgl && liveWebglContexts < 4) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => this.#disposeWebgl());
        this.#terminal.loadAddon(addon);
        this.#webgl = addon;
        liveWebglContexts += 1;
        webglContextsCreated += 1;
      } catch {
        this.#disposeWebgl();
      }
    }
    this.#resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => this.#fitIfVisible()));
    this.#resizeObserver.observe(container);
    requestAnimationFrame(() => this.#fitIfVisible());
  }

  unmount(): void {
    unmountCalls += 1;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#disposeWebgl();
    this.#host.remove();
  }

  write(data: Uint8Array, callback: () => void): void {
    this.#terminal.write(data, callback);
  }

  writeln(message: string): void {
    this.#terminal.writeln(`\r\n${message}\r\n`);
  }

  focus(): void {
    this.#terminal.focus();
  }

  probe(): TerminalBufferProbe {
    const buffer = this.#terminal.buffer.active;
    const start = Math.max(0, buffer.length - 200);
    const text: string[] = [];
    for (let index = start; index < buffer.length; index += 1) {
      text.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return {
      lines: buffer.length,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      text: text.join("\n"),
      bufferType: buffer.type,
      mouseTrackingMode: this.#terminal.modes.mouseTrackingMode,
    };
  }

  dispose(): void {
    this.unmount();
    this.#terminal.dispose();
  }

  #fitIfVisible(): void {
    if (this.#host.isConnected && this.#host.clientWidth > 0 && this.#host.clientHeight > 0) {
      this.#fit.fit();
    }
  }

  #disposeWebgl(): void {
    if (!this.#webgl) return;
    this.#webgl.dispose();
    this.#webgl = undefined;
    liveWebglContexts = Math.max(0, liveWebglContexts - 1);
    webglContextsDisposed += 1;
  }
}

export function xtermRendererMetrics(): {
  liveWebglContexts: number;
  webglContextsCreated: number;
  webglContextsDisposed: number;
  mountCalls: number;
  unmountCalls: number;
} {
  return {
    liveWebglContexts,
    webglContextsCreated,
    webglContextsDisposed,
    mountCalls,
    unmountCalls,
  };
}

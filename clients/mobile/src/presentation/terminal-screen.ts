import { color } from "../theme/tokens";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/// Where the grid starts before the stream says otherwise. Not a claim about the
/// Mac's terminal: 80×24 is only the POSIX default the PTY was opened with.
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/// Bounds, not geometry. The phone never learns the real PTY size — it must not send
/// a resize, and the daemon's attach ack carries no dimensions — so the grid grows to
/// whatever the stream actually addresses and stops where memory and the render tree
/// stop being free.
export const SCREEN_MAX_COLUMNS = 320;
/// How much of a streaming agent transcript the phone keeps.
///
/// This is scrollback, not screen size. A program that streams rather than repainting a
/// fixed frame has no history of its own to scroll — the terminal is what holds it, and
/// on this client that is the grid below. So the bound is what decides how far back a
/// reader can go, and setting it near a screen height meant throwing away output the
/// daemon had already delivered.
///
/// The list is not virtualised, so this trades directly against scroll smoothness:
/// every retained row is a live text node. The 4,800-row owner-mobile budget favors
/// late review of long Codex turns; measure a real device before raising it again.
export const SCREEN_MAX_ROWS = 4800;

const DEFAULT_FOREGROUND = color.text;
const DEFAULT_BACKGROUND = color.bgTerminal;

/// The 16 ANSI slots, sized for `bgTerminal` rather than for a white terminal. Slot 0
/// is lifted well off black: a TUI that paints "black" text would otherwise write
/// invisible characters onto a dark surface, which reads as missing output.
const ANSI_16 = [
  "#5c6370", "#e06c75", "#98c379", "#d19a66",
  "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
  "#7f848e", "#ff7b86", "#b6e3a0", "#e5c07b",
  "#82c8ff", "#e39ef7", "#71d3e0", "#e6e6e6",
] as const;

const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

/// One run of identically styled cells. The view renders spans, not cells, so a
/// mostly-uniform line costs a handful of text nodes instead of one per column.
export interface TerminalStyle {
  readonly foreground: string;
  readonly background: string | undefined;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

export interface TerminalSpan {
  readonly text: string;
  readonly style: TerminalStyle;
}

export interface TerminalScreenLine {
  /// Stable across redraws and across scrolls, so a list key follows its row instead
  /// of following a position. Index keys would re-render every row each time the
  /// screen scrolls by one.
  readonly id: number;
  readonly spans: readonly TerminalSpan[];
}

export interface TerminalScreenSnapshot {
  readonly lines: readonly TerminalScreenLine[];
  readonly droppedLines: number;
}

/// What the running program asked for in mouse reporting.
///
/// `unknown` is the honest starting value and, on this client, the common one: the
/// enable sequence is sent once at launch and the daemon replays only a bounded ring of
/// recent bytes, so a phone attaching to a session already in progress has never seen
/// it. It is deliberately distinct from `none` — "never told" and "told no" license
/// different behaviour, and treating the first as the second would send a wheel report
/// to a program that would read it as text or as commands.
export type TerminalMouseTracking = "unknown" | "none" | "x10" | "normal" | "button" | "any";

/// Styles are interned so a cell holds a shared reference and the view can compare
/// them by identity. A redraw-heavy TUI reuses a handful of styles per frame.
const styleCache = new Map<string, TerminalStyle>();

function internStyle(candidate: TerminalStyle): TerminalStyle {
  const key = `${candidate.foreground}|${candidate.background ?? ""}|${candidate.bold ? 1 : 0}${candidate.italic ? 1 : 0}${candidate.underline ? 1 : 0}`;
  const existing = styleCache.get(key);
  if (existing !== undefined) return existing;
  /// A truecolor stream could mint styles without bound. The cache is only a render
  /// optimisation, so dropping it wholesale is always safe.
  if (styleCache.size > 1024) styleCache.clear();
  styleCache.set(key, candidate);
  return candidate;
}

export const DEFAULT_TERMINAL_STYLE = internStyle({
  foreground: DEFAULT_FOREGROUND,
  background: undefined,
  bold: false,
  italic: false,
  underline: false,
});

function rgbHex(red: number, green: number, blue: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function paletteColor(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return ANSI_16[index];
  if (index < 232) {
    const offset = index - 16;
    return rgbHex(
      CUBE_STEPS[Math.floor(offset / 36) % 6] ?? 0,
      CUBE_STEPS[Math.floor(offset / 6) % 6] ?? 0,
      CUBE_STEPS[offset % 6] ?? 0,
    );
  }
  const level = 8 + (index - 232) * 10;
  return rgbHex(level, level, level);
}

/// Faint text is rendered as a translucent foreground rather than as a darker hue, so
/// SGR 2 stays readable on a phone in daylight instead of collapsing into the
/// background.
function faded(value: string): string {
  if (!value.startsWith("#") || value.length !== 7) return value;
  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);
  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) return value;
  return `rgba(${red}, ${green}, ${blue}, 0.62)`;
}

/// The cells of one screen row, plus the span projection last handed to the view.
interface Row {
  readonly id: number;
  chars: string[];
  cellStyles: TerminalStyle[];
  spans: readonly TerminalSpan[] | undefined;
  dirty: boolean;
}

/// Everything SGR can set, before inverse and faint are folded into a concrete style.
interface Pen {
  foreground: string | undefined;
  background: string | undefined;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

function freshPen(): Pen {
  return {
    foreground: undefined,
    background: undefined,
    bold: false,
    faint: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function resolvePen(pen: Pen): TerminalStyle {
  let foreground = pen.foreground ?? DEFAULT_FOREGROUND;
  let background = pen.background;
  if (pen.inverse) {
    const swapped = background ?? DEFAULT_BACKGROUND;
    background = foreground;
    foreground = swapped;
  }
  if (pen.faint) foreground = faded(foreground);
  return internStyle({
    foreground,
    background,
    bold: pen.bold,
    italic: pen.italic,
    underline: pen.underline,
  });
}

/// Erased cells keep the pen's background — that is what a real terminal does, and it
/// is how a TUI paints a filled panel — but nothing else, because bold or underline on
/// a blank is invisible noise that would split a span for no reason.
function resolveErase(pen: Pen): TerminalStyle {
  const background = pen.inverse ? pen.foreground ?? DEFAULT_FOREGROUND : pen.background;
  if (background === undefined) return DEFAULT_TERMINAL_STYLE;
  return internStyle({
    foreground: DEFAULT_FOREGROUND,
    background,
    bold: false,
    italic: false,
    underline: false,
  });
}

/// Two columns wide in every terminal that agrees on anything: CJK blocks and the
/// emoji planes. Getting this wrong shifts the rest of the row by one cell, which is
/// exactly what turns a box-drawn panel into torn garbage.
function charWidth(codePoint: number): number {
  if (codePoint < 0x1100) return 1;
  if (codePoint <= 0x115f) return 2;
  if (codePoint === 0x2329 || codePoint === 0x232a) return 2;
  if (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) return 2;
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2;
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2;
  if (codePoint >= 0xfe30 && codePoint <= 0xfe6f) return 2;
  if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2;
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2;
  if (codePoint >= 0x1f300 && codePoint <= 0x1f64f) return 2;
  if (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) return 2;
  if (codePoint >= 0x20000 && codePoint <= 0x3fffd) return 2;
  return 1;
}

/// Zero-width marks belong to the cell before them. Giving a variation selector or a
/// ZWJ its own cell both breaks the glyph and shifts the row.
function isCombining(codePoint: number): boolean {
  return (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20f0)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || codePoint === 0x200d;
}

function spansEqual(left: readonly TerminalSpan[], right: readonly TerminalSpan[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return false;
    if (a.text !== b.text || a.style !== b.style) return false;
  }
  return true;
}

function toSpans(row: Row, columns: number): readonly TerminalSpan[] {
  const spans: TerminalSpan[] = [];
  let text = "";
  let style: TerminalStyle | undefined;
  for (let index = 0; index < columns; index += 1) {
    const char = row.chars[index] ?? " ";
    /// The trailing half of a wide glyph holds no character of its own; the glyph
    /// before it already occupies both columns on screen.
    if (char === "") continue;
    const cellStyle = row.cellStyles[index] ?? DEFAULT_TERMINAL_STYLE;
    if (style === undefined) {
      style = cellStyle;
      text = char;
    } else if (cellStyle === style) {
      text += char;
    } else {
      spans.push({ text, style });
      style = cellStyle;
      text = char;
    }
  }
  if (style !== undefined && text.length > 0) spans.push({ text, style });

  /// Trailing unpainted blanks carry no information, and keeping them would make
  /// every line as wide as the widest one and so make the whole screen scroll
  /// sideways past its own content.
  while (spans.length > 0) {
    const last = spans[spans.length - 1];
    if (last === undefined) break;
    if (last.style.background !== undefined || last.text.trim().length !== 0) {
      if (last.style.background === undefined) {
        const trimmed = last.text.replace(/[ ]+$/u, "");
        if (trimmed !== last.text) spans[spans.length - 1] = { text: trimmed, style: last.style };
      }
      break;
    }
    spans.pop();
  }
  return spans;
}

function isBlankLine(line: TerminalScreenLine | undefined): boolean {
  if (line === undefined) return true;
  return line.spans.every((span) =>
    span.style.background === undefined && span.text.trim().length === 0);
}

/**
 * A DOM-free VT screen projector for agent TUIs.
 *
 * Three things about this client's situation shape it.
 *
 * It attaches late. The daemon replays a bounded ring of recent bytes, so the
 * alternate-screen enable a TUI sent when it started is long gone by the time a phone
 * arrives. Waiting for that byte means never projecting a screen at all, and a redraw
 * stream flattened into lines is unreadable — so ownership is claimed from any
 * operation that only makes sense against a grid.
 *
 * It cannot ask how large the screen is. Mobile sends no resize and the attach ack
 * carries no dimensions, so a fixed 80×24 would wrap and scroll a desktop-sized TUI at
 * the wrong place. The grid instead grows to whatever the stream addresses.
 *
 * It renders on a phone. Colour is carried through, because a Claude frame with its
 * hierarchy flattened to one grey is legible in principle and unreadable in practice.
 *
 * Unknown sequences are ignored rather than passed on: nothing here reaches native
 * code, so the failure mode of an unsupported escape is a missing effect, never a
 * visible control byte.
 */
export class TerminalScreenProjection {
  readonly #decoder = new TextDecoder();
  #columns = DEFAULT_COLUMNS;
  #rows = DEFAULT_ROWS;
  #nextRowId = 0;
  #grid: Row[] = [];
  /// Rows that left the top of the normal screen. Inline TUIs such as Codex rely on
  /// the terminal emulator's scrollback instead of accepting mouse-wheel input.
  #scrollback: Row[] = [];
  #row = 0;
  #column = 0;
  #savedRow = 0;
  #savedColumn = 0;
  #scrollTop = 0;
  #scrollBottom = DEFAULT_ROWS - 1;
  #regionSet = false;
  #escapeCarry = "";
  #alternateScreen = false;
  #screenOwned = false;
  #droppedLines = 0;
  #mouseTracking: TerminalMouseTracking = "unknown";
  #sgrMouseEncoding = false;
  #pen = freshPen();
  #style = DEFAULT_TERMINAL_STYLE;

  /// Read at gesture time rather than published in the snapshot: it changes on its own
  /// schedule, not once per frame.
  get mouseTracking(): TerminalMouseTracking {
    return this.#mouseTracking;
  }

  get sgrMouseEncoding(): boolean {
    return this.#sgrMouseEncoding;
  }

  constructor() {
    this.#grid = Array.from({ length: DEFAULT_ROWS }, () => this.#createRow());
  }

  /// Returns a snapshot once this projector owns the display, and `undefined` while
  /// the line-oriented fallback is still the honest renderer for the stream.
  write(bytes: Uint8Array): TerminalScreenSnapshot | undefined {
    const decoded = this.#decoder.decode(bytes, { stream: true });
    this.#parse(`${this.#escapeCarry}${decoded}`);
    return this.#screenOwned ? this.snapshot() : undefined;
  }

  snapshot(): TerminalScreenSnapshot {
    const lines: TerminalScreenLine[] = [];
    const visibleRows = [...this.#scrollback, ...this.#grid.slice(0, this.#rows)];
    for (const row of visibleRows) {
      if (row === undefined) continue;
      if (row.dirty || row.spans === undefined) {
        const next = toSpans(row, this.#columns);
        /// A redraw repaints most rows with the same content. Keeping the previous
        /// array when it still matches is what lets the view skip those rows.
        row.spans = row.spans !== undefined && spansEqual(row.spans, next) ? row.spans : next;
        row.dirty = false;
      }
      lines.push({ id: row.id, spans: row.spans });
    }
    while (lines.length > 0 && isBlankLine(lines[0])) lines.shift();
    while (lines.length > 0 && isBlankLine(lines.at(-1))) lines.pop();
    return { lines, droppedLines: this.#droppedLines };
  }

  #createRow(): Row {
    this.#nextRowId += 1;
    return {
      id: this.#nextRowId,
      chars: Array.from({ length: this.#columns }, () => " "),
      cellStyles: Array.from({ length: this.#columns }, () => DEFAULT_TERMINAL_STYLE),
      spans: undefined,
      dirty: true,
    };
  }

  /// Cleared in place, keeping the row identity. Replacing the rows would hand the
  /// view a wholly new list on every frame and defeat its per-row memoisation.
  #clearRow(row: Row, style: TerminalStyle): void {
    for (let index = 0; index < this.#columns; index += 1) {
      row.chars[index] = " ";
      row.cellStyles[index] = style;
    }
    row.dirty = true;
  }

  #parse(value: string): void {
    this.#escapeCarry = "";
    let index = 0;
    while (index < value.length) {
      const char = value[index];
      if (char === ESC) {
        const consumed = this.#escape(value, index);
        if (consumed === 0) {
          this.#escapeCarry = value.slice(index);
          return;
        }
        index += consumed;
        continue;
      }
      if (char === "\r") { this.#column = 0; index += 1; continue; }
      if (char === "\n") { this.#lineFeed(); index += 1; continue; }
      if (char === "\b") { this.#column = Math.max(0, this.#column - 1); index += 1; continue; }
      if (char === "\t") {
        this.#column = Math.min(this.#columns - 1, (Math.floor(this.#column / 8) + 1) * 8);
        index += 1;
        continue;
      }
      if (char === undefined || char < " " || char === String.fromCharCode(0x7f)) {
        index += 1;
        continue;
      }
      const unit = value.charCodeAt(index);
      /// A surrogate pair split by a transport frame must be carried, not printed: a
      /// lone half is not a character and renders as a replacement box.
      if (unit >= 0xd800 && unit <= 0xdbff && index + 1 >= value.length) {
        this.#escapeCarry = value.slice(index);
        return;
      }
      const codePoint = value.codePointAt(index) ?? 0;
      const size = codePoint > 0xffff ? 2 : 1;
      const text = value.slice(index, index + size);
      if (isCombining(codePoint)) this.#combine(text);
      else this.#print(text, charWidth(codePoint));
      index += size;
    }
  }

  #escape(value: string, start: number): number {
    const next = value[start + 1];
    if (next === undefined) return 0;
    if (next === "[") {
      for (let index = start + 2; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) {
          this.#csi(value.slice(start + 2, index), value[index] ?? "");
          return index - start + 1;
        }
      }
      return 0;
    }
    if (next === "]") {
      for (let index = start + 2; index < value.length; index += 1) {
        if (value[index] === BEL) return index - start + 1;
        if (value[index] === ESC && value[index + 1] === "\\") return index - start + 2;
      }
      return 0;
    }
    // Charset selection is ESC plus an intermediate and final byte.
    const code = next.charCodeAt(0);
    if (code >= 0x20 && code <= 0x2f) return value[start + 2] === undefined ? 0 : 3;
    if (next === "7") { this.#savedRow = this.#row; this.#savedColumn = this.#column; }
    else if (next === "8") { this.#row = this.#savedRow; this.#column = this.#savedColumn; }
    else if (next === "M") this.#reverseIndex();
    else if (next === "D") this.#lineFeed();
    else if (next === "E") { this.#lineFeed(); this.#column = 0; }
    else if (next === "c") this.#reset();
    return 2;
  }

  #csi(parameters: string, final: string): void {
    const privateMode = parameters.startsWith("?");
    const body = privateMode ? parameters.slice(1) : parameters;
    const parts = body.split(";");
    const values = parts.map((entry) => (entry.length === 0 ? 0 : Number(entry)));
    const value = (index: number, fallback = 1) => {
      const current = values[index];
      if (current === undefined || Number.isNaN(current) || current === 0) return fallback;
      return current;
    };
    const given = (index: number) => {
      const entry = parts[index];
      return entry !== undefined && entry.length > 0;
    };

    if (privateMode) {
      if (final === "h" || final === "l") {
        const enabled = final === "h";
        if (values.includes(1049) || values.includes(1047) || values.includes(47)) {
          this.#alternateScreen = enabled;
          this.#screenOwned = enabled;
          this.#clear();
        }
        /// Mouse reporting changes no text, but it is the only way to learn whether the
        /// program will accept a wheel report — which is what lets a phone scroll a
        /// TUI's own history rather than just the frame it is currently showing.
        if (values.includes(9)) this.#mouseTracking = enabled ? "x10" : "none";
        if (values.includes(1000)) this.#mouseTracking = enabled ? "normal" : "none";
        if (values.includes(1002)) this.#mouseTracking = enabled ? "button" : "none";
        if (values.includes(1003)) this.#mouseTracking = enabled ? "any" : "none";
        if (values.includes(1006)) this.#sgrMouseEncoding = enabled;
      }
      // Cursor visibility and bracketed paste change no text.
      return;
    }

    switch (final) {
      case "A":
        /// Moving the cursor back over output already on screen is the signature of an
        /// app that redraws in place, whether or not it took the alternate screen.
        this.#claim();
        this.#row = Math.max(this.#scrollTop, this.#row - value(0));
        break;
      case "B": this.#moveDown(value(0)); break;
      /// Clamped rather than grown. Relative right-movement is also how a program pads
      /// to the far edge, and `ESC[999C` must not be read as "the screen is 999 wide".
      case "C": this.#column = Math.min(this.#columns - 1, this.#column + value(0)); break;
      case "D": this.#column = Math.max(0, this.#column - value(0)); break;
      case "E": this.#moveDown(value(0)); this.#column = 0; break;
      case "F": this.#row = Math.max(this.#scrollTop, this.#row - value(0)); this.#column = 0; break;
      case "G": this.#moveTo(this.#row, value(0) - 1); break;
      case "H":
      case "f":
        this.#claim();
        this.#moveTo(value(0) - 1, value(1) - 1);
        break;
      case "d":
        this.#claim();
        this.#moveTo(value(0) - 1, this.#column);
        break;
      case "J": {
        const mode = values[0] ?? 0;
        if (mode === 2 || mode === 3) this.#claim();
        this.#eraseDisplay(mode);
        break;
      }
      case "K": this.#eraseLine(values[0] ?? 0); break;
      case "X": this.#eraseCharacters(value(0)); break;
      case "@": this.#claim(); this.#insertCharacters(value(0)); break;
      case "P": this.#claim(); this.#deleteCharacters(value(0)); break;
      case "L": this.#claim(); this.#insertLines(value(0)); break;
      case "M": this.#claim(); this.#deleteLines(value(0)); break;
      case "r":
        if (given(0) || given(1)) {
          this.#claim();
          this.#growRows(value(1, this.#rows));
          this.#scrollTop = clamp(value(0) - 1, 0, this.#rows - 1);
          this.#scrollBottom = clamp(value(1, this.#rows) - 1, this.#scrollTop, this.#rows - 1);
          this.#regionSet = true;
        } else {
          this.#scrollTop = 0;
          this.#scrollBottom = this.#rows - 1;
          this.#regionSet = false;
        }
        this.#row = this.#scrollTop;
        this.#column = 0;
        break;
      case "S": for (let count = value(0); count > 0; count -= 1) this.#scrollUp(); break;
      case "T": for (let count = value(0); count > 0; count -= 1) this.#scrollDown(); break;
      case "s": this.#savedRow = this.#row; this.#savedColumn = this.#column; break;
      case "u": this.#row = this.#savedRow; this.#column = this.#savedColumn; break;
      case "m": this.#sgr(values); break;
      // Device queries and cursor-style requests change no text.
    }
  }

  /// Ownership is sticky. A stream that has once proved it redraws in place keeps
  /// redrawing; only an explicit alternate-screen exit hands the display back.
  #claim(): void {
    this.#screenOwned = true;
  }

  #sgr(values: readonly number[]): void {
    if (values.length === 0) { this.#setPen(freshPen()); return; }
    const pen = { ...this.#pen };
    for (let index = 0; index < values.length; index += 1) {
      const code = values[index];
      if (code === undefined || Number.isNaN(code)) continue;
      if (code === 0) { Object.assign(pen, freshPen()); continue; }
      if (code === 1) { pen.bold = true; continue; }
      if (code === 2) { pen.faint = true; continue; }
      if (code === 3) { pen.italic = true; continue; }
      if (code === 4) { pen.underline = true; continue; }
      if (code === 7) { pen.inverse = true; continue; }
      if (code === 21 || code === 22) { pen.bold = false; pen.faint = false; continue; }
      if (code === 23) { pen.italic = false; continue; }
      if (code === 24) { pen.underline = false; continue; }
      if (code === 27) { pen.inverse = false; continue; }
      if (code === 39) { pen.foreground = undefined; continue; }
      if (code === 49) { pen.background = undefined; continue; }
      if (code === 38 || code === 48) {
        const selector = values[index + 1];
        if (selector === 5) {
          const resolved = paletteColor(values[index + 2] ?? -1);
          if (code === 38) pen.foreground = resolved; else pen.background = resolved;
          index += 2;
        } else if (selector === 2) {
          const red = values[index + 2];
          const green = values[index + 3];
          const blue = values[index + 4];
          if (red !== undefined && green !== undefined && blue !== undefined) {
            const resolved = rgbHex(red, green, blue);
            if (code === 38) pen.foreground = resolved; else pen.background = resolved;
          }
          index += 4;
        }
        continue;
      }
      if (code >= 30 && code <= 37) { pen.foreground = ANSI_16[code - 30]; continue; }
      if (code >= 90 && code <= 97) { pen.foreground = ANSI_16[code - 90 + 8]; continue; }
      if (code >= 40 && code <= 47) { pen.background = ANSI_16[code - 40]; continue; }
      if (code >= 100 && code <= 107) { pen.background = ANSI_16[code - 100 + 8]; continue; }
    }
    this.#setPen(pen);
  }

  #setPen(pen: Pen): void {
    this.#pen = pen;
    this.#style = resolvePen(pen);
  }

  /// Relative downward movement discovers height the same way absolute addressing
  /// does: a program that steps to row 40 believes it has at least 41 rows.
  #moveDown(count: number): void {
    this.#growRows(this.#row + count + 1);
    this.#row = Math.min(this.#scrollBottom, this.#row + count);
  }

  #moveTo(row: number, column: number): void {
    this.#growRows(row + 1);
    this.#growColumns(column + 1);
    this.#row = clamp(row, 0, this.#rows - 1);
    this.#column = clamp(column, 0, this.#columns - 1);
  }

  #growRows(target: number): void {
    const next = Math.min(SCREEN_MAX_ROWS, target);
    if (next <= this.#rows) return;
    while (this.#grid.length < next) this.#grid.push(this.#createRow());
    this.#rows = next;
    this.#trimScrollback();
    if (!this.#regionSet) this.#scrollBottom = this.#rows - 1;
  }

  #growColumns(target: number): void {
    const next = Math.min(SCREEN_MAX_COLUMNS, target);
    if (next <= this.#columns) return;
    for (const row of this.#grid) {
      while (row.chars.length < next) {
        row.chars.push(" ");
        row.cellStyles.push(DEFAULT_TERMINAL_STYLE);
      }
    }
    this.#columns = next;
  }

  #print(text: string, width: number): void {
    if (this.#column + width > this.#columns) this.#growColumns(this.#column + width);
    if (this.#column + width > this.#columns) {
      this.#column = 0;
      this.#lineFeed();
    }
    if (this.#row >= this.#rows) {
      this.#growRows(this.#row + 1);
      if (this.#row >= this.#rows) this.#row = this.#rows - 1;
    }
    const row = this.#grid[this.#row];
    if (row === undefined) return;
    row.chars[this.#column] = text;
    row.cellStyles[this.#column] = this.#style;
    for (let offset = 1; offset < width; offset += 1) {
      row.chars[this.#column + offset] = "";
      row.cellStyles[this.#column + offset] = this.#style;
    }
    row.dirty = true;
    /// The cursor is allowed to rest one past the last column. Wrapping eagerly here
    /// would insert a blank line after every row that exactly fills the width.
    this.#column = Math.min(this.#columns, this.#column + width);
  }

  #combine(text: string): void {
    const row = this.#grid[this.#row];
    if (row === undefined) return;
    let target = this.#column - 1;
    while (target > 0 && row.chars[target] === "") target -= 1;
    if (target < 0) return;
    const existing = row.chars[target];
    if (existing === undefined || existing === "") return;
    row.chars[target] = `${existing}${text}`;
    row.dirty = true;
  }

  #lineFeed(): void {
    if (this.#row < this.#scrollBottom) { this.#row += 1; return; }
    /// With no scroll region declared, a line feed past the last known row means the
    /// real screen is taller than anything seen so far. The row is materialised only
    /// when something is printed into it, so a frame that ends with a newline does not
    /// make the grid creep a row taller every redraw.
    if (!this.#regionSet && this.#row + 1 < SCREEN_MAX_ROWS) { this.#row += 1; return; }
    this.#scrollUp();
    this.#row = this.#scrollBottom;
  }

  #reverseIndex(): void {
    if (this.#row > this.#scrollTop) { this.#row -= 1; return; }
    this.#scrollDown();
  }

  #scrollUp(): void {
    const removed = this.#grid.splice(this.#scrollTop, 1)[0];
    this.#grid.splice(this.#scrollBottom, 0, this.#createRow());
    /// A normal-buffer region anchored to the first row contributes to terminal
    /// scrollback even when it has a declared bottom margin. Codex uses exactly this
    /// inline-viewport pattern. Partial regions redraw a panel, while the alternate
    /// screen belongs entirely to the TUI and keeps no emulator scrollback.
    if (this.#scrollTop === 0 && !this.#alternateScreen && removed !== undefined) {
      this.#rememberScrollback(removed);
    } else if (!this.#regionSet) {
      this.#droppedLines += 1;
    }
  }

  #rememberScrollback(row: Row): void {
    const meaningful = row.chars.some((char, index) =>
      char.trim().length > 0 || row.cellStyles[index]?.background !== undefined);
    if (!meaningful) return;
    this.#scrollback.push(row);
    this.#trimScrollback();
  }

  #trimScrollback(): void {
    const limit = Math.max(0, SCREEN_MAX_ROWS - this.#rows);
    const overflow = Math.max(0, this.#scrollback.length - limit);
    if (overflow === 0) return;
    this.#scrollback.splice(0, overflow);
    this.#droppedLines += overflow;
  }

  #scrollDown(): void {
    this.#grid.splice(this.#scrollBottom, 1);
    this.#grid.splice(this.#scrollTop, 0, this.#createRow());
  }

  #eraseLine(mode: number): void {
    const row = this.#grid[this.#row];
    if (row === undefined) return;
    const style = resolveErase(this.#pen);
    const from = mode === 1 ? 0 : Math.min(this.#column, this.#columns - 1);
    const to = mode === 0 ? this.#columns - 1 : Math.min(this.#column, this.#columns - 1);
    for (let index = from; index <= to; index += 1) {
      row.chars[index] = " ";
      row.cellStyles[index] = style;
    }
    row.dirty = true;
  }

  #eraseCharacters(count: number): void {
    const row = this.#grid[this.#row];
    if (row === undefined) return;
    const style = resolveErase(this.#pen);
    const limit = Math.min(this.#columns, this.#column + count);
    for (let index = this.#column; index < limit; index += 1) {
      row.chars[index] = " ";
      row.cellStyles[index] = style;
    }
    row.dirty = true;
  }

  #insertCharacters(count: number): void {
    const row = this.#grid[this.#row];
    if (row === undefined) return;
    const style = resolveErase(this.#pen);
    for (let index = 0; index < count; index += 1) {
      row.chars.splice(this.#column, 0, " ");
      row.cellStyles.splice(this.#column, 0, style);
    }
    row.chars.length = this.#columns;
    row.cellStyles.length = this.#columns;
    row.dirty = true;
  }

  #deleteCharacters(count: number): void {
    const row = this.#grid[this.#row];
    if (row === undefined) return;
    const style = resolveErase(this.#pen);
    row.chars.splice(this.#column, count);
    row.cellStyles.splice(this.#column, count);
    while (row.chars.length < this.#columns) {
      row.chars.push(" ");
      row.cellStyles.push(style);
    }
    row.dirty = true;
  }

  #insertLines(count: number): void {
    if (this.#row < this.#scrollTop || this.#row > this.#scrollBottom) return;
    for (let index = 0; index < count; index += 1) {
      this.#grid.splice(this.#scrollBottom, 1);
      this.#grid.splice(this.#row, 0, this.#createRow());
    }
  }

  #deleteLines(count: number): void {
    if (this.#row < this.#scrollTop || this.#row > this.#scrollBottom) return;
    for (let index = 0; index < count; index += 1) {
      this.#grid.splice(this.#row, 1);
      this.#grid.splice(this.#scrollBottom, 0, this.#createRow());
    }
  }

  #eraseDisplay(mode: number): void {
    const style = resolveErase(this.#pen);
    if (mode === 2 || mode === 3) {
      for (const row of this.#grid) this.#clearRow(row, style);
      if (mode === 3) {
        this.#scrollback = [];
        this.#droppedLines = 0;
      }
      return;
    }
    if (mode === 0) {
      this.#eraseLine(0);
      for (let index = this.#row + 1; index < this.#rows; index += 1) {
        const row = this.#grid[index];
        if (row !== undefined) this.#clearRow(row, style);
      }
      return;
    }
    if (mode === 1) {
      this.#eraseLine(1);
      for (let index = 0; index < this.#row; index += 1) {
        const row = this.#grid[index];
        if (row !== undefined) this.#clearRow(row, style);
      }
    }
  }

  /// Entering or leaving the alternate screen keeps the geometry discovered so far —
  /// the PTY did not change size — but nothing else survives the switch.
  #clear(): void {
    for (const row of this.#grid) this.#clearRow(row, DEFAULT_TERMINAL_STYLE);
    this.#scrollback = [];
    this.#droppedLines = 0;
    this.#row = 0;
    this.#column = 0;
    this.#scrollTop = 0;
    this.#scrollBottom = this.#rows - 1;
    this.#regionSet = false;
    this.#setPen(freshPen());
  }

  #reset(): void {
    this.#clear();
    this.#savedRow = 0;
    this.#savedColumn = 0;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

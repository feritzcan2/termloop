/// The bytes a phone keyboard cannot produce but a shell or an agent TUI needs.
///
/// Everything here is pure text: the session hook encodes it once at the PTY
/// boundary, so a key, a chord, a saved custom key, and a typed character all reach
/// the daemon the same way.

export interface TerminalModifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export const NO_MODIFIERS: TerminalModifiers = { ctrl: false, alt: false, shift: false };

export function hasModifier(modifiers: TerminalModifiers): boolean {
  return modifiers.ctrl || modifiers.alt || modifiers.shift;
}

export type AccessoryKeyId =
  | "escape" | "tab" | "backtab" | "interrupt" | "eof"
  | "up" | "down" | "left" | "right"
  | "home" | "end" | "pageUp" | "pageDown"
  | "backspace" | "enter";

export interface AccessoryKey {
  readonly id: AccessoryKeyId;
  readonly glyph: string;
  readonly name: string;
  /// Held keys repeat, the way a hardware keyboard does. Only keys whose repetition
  /// is harmless qualify: moving and deleting, never Enter or an interrupt.
  readonly repeatable: boolean;
}

/// The row order. Shift+Tab has its own key because it is how Claude Code changes
/// mode, which is too frequent to cost an extra modifier tap.
export const ACCESSORY_KEYS: readonly AccessoryKey[] = [
  { id: "escape", glyph: "esc", name: "Escape", repeatable: false },
  { id: "tab", glyph: "tab", name: "Tab", repeatable: false },
  { id: "backtab", glyph: "⇧tab", name: "Shift Tab", repeatable: false },
  { id: "interrupt", glyph: "^C", name: "Interrupt", repeatable: false },
  { id: "eof", glyph: "^D", name: "End of input", repeatable: false },
  { id: "up", glyph: "↑", name: "Up", repeatable: true },
  { id: "down", glyph: "↓", name: "Down", repeatable: true },
  { id: "left", glyph: "←", name: "Left", repeatable: true },
  { id: "right", glyph: "→", name: "Right", repeatable: true },
  { id: "backspace", glyph: "⌫", name: "Backspace", repeatable: true },
  { id: "home", glyph: "home", name: "Home", repeatable: false },
  { id: "end", glyph: "end", name: "End", repeatable: false },
  { id: "pageUp", glyph: "pgup", name: "Page up", repeatable: true },
  { id: "pageDown", glyph: "pgdn", name: "Page down", repeatable: true },
  { id: "enter", glyph: "⏎", name: "Enter", repeatable: false },
];

const ESC = "\x1b";

const CURSOR_FINALS: Partial<Record<AccessoryKeyId, string>> = {
  up: "A", down: "B", right: "C", left: "D", home: "H", end: "F",
};
const TILDE_CODES: Partial<Record<AccessoryKeyId, number>> = { pageUp: 5, pageDown: 6 };

/// xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4).
function modifierParameter(modifiers: TerminalModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

export function accessoryKeyText(id: AccessoryKeyId, modifiers: TerminalModifiers = NO_MODIFIERS): string {
  const cursor = CURSOR_FINALS[id];
  if (cursor !== undefined) {
    return hasModifier(modifiers) ? `${ESC}[1;${modifierParameter(modifiers)}${cursor}` : `${ESC}[${cursor}`;
  }
  const tilde = TILDE_CODES[id];
  if (tilde !== undefined) {
    return hasModifier(modifiers) ? `${ESC}[${tilde};${modifierParameter(modifiers)}~` : `${ESC}[${tilde}~`;
  }
  const alt = modifiers.alt ? ESC : "";
  switch (id) {
    case "escape": return `${alt}${ESC}`;
    case "tab": return modifiers.shift ? `${ESC}[Z` : `${alt}\t`;
    case "backtab": return `${ESC}[Z`;
    case "interrupt": return "\x03";
    case "eof": return "\x04";
    /// Ctrl+Backspace is ^H, which readline binds to the same rubout as DEL; Alt
    /// prefixes DEL so readline and zle delete the previous word.
    case "backspace": return modifiers.ctrl ? "\x08" : `${alt}\x7f`;
    case "enter": return `${alt}\r`;
    default: return "";
  }
}

/// Applies armed modifiers to one typed character.
///
/// Ctrl folds the character into its C0 control code where one exists; a character
/// with no control form is sent as typed rather than dropped, so an armed Ctrl never
/// swallows input. Alt is the ESC prefix every terminal program understands as Meta.
export function characterChordText(character: string, modifiers: TerminalModifiers): string {
  let text = modifiers.shift && character.length === 1 ? character.toUpperCase() : character;
  if (modifiers.ctrl && text.length === 1) {
    const control = controlCharacter(text);
    if (control !== undefined) text = control;
  }
  return modifiers.alt ? `${ESC}${text}` : text;
}

function controlCharacter(character: string): string | undefined {
  if (/^[a-zA-Z]$/.test(character)) return String.fromCharCode(character.toUpperCase().charCodeAt(0) & 0x1f);
  switch (character) {
    case " ": case "@": case "2": return "\x00";
    case "[": case "3": return ESC;
    case "\\": case "4": return "\x1c";
    case "]": case "5": return "\x1d";
    case "^": case "6": return "\x1e";
    case "_": case "-": case "7": return "\x1f";
    case "?": case "8": return "\x7f";
    default: return undefined;
  }
}

/// Text typed into a live terminal. A phone keyboard's newline is the terminal's
/// carriage return; the PTY's line discipline decides what Enter means from there.
export function liveInputText(text: string): string {
  return text.replace(/\r\n|\n/g, "\r");
}

export type ParsedKeySequence =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

/// Reads a custom key's sequence as it is written in the editor.
///
/// Backslash escapes are the only syntax: `\e` and `\x1b` for Escape, `\cX` for
/// Ctrl+X, `\r` `\n` `\t`, `\xHH`, `\uHHHH`, and `\\`. Everything else is literal,
/// so a sequence like `git status` needs no quoting at all.
export function parseKeySequence(source: string): ParsedKeySequence {
  let text = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character !== "\\") {
      text += character;
      continue;
    }
    const next = source[index + 1];
    if (next === undefined) return { ok: false, error: "A sequence cannot end with a single backslash." };
    index += 1;
    switch (next) {
      case "e": text += ESC; break;
      case "r": text += "\r"; break;
      case "n": text += "\n"; break;
      case "t": text += "\t"; break;
      case "\\": text += "\\"; break;
      case "c": {
        const target = source[index + 1];
        const control = target === undefined ? undefined : controlCharacter(target);
        if (control === undefined) return { ok: false, error: "\\c needs a letter or one of @[\\]^_? after it." };
        text += control;
        index += 1;
        break;
      }
      case "x":
      case "u": {
        const width = next === "x" ? 2 : 4;
        const digits = source.slice(index + 1, index + 1 + width);
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
          return { ok: false, error: `\\${next} needs exactly ${width} hex digits.` };
        }
        text += String.fromCharCode(Number.parseInt(digits, 16));
        index += width;
        break;
      }
      default:
        return { ok: false, error: `\\${next} is not a known escape.` };
    }
  }
  if (text.length === 0) return { ok: false, error: "The sequence is empty." };
  return { ok: true, text };
}

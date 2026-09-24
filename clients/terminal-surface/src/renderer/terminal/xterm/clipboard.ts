// Explicit clipboard chords for the xterm renderer, following the standard
// terminal-emulator convention on Windows/Linux: Ctrl+Shift+V pastes clipboard
// text and Ctrl+Shift+C copies the current selection. Everything else —
// including plain Ctrl+V and Ctrl+C — is left to xterm so terminal
// applications still receive the control bytes they expect (^V, ^C).
// Alt/AltGr and Meta combinations never match, which keeps AltGr layouts and
// the macOS Cmd shortcuts untouched.

export type ClipboardKeyAction = "paste" | "copy";

export interface ClipboardKeyEventLike {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export interface ClipboardKeyDecision {
  /** True when xterm must not process this event (all phases of the chord). */
  readonly handled: boolean;
  /** Clipboard action to perform, set only on the chord's keydown. */
  readonly action: ClipboardKeyAction | null;
}

const passthrough: ClipboardKeyDecision = { handled: false, action: null };

export function clipboardKeyDecision(
  event: ClipboardKeyEventLike,
  hasSelection: boolean,
): ClipboardKeyDecision {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
    return passthrough;
  }
  // Prefer the layout-resolved key; fall back to the physical key only when
  // the layout yields no plain letter (dead keys, "Process" during IME).
  const letter = event.key.length === 1 ? event.key.toLowerCase() : "";
  const isPaste = letter === "v" || (letter === "" && event.code === "KeyV");
  const isCopy = letter === "c" || (letter === "" && event.code === "KeyC");
  if (isPaste) {
    return { handled: true, action: event.type === "keydown" ? "paste" : null };
  }
  if (isCopy && hasSelection) {
    // Without a selection the chord falls through, matching common terminal
    // emulators where Ctrl+Shift+C is inert until something is selected.
    return { handled: true, action: event.type === "keydown" ? "copy" : null };
  }
  return passthrough;
}

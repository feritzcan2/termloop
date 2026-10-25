// Keyboard triggers for quick capture: double Shift, as in the TermLoop
// desktop app, and Cmd+N (Ctrl+N off macOS). While a native Ghostty surface
// holds focus these keys never reach the DOM; the native host detects the
// same pair and main forwards it as `onNativeShortcut("quickCapture")`.
import { DOUBLE_SHIFT_WINDOW_MS } from "../../pm-api.js";

type ShiftKeyDown = Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "repeat" | "timeStamp">;
type ShiftKeyUp = Pick<KeyboardEvent, "code" | "timeStamp">;

/**
 * Shift pressed, released, and pressed again within the window, with no other
 * key between. The window covers the whole down-up-down cycle, matching the
 * native host's detector.
 */
export class DoubleShiftDetector {
  #firstDownAt: number | undefined;
  #released = false;

  constructor(private readonly windowMs = DOUBLE_SHIFT_WINDOW_MS) {}

  /** True on the second Shift press that completes a double tap. */
  keyDown(event: ShiftKeyDown): boolean {
    if (!isShiftCode(event.code) || event.altKey || event.ctrlKey || event.metaKey || event.repeat) {
      this.reset();
      return false;
    }
    if (this.#firstDownAt !== undefined && this.#released && event.timeStamp - this.#firstDownAt <= this.windowMs) {
      this.reset();
      return true;
    }
    this.#firstDownAt = event.timeStamp;
    this.#released = false;
    return false;
  }

  keyUp(event: ShiftKeyUp): void {
    if (!isShiftCode(event.code) || this.#firstDownAt === undefined) return;
    if (event.timeStamp - this.#firstDownAt > this.windowMs) this.reset();
    else this.#released = true;
  }

  reset(): void {
    this.#firstDownAt = undefined;
    this.#released = false;
  }
}

function isShiftCode(code: string): boolean {
  return code === "ShiftLeft" || code === "ShiftRight";
}

/** Cmd+N on macOS, Ctrl+N elsewhere, with no other modifier. */
export function isNewTicketShortcut(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">, mac: boolean): boolean {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n";
}

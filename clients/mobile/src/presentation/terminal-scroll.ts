import type { TerminalMouseTracking } from "./terminal-screen";

/// Choosing what to send when a reader asks to go further back than the current frame.
///
/// The alternate screen has no scrollback. The program owns the grid and repaints it,
/// so rows that left the frame were never held on the phone — the only way past it is
/// to ask the program to scroll itself. That means sending input, and input that lands
/// in a program which is not listening for it does damage: `ESC[<64;1;1M` typed into a
/// shell prompt is noise, and read by vim in normal mode it is a run of commands.
///
/// So a wheel report goes out only once the program has actually said it tracks the
/// mouse. Everything else gets the page keys — the conservative choice, not the good
/// one: a program that scrolls with them scrolls, and a program that does not ignores a
/// key it already recognises. Nothing is typed into anything either way.
///
/// Arrow keys are deliberately not the fallback. In Claude they walk the input history,
/// so "scroll up" would quietly rewrite whatever the user was composing.

const ESC = String.fromCharCode(0x1b);

/// A phone has no pointer, so a wheel report has to name some cell. The top-left one is
/// the safest available: in a single-pane agent TUI it falls inside the transcript
/// rather than inside the composer, which is the region a reader dragging upward means
/// to scroll.
const WHEEL_REPORT_CELL = 1;

/// One page per three lines of gesture, so an overscroll does not fling the reader
/// through the whole history at once.
const LINES_PER_PAGE = 3;

/// Describes a drag beyond the locally-rendered frame. A projected terminal screen has
/// no local transcript after either edge, so the overscroll is a request for the
/// program to move its own viewport instead. Negative lines mean backwards, positive
/// lines mean forwards.
export function overscrollRequest(
  offsetY: number,
  contentHeight: number,
  viewportHeight: number,
  lineHeight: number,
): number {
  const safeLineHeight = Math.max(1, lineHeight);
  const lowerEdge = Math.max(0, contentHeight - viewportHeight);
  const aboveTop = Math.max(0, -offsetY);
  if (aboveTop > 0) return -Math.floor(aboveTop / safeLineHeight);

  const belowBottom = Math.max(0, offsetY - lowerEdge);
  return Math.floor(belowBottom / safeLineHeight);
}

/// `lines` is negative to move backwards, matching a wheel delta.
export function scrollSequence(
  lines: number,
  tracking: TerminalMouseTracking,
  sgrEncoding: boolean,
): string {
  const back = lines < 0;
  const count = Math.abs(lines);
  if (count === 0) return "";
  /// `unknown` is not `none`. A late attach never saw the enable sequence, and guessing
  /// that a program tracks the mouse is exactly the guess that types garbage into it.
  const wheelCapable = tracking === "normal" || tracking === "button" || tracking === "any";
  if (wheelCapable && sgrEncoding) {
    const code = back ? 64 : 65;
    return `${ESC}[<${code};${WHEEL_REPORT_CELL};${WHEEL_REPORT_CELL}M`.repeat(count);
  }
  const pages = Math.max(1, Math.round(count / LINES_PER_PAGE));
  return `${ESC}[${back ? "5" : "6"}~`.repeat(pages);
}

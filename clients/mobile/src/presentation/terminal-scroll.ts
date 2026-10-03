import type { TerminalMouseTracking } from "./terminal-screen";

/// The first terminal snapshot must reach the live edge before it becomes visible.
/// React Native lays a ScrollView out at offset zero and only then accepts an
/// imperative `scrollToEnd`, so revealing the content immediately makes a long Agent
/// transcript visibly sweep from its oldest rows to its newest ones.
export type InitialTerminalPosition = "waitingForContent" | "positioning" | "ready";

export type InitialTerminalPositionEvent =
  | { readonly type: "contentChanged"; readonly hasContent: boolean }
  | { readonly type: "positioned" };

/// Keeps empty layout callbacks from revealing the terminal, and never returns a
/// visible terminal to its hidden startup state once the first placement completed.
export function reduceInitialTerminalPosition(
  current: InitialTerminalPosition,
  event: InitialTerminalPositionEvent,
): InitialTerminalPosition {
  if (current === "ready") return current;
  if (event.type === "contentChanged") {
    if (current === "positioning" || !event.hasContent) return current;
    return "positioning";
  }
  return current === "positioning" ? "ready" : current;
}

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

/// Target the transcript below its first row. Codex can pin a prompt header on
/// row one while reading older output and excludes that header from wheel input.
/// Reporting to row one then stops scrolling as soon as the header appears.
const WHEEL_REPORT_COLUMN = 1;
const WHEEL_REPORT_ROW = 2;

/// Codex moves three rows per wheel report. Wait for that much finger travel
/// so the transcript follows the drag distance instead of moving three times faster.
const DRAG_LINES_PER_WHEEL = 3;

/// One page per three lines of gesture, so an overscroll does not fling the reader
/// through the whole history at once.
const LINES_PER_PAGE = 3;

export function supportsTerminalWheel(tracking: TerminalMouseTracking, sgrEncoding: boolean): boolean {
  return sgrEncoding && (tracking === "normal" || tracking === "button" || tracking === "any");
}

/// Pan a desktop-sized frame on the phone first, then send motion beyond its
/// edges to the program. This also works on platforms without native bounce.
/// Remainder is finger travel in line heights; lines counts emitted wheel steps.
export function terminalDragScroll(
  deltaY: number,
  lineHeight: number,
  remainder: number,
  offset: number,
  maxOffset: number,
): { offset: number; lines: number; remainder: number } {
  const target = offset - deltaY;
  const nextOffset = Math.max(0, Math.min(maxOffset, target));
  const total = (nextOffset === offset ? remainder : 0) + (target - nextOffset) / Math.max(1, lineHeight);
  const lines = Math.trunc(total / DRAG_LINES_PER_WHEEL) || 0;
  return { offset: nextOffset, lines, remainder: total - lines * DRAG_LINES_PER_WHEEL };
}

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
  if (supportsTerminalWheel(tracking, sgrEncoding)) {
    const code = back ? 64 : 65;
    return `${ESC}[<${code};${WHEEL_REPORT_COLUMN};${WHEEL_REPORT_ROW}M`.repeat(count);
  }
  const pages = Math.max(1, Math.round(count / LINES_PER_PAGE));
  return `${ESC}[${back ? "5" : "6"}~`.repeat(pages);
}

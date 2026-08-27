import type { TerminalEvent } from "../application/ports";

import { applyCarriageReturns, stripControlSequences } from "./ansi";
import {
  SCREEN_MAX_ROWS,
  type TerminalScreenLine,
  type TerminalScreenSnapshot,
} from "./terminal-screen";
import { terminalGeometry } from "../theme/tokens";

/// The phone's view of a terminal stream, as a pure reducer over the injected
/// port's events.
///
/// Two product rules are structural here rather than remembered:
///
/// 1. The buffer is bounded and says so. When it drops lines it counts them and the
///    view states the cap, because a window that silently forgets its top is
///    indistinguishable from a daemon that never sent those bytes.
/// 2. A gap becomes a visible marker. A dropped transport frame is a fact about the
///    conversation, and swallowing it would let the reader build a wrong model of
///    what the agent actually said.
///
/// It is a reducer and not a class so the whole thing is testable without a
/// renderer, a socket, or a clock.

export type TerminalLineKind =
  /// Bytes the session produced.
  | "output"
  /// Something TermLoop is telling the reader about the stream itself.
  | "notice"
  /// Output that existed and this client did not receive.
  | "gap";

export interface TerminalLine {
  /// Monotonic and never reused, so a list key survives lines being dropped off the
  /// top. Index-based keys reorder the whole view every time the cap bites.
  readonly id: number;
  readonly kind: TerminalLineKind;
  readonly text: string;
  /// Present only for gap markers so adjacent transport gaps can be updated in
  /// place instead of consuming the whole viewport with repeated warnings.
  readonly droppedFrames?: number;
}

/// What the header pill reports. Exactly one at a time.
export type TerminalStreamState =
  | "attaching"
  | "live"
  | "reconnecting"
  | "detached"
  | "exited";

export interface TerminalBuffer {
  readonly lines: readonly TerminalLine[];
  /// Current VT screen reconstructed by the DOM-free terminal projector, as styled
  /// spans. Undefined means no stream has proved it owns a grid, and the small
  /// line-oriented parser below is still the honest renderer.
  readonly screen: readonly TerminalScreenLine[] | undefined;
  readonly screenDroppedLines: number;
  /// The line currently being written, with no newline yet. Kept separate so an
  /// agent's half-typed prompt is visible without being treated as finished.
  readonly pending: string;
  readonly stream: TerminalStreamState;
  /// Trailing bytes of an incomplete UTF-8 sequence, carried to the next event. A
  /// multi-byte character split across two frames must not decode to a replacement
  /// glyph.
  readonly carry: Uint8Array;
  /// How many lines the cap has discarded. Stated in the view, never hidden.
  readonly droppedLines: number;
  readonly nextLineId: number;
}

export function emptyTerminalBuffer(): TerminalBuffer {
  return {
    lines: [],
    screen: undefined,
    screenDroppedLines: 0,
    pending: "",
    stream: "attaching",
    carry: new Uint8Array(0),
    droppedLines: 0,
    nextLineId: 1,
  };
}

/// Applies the projector's verdict, including the negative one.
///
/// Passing `undefined` hands the display back to the line-oriented path. That case is
/// not decoration: when a TUI exits the alternate screen the projector stops claiming
/// the display, and a screen left standing would freeze the phone on the last frame of
/// a program that is no longer running.
export function withTerminalScreen(
  buffer: TerminalBuffer,
  screen: TerminalScreenSnapshot | undefined,
): TerminalBuffer {
  if (screen === undefined) {
    if (buffer.screen === undefined) return buffer;
    return { ...buffer, screen: undefined, screenDroppedLines: 0 };
  }
  return {
    ...buffer,
    screen: screen.lines,
    screenDroppedLines: screen.droppedLines,
  };
}

/// The index at which `bytes` can be decoded without truncating a UTF-8 sequence.
/// Scans back at most three bytes: a sequence is at most four long, so a lead byte
/// further back than that is already complete.
function utf8SplitIndex(bytes: Uint8Array): number {
  const length = bytes.length;
  for (let back = 1; back <= 3 && back <= length; back += 1) {
    const index = length - back;
    const byte = bytes[index];
    if (byte === undefined) return length;
    /// ASCII: everything before it is complete too.
    if ((byte & 0x80) === 0) return length;
    /// Continuation byte: keep scanning for the lead byte that owns it.
    if ((byte & 0xc0) === 0x80) continue;
    const needed = (byte & 0xe0) === 0xc0 ? 2
      : (byte & 0xf0) === 0xe0 ? 3
      : (byte & 0xf8) === 0xf0 ? 4
      : 1;
    return needed <= back ? length : index;
  }
  return length;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function appendLines(
  buffer: TerminalBuffer,
  additions: readonly Omit<TerminalLine, "id">[],
): TerminalBuffer {
  if (additions.length === 0) return buffer;
  let nextLineId = buffer.nextLineId;
  const lines = [...buffer.lines];
  for (const addition of additions) {
    lines.push({ id: nextLineId, ...addition });
    nextLineId += 1;
  }
  const overflow = Math.max(0, lines.length - terminalGeometry.maxLines);
  return {
    ...buffer,
    lines: overflow > 0 ? lines.slice(overflow) : lines,
    droppedLines: buffer.droppedLines + overflow,
    nextLineId,
  };
}

function appendNotice(buffer: TerminalBuffer, text: string): TerminalBuffer {
  return appendLines(buffer, [{ kind: "notice", text }]);
}

function gapText(frames: number): string {
  return `output skipped · ${frames} ${frames === 1 ? "frame" : "frames"} were dropped before this phone read them`;
}

function appendGap(buffer: TerminalBuffer, droppedFrames: number): TerminalBuffer {
  const frames = Math.max(1, droppedFrames);
  const last = buffer.lines.at(-1);
  if (last?.kind === "gap") {
    const combined = (last.droppedFrames ?? 1) + frames;
    return {
      ...buffer,
      lines: [
        ...buffer.lines.slice(0, -1),
        { ...last, text: gapText(combined), droppedFrames: combined },
      ],
    };
  }
  return appendLines(buffer, [{ kind: "gap", text: gapText(frames), droppedFrames: frames }]);
}

/// Turns one finished segment into the text a line prints.
///
/// The trailing carriage return is dropped first. It is the CR of a CRLF pair — a line
/// terminator, not a cursor movement — and feeding it to the overwrite rule would find
/// that CR at the very end of the string and collapse the whole line to nothing. Which
/// would be most lines, from most programs.
function finishLine(segment: string): string {
  const terminated = segment.endsWith("\r") ? segment.slice(0, -1) : segment;
  return stripControlSequences(applyCarriageReturns(terminated));
}

/// Decodes one output chunk into finished lines plus whatever is still being
/// written. `decode` is injected so the reducer never reaches for a global and can
/// be exercised without a platform text decoder.
function ingestBytes(
  buffer: TerminalBuffer,
  bytes: Uint8Array,
  decode: (bytes: Uint8Array) => string,
  screenActive: boolean,
): TerminalBuffer {
  /// While the projector owns the display, flattening the same bytes into lines is
  /// work nobody reads: the line list is hidden, and a redraw stream would push
  /// hundreds of duplicate fragments through the cap on every frame.
  if (screenActive) {
    if (buffer.pending.length === 0 && buffer.carry.length === 0) return buffer;
    return { ...buffer, pending: "", carry: new Uint8Array(0) };
  }
  const merged = concatBytes(buffer.carry, bytes);
  const split = utf8SplitIndex(merged);
  const carry = merged.slice(split);
  const chunk = decode(merged.slice(0, split));
  if (chunk.length === 0) return { ...buffer, carry };

  const segments = `${buffer.pending}${chunk}`.split("\n");
  /// The last segment has no newline after it, so it is still being written.
  const pending = segments.pop() ?? "";
  const finished = segments.map((segment) => ({
    kind: "output" as const,
    text: finishLine(segment),
  }));
  return { ...appendLines({ ...buffer, carry }, finished), pending };
}

/// Flushes a half-written line before a marker that must not appear inside it, so a
/// gap or an exit notice never lands mid-sentence.
function flushPending(buffer: TerminalBuffer): TerminalBuffer {
  if (buffer.pending.length === 0) return buffer;
  const flushed = appendLines(buffer, [{
    kind: "output",
    text: finishLine(buffer.pending),
  }]);
  return { ...flushed, pending: "" };
}

export interface TerminalReducerOptions {
  decode: (bytes: Uint8Array) => string;
  /// Whether the VT projector claimed this chunk. Passed in rather than inferred,
  /// because the reducer stays pure and the projector is the only thing that knows.
  screenActive?: boolean;
}

export function reduceTerminalEvent(
  buffer: TerminalBuffer,
  event: TerminalEvent,
  options: TerminalReducerOptions,
): TerminalBuffer {
  switch (event.type) {
    case "reset":
      return { ...emptyTerminalBuffer(), nextLineId: buffer.nextLineId };
    case "replay":
      return ingestBytes(buffer, event.bytes, options.decode, options.screenActive === true);
    case "live":
      return ingestBytes(buffer, event.bytes, options.decode, options.screenActive === true);
    case "gap": {
      return appendGap(flushPending(buffer), event.droppedFrames);
    }
    case "eof":
      return {
        ...appendNotice(flushPending(buffer), "This session's process exited."),
        stream: "exited",
      };
    case "state":
      switch (event.state) {
        case "connecting":
          return { ...buffer, stream: "attaching" };
        case "connected":
          return { ...buffer, stream: "live" };
        case "connectionLost":
          return { ...buffer, stream: "reconnecting" };
      }
  }
}

/// Marks the stream detached without claiming the process stopped. Detach is not
/// termination: the PTY keeps running on the Mac and the phone simply stopped
/// listening, so the view must not print anything that reads like an exit.
export function detachTerminalBuffer(buffer: TerminalBuffer): TerminalBuffer {
  if (buffer.stream === "exited") return buffer;
  return { ...buffer, stream: "detached" };
}

/// The cap notice, only once the cap has actually bitten. Stating a limit that has
/// not been reached would be noise.
export function terminalCapNotice(buffer: TerminalBuffer): string | undefined {
  /// The two renderers have different bounds, so the notice names the one that
  /// actually applies. Quoting the line cap while a screen is on display would state a
  /// limit that is not the one being enforced.
  if (buffer.screen !== undefined) {
    const dropped = buffer.screenDroppedLines;
    if (dropped === 0) return undefined;
    return `This phone keeps the last ${SCREEN_MAX_ROWS} rows of this screen. ${dropped} earlier ${dropped === 1 ? "row" : "rows"} scrolled out of its buffer.`;
  }
  const dropped = buffer.droppedLines;
  if (dropped === 0) return undefined;
  return `This phone keeps the last ${terminalGeometry.maxLines} lines. ${dropped} earlier ${dropped === 1 ? "line" : "lines"} scrolled out of its buffer.`;
}

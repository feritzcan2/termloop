import { describe, expect, it } from "vitest";

import { applyCarriageReturns, stripControlSequences } from "../../src/presentation/ansi";
import {
  detachTerminalBuffer,
  emptyTerminalBuffer,
  reduceTerminalEvent,
  terminalCapNotice,
  withTerminalScreen,
  type TerminalBuffer,
} from "../../src/presentation/terminal-buffer";
import { SCREEN_MAX_ROWS, DEFAULT_TERMINAL_STYLE } from "../../src/presentation/terminal-screen";
import { terminalGeometry } from "../../src/theme/tokens";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const options = { decode: (bytes: Uint8Array) => decoder.decode(bytes) };

function feed(buffer: TerminalBuffer, text: string, type: "replay" | "live" = "live"): TerminalBuffer {
  return reduceTerminalEvent(buffer, { type, bytes: encoder.encode(text) }, options);
}

function outputText(buffer: TerminalBuffer): string[] {
  return buffer.lines.filter((line) => line.kind === "output").map((line) => line.text);
}

describe("terminal line assembly", () => {
  it("keeps an unterminated line pending until its newline arrives", () => {
    let buffer = feed(emptyTerminalBuffer(), "Reading modules/gitio");
    expect(buffer.lines).toHaveLength(0);
    expect(buffer.pending).toBe("Reading modules/gitio");

    buffer = feed(buffer, "/src/worktree.rs\r\nnext");
    expect(outputText(buffer)).toEqual(["Reading modules/gitio/src/worktree.rs"]);
    expect(buffer.pending).toBe("next");
  });

  it("treats the CR of a CRLF pair as a terminator, not an overwrite", () => {
    /// Regression: taking the last carriage return in the segment found the CR of CRLF
    /// at the very end and blanked the line. Every CRLF-terminated line — which is most
    /// of what a PTY emits — rendered empty.
    const buffer = feed(emptyTerminalBuffer(), "first line\r\nsecond line\r\n");
    expect(outputText(buffer)).toEqual(["first line", "second line"]);
  });

  it("still overwrites when a carriage return sits mid-line before a CRLF", () => {
    const buffer = feed(emptyTerminalBuffer(), "stale\rfresh\r\n");
    expect(outputText(buffer)).toEqual(["fresh"]);
  });

  it("collapses a rewritten line to its final revision", () => {
    /// A bare carriage return means the emitter is overwriting what it just wrote, so a
    /// progress bar must not leave every frame in the log.
    const buffer = feed(emptyTerminalBuffer(), "10%\r55%\r100%\n");
    expect(outputText(buffer)).toEqual(["100%"]);
  });

  it("decodes a multi-byte character split across two frames", () => {
    /// A frame boundary inside a UTF-8 sequence must not become a replacement glyph.
    const bytes = encoder.encode("düşün\n");
    const split = 2;
    let buffer = reduceTerminalEvent(
      emptyTerminalBuffer(),
      { type: "live", bytes: bytes.slice(0, split) },
      options,
    );
    buffer = reduceTerminalEvent(buffer, { type: "live", bytes: bytes.slice(split) }, options);
    expect(outputText(buffer)).toEqual(["düşün"]);
  });
});

describe("honesty markers", () => {
  it("renders a dropped-frame gap as its own visible line", () => {
    let buffer = feed(emptyTerminalBuffer(), "before\n");
    buffer = reduceTerminalEvent(buffer, { type: "gap", droppedFrames: 2 }, options);
    const gap = buffer.lines.find((line) => line.kind === "gap");
    expect(gap?.text).toContain("2 frames");
    /// Bytes are never silently missing: the marker sits between what arrived before and
    /// what arrives after.
    buffer = feed(buffer, "after\n");
    expect(buffer.lines.map((line) => line.kind)).toEqual(["output", "gap", "output"]);
  });

  it("flushes a half-written line before a gap so the marker never lands mid-sentence", () => {
    let buffer = feed(emptyTerminalBuffer(), "half written");
    buffer = reduceTerminalEvent(buffer, { type: "gap", droppedFrames: 1 }, options);
    expect(buffer.pending).toBe("");
    expect(outputText(buffer)).toEqual(["half written"]);
    expect(buffer.lines[1]?.kind).toBe("gap");
  });

  it("coalesces consecutive dropped-frame gaps into one marker", () => {
    let buffer = reduceTerminalEvent(
      emptyTerminalBuffer(),
      { type: "gap", droppedFrames: 43 },
      options,
    );
    buffer = reduceTerminalEvent(buffer, { type: "gap", droppedFrames: 7 }, options);
    buffer = reduceTerminalEvent(buffer, { type: "gap", droppedFrames: 42 }, options);

    expect(buffer.lines).toHaveLength(1);
    expect(buffer.lines[0]).toMatchObject({ kind: "gap", droppedFrames: 92 });
    expect(buffer.lines[0]?.text).toContain("92 frames");
  });

  it("keeps separate gap markers when received output proves distinct holes", () => {
    let buffer = reduceTerminalEvent(
      emptyTerminalBuffer(),
      { type: "gap", droppedFrames: 2 },
      options,
    );
    buffer = feed(buffer, "between\n");
    buffer = reduceTerminalEvent(buffer, { type: "gap", droppedFrames: 3 }, options);

    expect(buffer.lines.map((line) => line.kind)).toEqual(["gap", "output", "gap"]);
  });

  it("states the buffer cap only once it has actually dropped lines", () => {
    let buffer = feed(emptyTerminalBuffer(), "one\n");
    expect(terminalCapNotice(buffer)).toBeUndefined();

    const flood = `${Array.from({ length: terminalGeometry.maxLines + 25 }, (_, index) => `line ${index}`).join("\n")}\n`;
    buffer = feed(buffer, flood);
    expect(buffer.lines).toHaveLength(terminalGeometry.maxLines);
    expect(buffer.droppedLines).toBe(26);
    expect(terminalCapNotice(buffer)).toContain("26 earlier lines");
    /// Ids are never reused, so a list key survives the cap biting.
    const ids = buffer.lines.map((line) => line.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBeGreaterThan(1);
  });

});

describe("stream state", () => {
  it("resets displayed bytes before a reconnect replay without reusing line ids", () => {
    const before = feed(emptyTerminalBuffer(), "old\n");
    const reset = reduceTerminalEvent(before, { type: "reset" }, options);
    expect(reset.lines).toEqual([]);
    expect(reset.stream).toBe("attaching");
    expect(reset.nextLineId).toBe(before.nextLineId);
  });

  it("maps the port's transport states onto the one header pill", () => {
    let buffer = reduceTerminalEvent(emptyTerminalBuffer(), { type: "state", state: "connecting" }, options);
    expect(buffer.stream).toBe("attaching");
    buffer = reduceTerminalEvent(buffer, { type: "state", state: "connected" }, options);
    expect(buffer.stream).toBe("live");
    const linesBeforeReconnect = buffer.lines;
    buffer = reduceTerminalEvent(buffer, { type: "state", state: "connectionLost" }, options);
    expect(buffer.stream).toBe("reconnecting");
    expect(buffer.lines).toBe(linesBeforeReconnect);
  });

  it("treats detach as leaving, not as the process stopping", () => {
    /// Detach is not termination. Nothing in the buffer may claim an exit.
    const detached = detachTerminalBuffer(feed(emptyTerminalBuffer(), "still running\n"));
    expect(detached.stream).toBe("detached");
    expect(detached.lines.some((line) => line.text.includes("exited"))).toBe(false);
  });

  it("does not let a detach overwrite a real exit", () => {
    const exited = reduceTerminalEvent(emptyTerminalBuffer(), { type: "eof" }, options);
    expect(exited.stream).toBe("exited");
    expect(detachTerminalBuffer(exited).stream).toBe("exited");
  });
});

describe("handover to the screen projector", () => {
  const screenLine = (text: string) => ({
    id: 1,
    spans: [{ text, style: DEFAULT_TERMINAL_STYLE }],
  });

  it("stops building line text while the projector owns the display", () => {
    /// A redraw stream would otherwise push hundreds of duplicate fragments through the
    /// cap on every frame, all of them hidden behind the screen.
    const buffer = reduceTerminalEvent(
      emptyTerminalBuffer(),
      { type: "live", bytes: encoder.encode("redraw fragment\n") },
      { ...options, screenActive: true },
    );
    expect(buffer.lines).toEqual([]);
    expect(buffer.pending).toBe("");
  });

  it("drops a half-written fallback line when the projector takes over", () => {
    const partial = feed(emptyTerminalBuffer(), "half written");
    const taken = reduceTerminalEvent(
      partial,
      { type: "live", bytes: encoder.encode("frame") },
      { ...options, screenActive: true },
    );
    expect(taken.pending).toBe("");
  });

  it("still records gaps and exits while a screen is on display", () => {
    let buffer = withTerminalScreen(emptyTerminalBuffer(), { lines: [screenLine("frame")], droppedLines: 0 });
    buffer = reduceTerminalEvent(buffer, { type: "gap", droppedFrames: 3 }, options);
    expect(buffer.lines.find((line) => line.kind === "gap")?.text).toContain("3 frames");
    expect(buffer.screen).not.toBeUndefined();
  });

  it("clears the screen when the projector hands the display back", () => {
    /// A screen left standing would freeze the phone on the last frame of a program
    /// that has already exited its TUI.
    const shown = withTerminalScreen(emptyTerminalBuffer(), { lines: [screenLine("frame")], droppedLines: 4 });
    const released = withTerminalScreen(shown, undefined);
    expect(released.screen).toBeUndefined();
    expect(released.screenDroppedLines).toBe(0);
  });

  it("states the bound that is actually being enforced", () => {
    const lineCapped = { ...emptyTerminalBuffer(), droppedLines: 12 };
    expect(terminalCapNotice(lineCapped)).toContain(`${terminalGeometry.maxLines} lines`);

    const screenCapped = withTerminalScreen(emptyTerminalBuffer(), {
      lines: [screenLine("frame")],
      droppedLines: 7,
    });
    const notice = terminalCapNotice(screenCapped);
    expect(notice).toContain(`${SCREEN_MAX_ROWS} rows`);
    expect(notice).toContain("7 earlier rows");
  });
});

describe("control sequence reduction", () => {
  it("removes colour, cursor movement, and window-title escapes", () => {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    expect(stripControlSequences(`${esc}[32mready${esc}[0m`)).toBe("ready");
    expect(stripControlSequences(`${esc}[2K${esc}[1Gredrawn`)).toBe("redrawn");
    expect(stripControlSequences(`${esc}]0;termloop${bel}prompt`)).toBe("prompt");
  });

  it("keeps tabs and ordinary text while dropping other C0 controls", () => {
    expect(stripControlSequences("a\tb")).toBe("a\tb");
    expect(stripControlSequences(`a${String.fromCharCode(0x00)}b${String.fromCharCode(0x7f)}`)).toBe("ab");
  });

  it("leaves no bare escape byte visible when a chunk ends mid-sequence", () => {
    const esc = String.fromCharCode(0x1b);
    expect(stripControlSequences(`text${esc}`)).toBe("text");
  });

  it("returns the whole line when it holds no carriage return", () => {
    expect(applyCarriageReturns("plain")).toBe("plain");
  });
});

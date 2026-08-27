import { describe, expect, it } from "vitest";

import {
  SCREEN_MAX_ROWS,
  TerminalScreenProjection,
  type TerminalScreenSnapshot,
  type TerminalSpan,
} from "../../src/presentation/terminal-screen";
import { color } from "../../src/theme/tokens";

const encoder = new TextEncoder();
const esc = String.fromCharCode(0x1b);

function plain(snapshot: TerminalScreenSnapshot | undefined): string[] {
  return (snapshot?.lines ?? []).map((line) => line.spans.map((span) => span.text).join(""));
}

function spansOf(snapshot: TerminalScreenSnapshot | undefined, row: number): readonly TerminalSpan[] {
  return snapshot?.lines[row]?.spans ?? [];
}

describe("terminal screen projection", () => {
  it("leaves normal Codex and shell output on the line-oriented path", () => {
    const projection = new TerminalScreenProjection();
    expect(projection.write(encoder.encode("Codex output\r\n"))).toBeUndefined();
    expect(projection.write(encoder.encode("still streaming\r\n"))).toBeUndefined();
  });

  it("renders a Claude-style cursor-addressed screen with no newline bytes", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(
      `${esc}[?1049h${esc}[2J${esc}[1;1HClaude${String.fromCharCode(0x0d)}${esc}[2BReady`,
    ));
    expect(plain(snapshot)).toEqual(["Claude", "", "Ready"]);
  });

  it("applies redraws instead of exposing stale cursor-addressed text", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[?1049h${esc}[1;1Hstale`));
    const snapshot = projection.write(encoder.encode(`${esc}[1;1Hready${esc}[K`));
    expect(plain(snapshot)).toEqual(["ready"]);
  });

  it("carries an escape sequence split across transport frames", () => {
    const projection = new TerminalScreenProjection();
    expect(projection.write(encoder.encode(`${esc}[?104`))).toBeUndefined();
    const snapshot = projection.write(encoder.encode(`9h${esc}[4;3Hsplit`));
    expect(plain(snapshot)).toEqual(["  split"]);
  });
});

describe("late attach", () => {
  /// The daemon replays a bounded ring of recent bytes, so the alternate-screen enable
  /// a TUI sent at launch is long gone by the time a phone attaches. Waiting for that
  /// byte meant the projector never activated and Claude's redraws were flattened into
  /// unreadable line fragments.
  it("claims the display from cursor addressing alone, with no alternate-screen enable", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(`${esc}[3;1Hmid-session frame`));
    /// Leading blank rows are trimmed, so an addressed frame reads from its first
    /// painted row rather than from the top of the grid.
    expect(plain(snapshot)).toEqual(["mid-session frame"]);
  });

  it("claims the display when a program redraws over output it already emitted", () => {
    const projection = new TerminalScreenProjection();
    expect(projection.write(encoder.encode("thinking\r\n"))).toBeUndefined();
    /// Cursor-up then rewrite is the signature of an in-place redraw.
    const snapshot = projection.write(encoder.encode(`${esc}[1A${esc}[Kdone`));
    expect(plain(snapshot)).toEqual(["done"]);
  });

  it("keeps ownership sticky once a stream has proved it redraws", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[2;1Hframe`));
    /// A plain chunk after the claim must not fall back mid-session.
    expect(projection.write(encoder.encode(" tail"))).not.toBeUndefined();
  });

  it("hands the display back when a TUI leaves the alternate screen", () => {
    const projection = new TerminalScreenProjection();
    expect(projection.write(encoder.encode(`${esc}[?1049h${esc}[1;1Hframe`))).not.toBeUndefined();
    expect(projection.write(encoder.encode(`${esc}[?1049l`))).toBeUndefined();
  });
});

describe("discovered geometry", () => {
  /// Mobile sends no resize and the attach ack carries no dimensions, so the grid must
  /// follow what the stream addresses. A fixed 80 columns wrapped every row of a
  /// desktop-sized Claude frame in the wrong place.
  it("grows past 80 columns rather than wrapping a wider frame", () => {
    const projection = new TerminalScreenProjection();
    const wide = "x".repeat(120);
    const snapshot = projection.write(encoder.encode(`${esc}[1;1H${wide}`));
    expect(plain(snapshot)).toEqual([wide]);
  });

  it("grows past 24 rows rather than scrolling a taller frame off the top", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(`${esc}[1;1Htop${esc}[40;1Hbottom`));
    const lines = plain(snapshot);
    expect(lines[0]).toBe("top");
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)).toBe("bottom");
  });

  it("discovers height from a declared scroll region", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(`${esc}[1;50r${esc}[50;1Hfloor`));
    expect(plain(snapshot).at(-1)).toBe("floor");
  });

  it("does not creep a row taller on every frame that ends with a newline", () => {
    const projection = new TerminalScreenProjection();
    const frame = `${esc}[2J${esc}[1;1H${["a", "b", "c"].join("\r\n")}\r\n`;
    projection.write(encoder.encode(`${esc}[?1049h${frame}`));
    const first = plain(projection.write(encoder.encode(frame)));
    const second = plain(projection.write(encoder.encode(frame)));
    expect(first).toEqual(["a", "b", "c"]);
    expect(second).toEqual(first);
  });

  it("does not report dropped rows for a frame that fits", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(`${esc}[?1049h${esc}[1;1Hframe`));
    expect(snapshot?.droppedLines).toBe(0);
  });

  it("counts rows that scrolled off once the bound is reached", () => {
    const projection = new TerminalScreenProjection();
    const flood = `${esc}[1;1H${Array.from({ length: SCREEN_MAX_ROWS + 10 }, (_, index) => `row ${index}`).join("\r\n")}`;
    const snapshot = projection.write(encoder.encode(flood));
    expect(snapshot?.droppedLines).toBe(10);
    expect(plain(snapshot).at(-1)).toBe(`row ${SCREEN_MAX_ROWS + 9}`);
  });
});

describe("normal-screen scrollback", () => {
  it("keeps the expanded Codex scrollback budget", () => {
    expect(SCREEN_MAX_ROWS).toBe(4800);
  });

  it("keeps lines scrolled out of a top-anchored Codex-style viewport", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(
      `${esc}[1;3r${esc}[1;1Hone\r\ntwo\r\nthree\r\nfour`,
    ));

    expect(plain(snapshot)).toEqual(["one", "two", "three", "four"]);
  });

  it("does not turn a partial panel redraw into transcript history", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(
      `${esc}[2;3r${esc}[2;1Hpanel one\r\npanel two\r\npanel three`,
    ));

    expect(plain(snapshot)).not.toContain("panel one");
    expect(plain(snapshot)).toEqual(["panel two", "panel three"]);
  });

  it("does not retain emulator scrollback for an alternate-screen TUI", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(
      `${esc}[?1049h${esc}[1;3r${esc}[1;1Hone\r\ntwo\r\nthree\r\nfour`,
    ));

    expect(plain(snapshot)).not.toContain("one");
    expect(plain(snapshot)).toEqual(["two", "three", "four"]);
  });

  it("bounds scrollback together with the current screen", () => {
    const projection = new TerminalScreenProjection();
    const transcript = Array.from(
      { length: SCREEN_MAX_ROWS + 25 },
      (_, index) => `line ${index}`,
    ).join("\r\n");
    const snapshot = projection.write(encoder.encode(`${esc}[1;3r${esc}[1;1H${transcript}`));

    expect(snapshot?.lines.length).toBeLessThanOrEqual(SCREEN_MAX_ROWS);
    expect((snapshot?.lines.length ?? 0) + (snapshot?.droppedLines ?? 0)).toBe(SCREEN_MAX_ROWS + 25);
    expect(plain(snapshot).at(-1)).toBe(`line ${SCREEN_MAX_ROWS + 24}`);
  });

  it("clears saved scrollback when the terminal requests ED3", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[1;2r${esc}[1;1Hbefore\r\nafter\r\nlatest`));
    const snapshot = projection.write(encoder.encode(`${esc}[3J${esc}[1;1Hfresh`));

    expect(plain(snapshot)).toEqual(["fresh"]);
    expect(snapshot?.droppedLines).toBe(0);
  });
});

describe("styling", () => {
  it("carries foreground colour through as spans", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(
      `${esc}[1;1H${esc}[32mok${esc}[0m plain`,
    ));
    const spans = spansOf(snapshot, 0);
    expect(spans.map((span) => span.text)).toEqual(["ok", " plain"]);
    expect(spans[0]?.style.foreground).not.toBe(spans[1]?.style.foreground);
    expect(spans[1]?.style.foreground).toBe(color.text);
  });

  it("resolves 256-colour and truecolor selectors", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(
      `${esc}[1;1H${esc}[38;5;196ma${esc}[38;2;18;52;86mb`,
    ));
    const spans = spansOf(snapshot, 0);
    expect(spans[0]?.style.foreground).toBe("#ff0000");
    expect(spans[1]?.style.foreground).toBe("#123456");
  });

  it("keeps bold and faint distinguishable rather than collapsing both to plain text", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(
      `${esc}[1;1H${esc}[1mloud${esc}[22m ${esc}[2mquiet`,
    ));
    const spans = spansOf(snapshot, 0);
    expect(spans[0]?.style.bold).toBe(true);
    expect(spans.at(-1)?.style.bold).toBe(false);
    expect(spans.at(-1)?.style.foreground).toContain("rgba");
  });

  it("swaps foreground and background for inverse text", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(`${esc}[1;1H${esc}[7msel`));
    const span = spansOf(snapshot, 0)[0];
    expect(span?.style.foreground).toBe(color.bgTerminal);
    expect(span?.style.background).toBe(color.text);
  });

  it("keeps a painted trailing run but drops unpainted padding", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(`${esc}[1;1Hedge${esc}[44m  `));
    const spans = spansOf(snapshot, 0);
    expect(spans.at(-1)?.text).toBe("  ");
    expect(spans.at(-1)?.style.background).not.toBeUndefined();
  });

  it("reuses the span array for a row a redraw left unchanged", () => {
    const projection = new TerminalScreenProjection();
    const frame = `${esc}[2J${esc}[1;1Hstable${esc}[2;1H`;
    projection.write(encoder.encode(`${esc}[?1049h${frame}first`));
    const before = projection.snapshot().lines[0]?.spans;
    const after = plain(projection.write(encoder.encode(`${frame}second`)));
    expect(after).toEqual(["stable", "second"]);
    /// Referential stability is what lets the view skip the row instead of
    /// reconciling every row of every frame.
    expect(projection.snapshot().lines[0]?.spans).toBe(before);
  });
});

describe("mouse tracking", () => {
  /// Scrolling a TUI's own history means sending it input, so the projector has to know
  /// whether the program will read that input as a wheel report or as text.
  it("starts unknown rather than assuming a program does not track the mouse", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[1;1Hlate attach`));
    expect(projection.mouseTracking).toBe("unknown");
    expect(projection.sgrMouseEncoding).toBe(false);
  });

  it("records the tracking mode and encoding a TUI enables", () => {
    const projection = new TerminalScreenProjection();
    /// What Claude Code sets.
    projection.write(encoder.encode(`${esc}[?1003h${esc}[?1006h`));
    expect(projection.mouseTracking).toBe("any");
    expect(projection.sgrMouseEncoding).toBe(true);
  });

  it("reads a combined enable", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[?1002;1006h`));
    expect(projection.mouseTracking).toBe("button");
    expect(projection.sgrMouseEncoding).toBe(true);
  });

  it("separates a disable from never having been told", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[?1003h`));
    projection.write(encoder.encode(`${esc}[?1003l`));
    expect(projection.mouseTracking).toBe("none");
  });

  it("keeps press-only X10 tracking distinct, since it has no wheel vocabulary", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[?9h`));
    expect(projection.mouseTracking).toBe("x10");
  });
});

describe("glyph placement", () => {
  it("keeps a surrogate pair split across transport frames as one glyph", () => {
    const projection = new TerminalScreenProjection();
    const bytes = encoder.encode(`${esc}[1;1H✅ done`);
    const emoji = encoder.encode("🚀");
    projection.write(bytes);
    /// Split inside the pair: a lone half is not a character.
    projection.write(emoji.slice(0, 2));
    const snapshot = projection.write(emoji.slice(2));
    expect(plain(snapshot)[0]).toContain("🚀");
    expect(plain(snapshot)[0]).not.toContain("�");
  });

  it("advances two columns for a wide glyph so the rest of the row stays aligned", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(`${esc}[1;1H漢字${esc}[1;5Hnext`));
    expect(plain(snapshot)[0]).toBe("漢字next");
  });

  it("attaches a variation selector to the glyph before it", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(`${esc}[1;1H✳️ x`));
    expect(plain(snapshot)[0]).toBe("✳️ x");
  });
});

describe("grid editing", () => {
  it("erases a run of characters in place", () => {
    const projection = new TerminalScreenProjection();
    const snapshot = projection.write(encoder.encode(`${esc}[1;1Habcdef${esc}[1;2H${esc}[3X`));
    expect(plain(snapshot)).toEqual(["a   ef"]);
  });

  it("deletes and inserts characters within a row", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[1;1Habcdef${esc}[1;2H${esc}[2P`));
    const snapshot = projection.write(encoder.encode(`${esc}[1;2H${esc}[1@`));
    expect(plain(snapshot)).toEqual(["a def"]);
  });

  it("deletes and inserts whole lines", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[1;1Hone${esc}[2;1Htwo${esc}[3;1Hthree`));
    const snapshot = projection.write(encoder.encode(`${esc}[2;1H${esc}[1M`));
    expect(plain(snapshot)).toEqual(["one", "three"]);
  });

  it("scrolls down on reverse index at the top of the region", () => {
    const projection = new TerminalScreenProjection();
    projection.write(encoder.encode(`${esc}[1;1Hfirst${esc}[2;1Hsecond`));
    const snapshot = projection.write(encoder.encode(`${esc}[1;1H${esc}Mnew`));
    expect(plain(snapshot)).toEqual(["new", "first", "second"]);
  });
});

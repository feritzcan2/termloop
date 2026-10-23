import { describe, expect, it } from "vitest";

import {
  ACCESSORY_KEYS,
  NO_MODIFIERS,
  accessoryKeyText,
  characterChordText,
  liveInputText,
  parseKeySequence,
} from "../../src/presentation/terminal-keys";

const ctrl = { ...NO_MODIFIERS, ctrl: true };
const alt = { ...NO_MODIFIERS, alt: true };
const shift = { ...NO_MODIFIERS, shift: true };

describe("accessory keys", () => {
  it("sends the plain sequences the old fixed row sent", () => {
    expect(accessoryKeyText("escape")).toBe("\x1b");
    expect(accessoryKeyText("tab")).toBe("\t");
    expect(accessoryKeyText("interrupt")).toBe("\x03");
    expect(accessoryKeyText("eof")).toBe("\x04");
    expect(accessoryKeyText("up")).toBe("\x1b[A");
    expect(accessoryKeyText("down")).toBe("\x1b[B");
    expect(accessoryKeyText("right")).toBe("\x1b[C");
    expect(accessoryKeyText("left")).toBe("\x1b[D");
    expect(accessoryKeyText("enter")).toBe("\r");
  });

  it("sends Shift+Tab as back-tab, from its own key or from an armed Shift", () => {
    expect(accessoryKeyText("backtab")).toBe("\x1b[Z");
    expect(accessoryKeyText("tab", shift)).toBe("\x1b[Z");
  });

  it("encodes modified cursor and paging keys the way xterm does", () => {
    expect(accessoryKeyText("left", alt)).toBe("\x1b[1;3D");
    expect(accessoryKeyText("right", ctrl)).toBe("\x1b[1;5C");
    expect(accessoryKeyText("up", { ctrl: true, alt: false, shift: true })).toBe("\x1b[1;6A");
    expect(accessoryKeyText("pageUp")).toBe("\x1b[5~");
    expect(accessoryKeyText("pageDown", shift)).toBe("\x1b[6;2~");
    expect(accessoryKeyText("home")).toBe("\x1b[H");
  });

  it("deletes backwards, and a word backwards with Alt", () => {
    expect(accessoryKeyText("backspace")).toBe("\x7f");
    expect(accessoryKeyText("backspace", alt)).toBe("\x1b\x7f");
    expect(accessoryKeyText("backspace", ctrl)).toBe("\x08");
  });

  it("only lets moving and deleting keys repeat", () => {
    const repeatable = ACCESSORY_KEYS.filter((key) => key.repeatable).map((key) => key.id);
    expect(repeatable).not.toContain("enter");
    expect(repeatable).not.toContain("interrupt");
    expect(repeatable).toEqual(expect.arrayContaining(["up", "down", "left", "right", "backspace"]));
  });
});

describe("character chords", () => {
  it("folds Ctrl+letter into its control code regardless of case", () => {
    expect(characterChordText("r", ctrl)).toBe("\x12");
    expect(characterChordText("R", ctrl)).toBe("\x12");
    expect(characterChordText("c", ctrl)).toBe("\x03");
    expect(characterChordText("[", ctrl)).toBe("\x1b");
    expect(characterChordText(" ", ctrl)).toBe("\x00");
  });

  it("prefixes Alt with Escape and keeps Shift's capital", () => {
    expect(characterChordText("b", alt)).toBe("\x1bb");
    expect(characterChordText("b", { ...alt, shift: true })).toBe("\x1bB");
  });

  it("sends a character with no control form as typed instead of dropping it", () => {
    expect(characterChordText("é", ctrl)).toBe("é");
    expect(characterChordText("x", NO_MODIFIERS)).toBe("x");
  });
});

it("turns a phone newline into the terminal's carriage return", () => {
  expect(liveInputText("ls\n")).toBe("ls\r");
  expect(liveInputText("a\r\nb")).toBe("a\rb");
});

describe("custom key sequences", () => {
  it("reads the documented escapes", () => {
    expect(parseKeySequence("\\cR")).toEqual({ ok: true, text: "\x12" });
    expect(parseKeySequence("\\e[A")).toEqual({ ok: true, text: "\x1b[A" });
    expect(parseKeySequence("\\x1bb")).toEqual({ ok: true, text: "\x1bb" });
    expect(parseKeySequence("\\u00e9")).toEqual({ ok: true, text: "é" });
    expect(parseKeySequence("git status\\r")).toEqual({ ok: true, text: "git status\r" });
    expect(parseKeySequence("a\\\\b\\t")).toEqual({ ok: true, text: "a\\b\t" });
  });

  it("keeps other text literal", () => {
    expect(parseKeySequence(":wq")).toEqual({ ok: true, text: ":wq" });
  });

  it.each(["", "\\", "\\q", "\\x1", "\\u12", "\\c1"])("refuses %j with a reason", (source) => {
    const parsed = parseKeySequence(source);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
  });
});

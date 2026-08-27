import { describe, expect, it } from "vitest";
import { clipboardKeyDecision } from "../src/renderer/terminal/xterm/clipboard.js";

function chord(overrides: Partial<{
  type: string;
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}>): Parameters<typeof clipboardKeyDecision>[0] {
  return {
    type: "keydown",
    key: "v",
    code: "KeyV",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe("explicit clipboard chords", () => {
  it("pastes on Ctrl+Shift+V keydown", () => {
    const decision = clipboardKeyDecision(
      chord({ key: "V", ctrlKey: true, shiftKey: true }),
      false,
    );
    expect(decision).toEqual({ handled: true, action: "paste" });
  });

  it("consumes the non-keydown phases of the paste chord without re-pasting", () => {
    for (const type of ["keypress", "keyup"]) {
      const decision = clipboardKeyDecision(
        chord({ type, key: "V", ctrlKey: true, shiftKey: true }),
        false,
      );
      expect(decision).toEqual({ handled: true, action: null });
    }
  });

  it("copies on Ctrl+Shift+C keydown when a selection exists", () => {
    const decision = clipboardKeyDecision(
      chord({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }),
      true,
    );
    expect(decision).toEqual({ handled: true, action: "copy" });
  });

  it("lets Ctrl+Shift+C fall through to xterm without a selection", () => {
    const decision = clipboardKeyDecision(
      chord({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }),
      false,
    );
    expect(decision).toEqual({ handled: false, action: null });
  });

  it("leaves plain Ctrl+V untouched so apps still receive ^V", () => {
    const decision = clipboardKeyDecision(chord({ ctrlKey: true }), false);
    expect(decision).toEqual({ handled: false, action: null });
  });

  it("leaves plain Ctrl+C untouched so apps still receive ^C", () => {
    const decision = clipboardKeyDecision(
      chord({ key: "c", code: "KeyC", ctrlKey: true }),
      true,
    );
    expect(decision).toEqual({ handled: false, action: null });
  });

  it("leaves macOS Cmd+V flows untouched", () => {
    const decision = clipboardKeyDecision(chord({ metaKey: true }), false);
    expect(decision).toEqual({ handled: false, action: null });
  });

  it("ignores Alt/AltGr combinations", () => {
    const decision = clipboardKeyDecision(
      chord({ ctrlKey: true, shiftKey: true, altKey: true }),
      false,
    );
    expect(decision).toEqual({ handled: false, action: null });
  });

  it("prefers the layout-resolved key over the physical position", () => {
    // A layout where the key at physical KeyV yields "c": chord means copy.
    const decision = clipboardKeyDecision(
      chord({ key: "c", code: "KeyV", ctrlKey: true, shiftKey: true }),
      true,
    );
    expect(decision).toEqual({ handled: true, action: "copy" });
  });

  it("falls back to the physical key when the layout yields no letter", () => {
    const decision = clipboardKeyDecision(
      chord({ key: "Process", ctrlKey: true, shiftKey: true }),
      false,
    );
    expect(decision).toEqual({ handled: true, action: "paste" });
  });
});

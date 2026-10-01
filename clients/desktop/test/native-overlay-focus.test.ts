// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreTerminalFocusAfterOverlay } from "../src/renderer/composition/native-overlay-window.js";

describe("terminal focus after closing an overlay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("restores terminal focus after two frames when no editor takes focus", () => {
    const focus = vi.fn();
    restoreTerminalFocusAfterOverlay(focus);
    vi.advanceTimersToNextFrame();
    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each(["input", "textarea", "select"])("keeps focus in a %s opened before restoration runs", (tag) => {
    const focus = vi.fn();
    restoreTerminalFocusAfterOverlay(focus);
    vi.advanceTimersToNextFrame();
    const editor = document.createElement(tag);
    document.body.append(editor);
    editor.focus();
    vi.advanceTimersToNextFrame();
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it.each([0, 1])("cancels pending focus restoration after %s frames", (frames) => {
    const focus = vi.fn();
    const cancel = restoreTerminalFocusAfterOverlay(focus);
    for (let index = 0; index < frames; index++) vi.advanceTimersToNextFrame();
    cancel();
    vi.runAllTimers();
    expect(focus).not.toHaveBeenCalled();
  });
});

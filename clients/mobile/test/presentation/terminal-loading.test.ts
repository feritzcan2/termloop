import { describe, expect, it } from "vitest";

import { nextTerminalLoadingProgress } from "../../src/presentation/terminal-loading";

describe("terminal loading progress", () => {
  it("moves quickly at first and slows near completion", () => {
    expect(nextTerminalLoadingProgress(0, false)).toBe(4);
    expect(nextTerminalLoadingProgress(70, false)).toBe(72);
    expect(nextTerminalLoadingProgress(90, false)).toBe(91);
  });

  it("waits below completion while terminal content is absent", () => {
    expect(nextTerminalLoadingProgress(98, false)).toBe(98);
    expect(nextTerminalLoadingProgress(100, false)).toBe(98);
  });

  it("completes only after terminal content is available", () => {
    expect(nextTerminalLoadingProgress(42, true)).toBe(100);
    expect(nextTerminalLoadingProgress(98, true)).toBe(100);
  });
});

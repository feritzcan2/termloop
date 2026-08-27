import { describe, expect, it } from "vitest";
import { terminalRendererFor } from "../src/platform/terminal-renderer.js";

describe("requested terminal renderer", () => {
  it.each([
    ["darwin", undefined, "ghostty"],
    ["darwin", "xterm", "xterm"],
    ["darwin", "ghostty", "ghostty"],
    ["darwin", "", "ghostty"],
    ["darwin", "invalid", "ghostty"],
    ["linux", undefined, "xterm"],
    ["linux", "ghostty", "xterm"],
    ["win32", undefined, "xterm"],
    ["win32", "ghostty", "xterm"],
  ] as const)("uses %s + %s as %s", (platform, requested, expected) => {
    expect(terminalRendererFor(platform, requested)).toBe(expected);
  });
});

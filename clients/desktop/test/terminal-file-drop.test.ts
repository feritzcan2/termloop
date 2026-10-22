import { describe, expect, it } from "vitest";
import {
  MAX_DROPPED_PATHS,
  dropTargetShell,
  droppedPathsText,
  shellEscapeDroppedPath,
} from "../src/renderer/terminal-file-drop.js";

describe("terminal file drop", () => {
  it("keeps plain POSIX paths raw so agent TUIs recognize dropped images", () => {
    expect(shellEscapeDroppedPath("/Users/me/Desktop/shot-1.png", "posix")).toBe("/Users/me/Desktop/shot-1.png");
  });

  it("backslash-escapes POSIX shell metacharacters into one word", () => {
    expect(shellEscapeDroppedPath("/tmp/Screen Shot (1).png", "posix")).toBe("/tmp/Screen\\ Shot\\ \\(1\\).png");
    expect(shellEscapeDroppedPath("/tmp/it's $HOME;`x`", "posix")).toBe("/tmp/it\\'s\\ \\$HOME\\;\\`x\\`");
  });

  it("refuses paths whose control characters would submit the prompt", () => {
    expect(shellEscapeDroppedPath("/tmp/a\nrm -rf ~", "posix")).toBeUndefined();
    expect(shellEscapeDroppedPath("C:\\a\rb", "windows")).toBeUndefined();
  });

  it("double-quotes Windows paths with spaces and refuses embedded quotes", () => {
    expect(shellEscapeDroppedPath("C:\\repo\\a.ts", "windows")).toBe("C:\\repo\\a.ts");
    expect(shellEscapeDroppedPath("C:\\My Files\\a.png", "windows")).toBe("\"C:\\My Files\\a.png\"");
    expect(shellEscapeDroppedPath("C:\\a\"b", "windows")).toBeUndefined();
  });

  it("joins words with spaces and ends with one separating space", () => {
    expect(droppedPathsText(["/a.ts", "/b c.png"], "posix")).toEqual({ text: "/a.ts /b\\ c.png ", skipped: 0 });
  });

  it("reports refused and over-limit paths without pasting them", () => {
    expect(droppedPathsText(["/ok", "/bad\u0007"], "posix")).toEqual({ text: "/ok ", skipped: 1 });
    expect(droppedPathsText([], "posix")).toEqual({ text: "", skipped: 0 });
    const many = Array.from({ length: MAX_DROPPED_PATHS + 2 }, (_, index) => `/f${index}`);
    expect(droppedPathsText(many, "posix").skipped).toBe(2);
  });

  it("chooses the target shell from the renderer platform", () => {
    expect(dropTargetShell("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(dropTargetShell("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("posix");
  });
});

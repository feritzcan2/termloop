import { describe, expect, it } from "vitest";
import { windowFrameOptions } from "../src/platform/window-frame.js";

describe("cross-platform window frame", () => {
  it("hides the title bar behind the traffic-light inset only on macOS", () => {
    expect(windowFrameOptions("darwin")).toEqual({ titleBarStyle: "hiddenInset" });
  });

  it("keeps the default native frame and controls on Windows and Linux", () => {
    expect(windowFrameOptions("win32")).toEqual({});
    expect(windowFrameOptions("linux")).toEqual({});
  });
});

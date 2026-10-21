import { describe, expect, it } from "vitest";

import { autoUpdateSupported } from "../src/platform/auto-update-policy.js";

describe("desktop auto-update platform policy", () => {
  it("never updates unpackaged development applications", () => {
    expect(autoUpdateSupported(false, "darwin")).toBe(false);
    expect(autoUpdateSupported(false, "win32")).toBe(false);
  });

  it("supports packaged macOS and Windows applications", () => {
    expect(autoUpdateSupported(true, "darwin")).toBe(true);
    expect(autoUpdateSupported(true, "win32")).toBe(true);
  });

  it("does not update Linux applications without a published feed", () => {
    expect(autoUpdateSupported(true, "linux")).toBe(false);
  });
});

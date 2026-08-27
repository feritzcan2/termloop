import { describe, expect, it } from "vitest";
import { createClientLaunchId } from "../src/platform/client-launch.js";

describe("Electron client launch identity", () => {
  it("creates bounded contract-safe unique process launch ids", () => {
    const first = createClientLaunchId();
    const second = createClientLaunchId();
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

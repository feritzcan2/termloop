import { describe, expect, it } from "vitest";

import { reduceAppLifecycle } from "../src/platform/app-lifecycle-state";

describe("mobile app lifecycle", () => {
  it("keeps sockets active while iOS system UI temporarily owns focus", () => {
    const active = { active: true, backgrounded: false, foregroundRevision: 3 };

    expect(reduceAppLifecycle(active, "inactive")).toBe(active);
    expect(reduceAppLifecycle(active, "active")).toBe(active);
  });

  it("reconnects exactly once after a real background transition", () => {
    const active = { active: true, backgrounded: false, foregroundRevision: 3 };
    const backgrounded = reduceAppLifecycle(active, "background");

    expect(backgrounded).toEqual({ active: false, backgrounded: true, foregroundRevision: 3 });
    expect(reduceAppLifecycle(backgrounded, "inactive")).toBe(backgrounded);
    expect(reduceAppLifecycle(backgrounded, "active")).toEqual({
      active: true,
      backgrounded: false,
      foregroundRevision: 4,
    });
  });
});

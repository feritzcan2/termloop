import { describe, expect, it } from "vitest";

import {
  reduceAppLifecycle,
  shouldInferForegroundAfterGap,
} from "../src/platform/app-lifecycle-state";

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

  it("infers a foreground epoch after iOS suspends JavaScript without lifecycle events", () => {
    const active = { active: true, backgrounded: false, foregroundRevision: 3 };

    expect(shouldInferForegroundAfterGap(active, "active", 9_999)).toBe(false);
    expect(shouldInferForegroundAfterGap(active, "inactive", 30_000)).toBe(false);
    expect(shouldInferForegroundAfterGap(active, "active", 10_000)).toBe(true);
    expect(reduceAppLifecycle(active, {
      nativeState: "active",
      resumeAfterGap: true,
    })).toEqual({
      active: true,
      backgrounded: false,
      foregroundRevision: 4,
    });
  });
});

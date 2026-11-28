import { describe, expect, it } from "vitest";

import { mobileSentryEnvironment } from "../src/platform/sentry-environment";

describe("mobile Sentry environment", () => {
  it("separates locally signed builds from App Store and TestFlight builds", () => {
    expect(mobileSentryEnvironment(() => true)).toBe("local");
    expect(mobileSentryEnvironment(() => false)).toBe("production");
  });

  it("falls back to production when the bundle cannot be inspected", () => {
    expect(mobileSentryEnvironment(() => {
      throw new Error("unavailable");
    })).toBe("production");
  });
});

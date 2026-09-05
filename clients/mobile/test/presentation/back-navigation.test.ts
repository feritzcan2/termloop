import { describe, expect, it } from "vitest";

import { backNavigationAction } from "../../src/presentation/back-navigation";

describe("detail-screen back navigation", () => {
  it("uses history when one exists", () => {
    expect(backNavigationAction(true, false)).toBe("back");
  });

  it("stays inside the app when a restored route has no history", () => {
    expect(backNavigationAction(false, false)).toBe("fallback");
  });

  it("prefers an exact parent even when unrelated history exists", () => {
    expect(backNavigationAction(true, true)).toBe("dismissTo");
    expect(backNavigationAction(false, true)).toBe("dismissTo");
  });
});

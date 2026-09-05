import { describe, expect, it } from "vitest";

import { backNavigationAction } from "../../src/presentation/back-navigation";

describe("detail-screen back navigation", () => {
  it("uses history when one exists", () => {
    expect(backNavigationAction(true)).toBe("back");
  });

  it("stays inside the app when a restored route has no history", () => {
    expect(backNavigationAction(false)).toBe("fallback");
  });
});

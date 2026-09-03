import { describe, expect, it } from "vitest";

import {
  SESSION_SWIPE_ACTION_WIDTH,
  sessionSwipeTranslation,
  settledSessionSwipeTranslation,
} from "../../src/presentation/session-swipe-presentation";

describe("mobile Session swipe action", () => {
  it("reveals only the bounded trailing action", () => {
    expect(sessionSwipeTranslation(0, -24)).toBe(-24);
    expect(sessionSwipeTranslation(0, -200)).toBe(-SESSION_SWIPE_ACTION_WIDTH);
    expect(sessionSwipeTranslation(-SESSION_SWIPE_ACTION_WIDTH, 200)).toBe(0);
  });

  it("opens past halfway or on an intentional flick and otherwise closes", () => {
    expect(settledSessionSwipeTranslation(-50, 0)).toBe(-SESSION_SWIPE_ACTION_WIDTH);
    expect(settledSessionSwipeTranslation(-10, -0.7)).toBe(-SESSION_SWIPE_ACTION_WIDTH);
    expect(settledSessionSwipeTranslation(-80, 0.7)).toBe(0);
    expect(settledSessionSwipeTranslation(-20, 0)).toBe(0);
  });
});

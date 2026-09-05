// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  appearanceTheme,
  initializeAppearanceTheme,
  readAppearanceTheme,
  setAppearanceTheme,
  subscribeAppearanceTheme,
} from "../src/renderer/appearance-theme.js";

describe("appearance theme", () => {
  beforeEach(() => {
    setAppearanceTheme("dark");
    window.localStorage.clear();
  });

  it("defaults invalid or missing stored values to dark", () => {
    expect(readAppearanceTheme()).toBe("dark");
    window.localStorage.setItem("termloop.appearance-theme", "system");
    expect(readAppearanceTheme()).toBe("dark");
  });

  it("restores, applies, publishes, and persists the light theme", () => {
    window.localStorage.setItem("termloop.appearance-theme", "light");
    const changed = vi.fn();
    const unsubscribe = subscribeAppearanceTheme(changed);

    expect(initializeAppearanceTheme()).toBe("light");
    expect(appearanceTheme()).toBe("light");
    expect(document.documentElement.dataset.appearance).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(changed).toHaveBeenCalledTimes(1);

    setAppearanceTheme("dark");
    expect(window.localStorage.getItem("termloop.appearance-theme")).toBe("dark");
    expect(document.documentElement.dataset.appearance).toBe("dark");
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

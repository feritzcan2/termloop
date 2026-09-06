// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  appearancePreference,
  appearanceTheme,
  initializeAppearanceTheme,
  readAppearancePreference,
  setAppearancePreference,
  subscribeAppearancePreference,
  subscribeAppearanceTheme,
  type SystemAppearanceQuery,
} from "../src/renderer/appearance-theme.js";

function controllableSystemAppearance(initiallyDark: boolean) {
  let matches = initiallyDark;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query: SystemAppearanceQuery = {
    get matches() { return matches; },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return {
    query,
    change(dark: boolean) {
      matches = dark;
      for (const listener of listeners) listener({ matches });
    },
  };
}

describe("appearance theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    initializeAppearanceTheme(controllableSystemAppearance(true).query);
  });

  it("defaults invalid or missing stored values to system", () => {
    expect(readAppearancePreference()).toBe("system");
    window.localStorage.setItem("termloop.appearance-theme", "purple");
    expect(readAppearancePreference()).toBe("system");
  });

  it("restores, applies, publishes, and persists an explicit theme", () => {
    window.localStorage.setItem("termloop.appearance-theme", "light");
    const themeChanged = vi.fn();
    const preferenceChanged = vi.fn();
    const unsubscribeTheme = subscribeAppearanceTheme(themeChanged);
    const unsubscribePreference = subscribeAppearancePreference(preferenceChanged);

    expect(initializeAppearanceTheme(controllableSystemAppearance(true).query)).toBe("light");
    expect(appearancePreference()).toBe("light");
    expect(appearanceTheme()).toBe("light");
    expect(document.documentElement.dataset.appearance).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(themeChanged).toHaveBeenCalledTimes(1);
    expect(preferenceChanged).toHaveBeenCalledTimes(1);

    setAppearancePreference("dark");
    expect(window.localStorage.getItem("termloop.appearance-theme")).toBe("dark");
    expect(document.documentElement.dataset.appearance).toBe("dark");
    expect(themeChanged).toHaveBeenCalledTimes(2);
    expect(preferenceChanged).toHaveBeenCalledTimes(2);
    unsubscribeTheme();
    unsubscribePreference();
  });

  it("follows system appearance changes live without reinitializing", () => {
    const system = controllableSystemAppearance(true);
    const changed = vi.fn();
    const unsubscribe = subscribeAppearanceTheme(changed);

    expect(initializeAppearanceTheme(system.query)).toBe("dark");
    expect(appearancePreference()).toBe("system");
    expect(document.documentElement.dataset.appearance).toBe("dark");

    system.change(false);
    expect(appearanceTheme()).toBe("light");
    expect(document.documentElement.dataset.appearance).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(changed).toHaveBeenCalledTimes(2);

    setAppearancePreference("system");
    expect(window.localStorage.getItem("termloop.appearance-theme")).toBe("system");
    unsubscribe();
  });

  it("ignores system appearance changes while an explicit theme is selected", () => {
    const system = controllableSystemAppearance(true);
    initializeAppearanceTheme(system.query);
    setAppearancePreference("light");

    system.change(false);
    system.change(true);

    expect(appearancePreference()).toBe("light");
    expect(appearanceTheme()).toBe("light");
  });
});

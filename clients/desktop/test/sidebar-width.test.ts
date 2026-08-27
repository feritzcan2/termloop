import { describe, expect, it, vi } from "vitest";
import {
  clearSidebarWidth,
  readSidebarWidth,
  sidebarMaximumWidth,
  writeSidebarWidth,
} from "../src/renderer/sidebar-width.js";

function fakeStorage(initial: string | null = null) {
  let value = initial;
  return {
    get value() { return value; },
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
    removeItem: vi.fn(() => { value = null; }),
  };
}

describe("sidebar width preference", () => {
  it("starts at the maximum width allowed by the viewport when no preference exists", () => {
    expect(readSidebarWidth(1_200, fakeStorage())).toBe(480);
    expect(readSidebarWidth(700, fakeStorage())).toBe(340);
  });

  it("restores a user-selected width and clamps it to the current viewport", () => {
    expect(readSidebarWidth(1_200, fakeStorage("320"))).toBe(320);
    expect(readSidebarWidth(700, fakeStorage("420"))).toBe(340);
  });

  it("persists resizing and clears the preference on reset", () => {
    const storage = fakeStorage();
    writeSidebarWidth(312.4, storage);
    expect(storage.value).toBe("312");

    clearSidebarWidth(storage);
    expect(storage.value).toBeNull();
  });

  it("falls back to the allowed maximum for invalid or unavailable storage", () => {
    expect(readSidebarWidth(1_200, fakeStorage("not-a-width"))).toBe(480);
    expect(readSidebarWidth(1_200, { getItem: () => { throw new Error("blocked"); } })).toBe(480);
    expect(sidebarMaximumWidth(472)).toBe(190);
  });
});

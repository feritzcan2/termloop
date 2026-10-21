import { describe, expect, it } from "vitest";
import {
  FILES_SIDEBAR_DEFAULT_WIDTH,
  FILES_SIDEBAR_MAX_WIDTH,
  FILES_SIDEBAR_MIN_WIDTH,
  clampFilesSidebarWidth,
  filesSidebarMaximumWidth,
  readFilesSidebarPreference,
  writeFilesSidebarPreference,
} from "../src/renderer/files-sidebar-preference.js";

const memoryStorage = (initial: string | null = null) => {
  let value = initial;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
};

describe("Files sidebar preference", () => {
  it("defaults to a closed Explorer and round-trips the remembered layout", () => {
    const storage = memoryStorage();
    expect(readFilesSidebarPreference(storage)).toEqual({ open: false, width: FILES_SIDEBAR_DEFAULT_WIDTH });
    writeFilesSidebarPreference({ open: true, width: 360 }, storage);
    expect(readFilesSidebarPreference(storage)).toEqual({ open: true, width: 360 });
  });

  it("repairs malformed values and survives blocked storage", () => {
    expect(readFilesSidebarPreference(memoryStorage(JSON.stringify({ open: "yes", width: 99_999, tab: "search" }))))
      .toEqual({ open: false, width: FILES_SIDEBAR_MAX_WIDTH });
    expect(readFilesSidebarPreference(memoryStorage("not json")).open).toBe(false);
    expect(readFilesSidebarPreference({ getItem: () => { throw new Error("blocked"); } }).width).toBe(FILES_SIDEBAR_DEFAULT_WIDTH);
    expect(() => writeFilesSidebarPreference({ open: true, width: 300 }, { setItem: () => { throw new Error("full"); } })).not.toThrow();
  });

  it("keeps room for the terminal workspace beside both sidebars", () => {
    expect(filesSidebarMaximumWidth(1600, 300)).toBe(FILES_SIDEBAR_MAX_WIDTH);
    expect(filesSidebarMaximumWidth(1000, 300)).toBe(300);
    expect(filesSidebarMaximumWidth(700, 300)).toBe(FILES_SIDEBAR_MIN_WIDTH);
    expect(clampFilesSidebarWidth(100, 1600, 300)).toBe(FILES_SIDEBAR_MIN_WIDTH);
    expect(clampFilesSidebarWidth(500.4, 1000, 300)).toBe(300);
  });
});

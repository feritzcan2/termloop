import { describe, expect, it, vi } from "vitest";
import {
  changesFilesMaximumWidth,
  clampChangesFilesWidth,
  clearChangesFilesWidth,
  readChangesFilesWidth,
  writeChangesFilesWidth,
} from "../src/renderer/changes-files-width.js";

function fakeStorage(initial: string | null = null) {
  let value = initial;
  return {
    get value() { return value; },
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
    removeItem: vi.fn(() => { value = null; }),
  };
}

describe("changes file list width", () => {
  it("defaults to 300px and restores a stored width", () => {
    expect(readChangesFilesWidth(fakeStorage())).toBe(300);
    expect(readChangesFilesWidth(fakeStorage("garbage"))).toBe(300);
    expect(readChangesFilesWidth(fakeStorage("512"))).toBe(512);
  });

  it("keeps room for the diff and never shrinks below the minimum", () => {
    expect(changesFilesMaximumWidth(1_000)).toBe(640);
    expect(changesFilesMaximumWidth(2_000)).toBe(900);
    expect(changesFilesMaximumWidth(400)).toBe(220);
    expect(clampChangesFilesWidth(800, 1_000)).toBe(640);
    expect(clampChangesFilesWidth(100, 1_000)).toBe(220);
  });

  it("persists resizing and clears on reset", () => {
    const storage = fakeStorage();
    writeChangesFilesWidth(433.6, storage);
    expect(storage.value).toBe("434");
    clearChangesFilesWidth(storage);
    expect(storage.value).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { readTaskCollapsed, writeTaskCollapsed } from "../src/renderer/task-collapse-memory.js";

function fakeStorage(initial?: string): Pick<Storage, "getItem" | "setItem"> & { value: string | null } {
  const store = { value: initial ?? null } as { value: string | null };
  return {
    get value() { return store.value; },
    getItem: () => store.value,
    setItem: (_key: string, next: string) => { store.value = next; },
  };
}

describe("Task collapse memory", () => {
  it("remembers each Task disclosure state per Project", () => {
    const storage = fakeStorage();
    writeTaskCollapsed("project-1", "task-1", true, storage);
    writeTaskCollapsed("project-1", "task-2", false, storage);
    writeTaskCollapsed("project-2", "task-1", false, storage);

    expect(readTaskCollapsed("project-1", "task-1", false, storage)).toBe(true);
    expect(readTaskCollapsed("project-1", "task-2", true, storage)).toBe(false);
    expect(readTaskCollapsed("project-2", "task-1", true, storage)).toBe(false);
  });

  it("uses the status-derived default until a preference exists", () => {
    const storage = fakeStorage();
    expect(readTaskCollapsed("project-1", "task-1", true, storage)).toBe(true);
    expect(readTaskCollapsed("project-1", "task-1", false, storage)).toBe(false);
  });

  it("ignores corrupt or foreign stored values", () => {
    expect(readTaskCollapsed("project-1", "task-1", true, fakeStorage("not json"))).toBe(true);
    expect(readTaskCollapsed("project-1", "task-1", true, fakeStorage("[]"))).toBe(true);
    expect(readTaskCollapsed("project-1", "task-1", true, fakeStorage('{"project-1":{"task-1":"yes"}}'))).toBe(true);
  });
});

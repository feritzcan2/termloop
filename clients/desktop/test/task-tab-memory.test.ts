import { describe, expect, it } from "vitest";
import { readTaskTabSelection, writeTaskTabSelection } from "../src/renderer/task-tab-memory.js";

function memoryStorage(initial?: string): Storage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("termloop.taskTab.v1", initial);
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("Task tab memory", () => {
  it("keeps active and closed selections separate per Project", () => {
    const storage = memoryStorage();
    writeTaskTabSelection("project-1", "active", "task-active", storage);
    writeTaskTabSelection("project-1", "closed", "task-closed", storage);
    writeTaskTabSelection("project-2", "active", "task-other", storage);

    expect(readTaskTabSelection("project-1", "active", storage)).toBe("task-active");
    expect(readTaskTabSelection("project-1", "closed", storage)).toBe("task-closed");
    expect(readTaskTabSelection("project-2", "active", storage)).toBe("task-other");
  });

  it("ignores malformed or unavailable storage", () => {
    expect(readTaskTabSelection("project-1", "active", memoryStorage("not json"))).toBeUndefined();
    expect(readTaskTabSelection(undefined, "active", memoryStorage())).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { readParkedTaskIds, writeParkedTaskIds } from "../src/renderer/task-park-memory.js";

function memoryStorage(initial: string | null = null): Storage {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
    removeItem: () => { value = null; },
    clear: () => { value = null; },
    key: () => null,
    get length() { return value === null ? 0 : 1; },
  };
}

describe("Task park memory", () => {
  it("keeps parked Tasks project-scoped and preserves their order", () => {
    const storage = memoryStorage();
    writeParkedTaskIds("project-a", new Set(["task-2", "task-1"]), storage);
    writeParkedTaskIds("project-b", new Set(["task-3"]), storage);
    expect([...readParkedTaskIds("project-a", storage)]).toEqual(["task-2", "task-1"]);
    expect([...readParkedTaskIds("project-b", storage)]).toEqual(["task-3"]);
  });

  it("fails closed on malformed preference data", () => {
    expect([...readParkedTaskIds("project-a", memoryStorage("not-json"))]).toEqual([]);
  });
});

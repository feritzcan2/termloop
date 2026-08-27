import { describe, expect, it } from "vitest";
import { readFavoriteTaskIds, writeFavoriteTaskIds } from "../src/renderer/task-favorite-memory.js";

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

describe("Task favorite memory", () => {
  it("keeps favorites project-scoped and preserves their order", () => {
    const storage = memoryStorage();
    writeFavoriteTaskIds("project-a", new Set(["task-2", "task-1"]), storage);
    writeFavoriteTaskIds("project-b", new Set(["task-3"]), storage);
    expect([...readFavoriteTaskIds("project-a", storage)]).toEqual(["task-2", "task-1"]);
    expect([...readFavoriteTaskIds("project-b", storage)]).toEqual(["task-3"]);
  });

  it("fails closed on malformed preference data", () => {
    expect([...readFavoriteTaskIds("project-a", memoryStorage("not-json"))]).toEqual([]);
  });
});

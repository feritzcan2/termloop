import { describe, expect, it } from "vitest";
import { arrangeProjects, moveProject, moveProjectBy, orderProjects, readProjectOrder, writeProjectOrder } from "../src/renderer/project-order-memory.js";

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

const projects = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("Project order memory", () => {
  it("keeps the daemon order when nothing was arranged", () => {
    expect(orderProjects(projects, []).map((project) => project.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("puts remembered Projects first and appends new ones in daemon order", () => {
    expect(orderProjects(projects, ["c", "a"]).map((project) => project.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores remembered Projects that no longer exist", () => {
    expect(orderProjects(projects, ["gone", "d", "b"]).map((project) => project.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("moves a Project onto another Project's slot and returns a complete order", () => {
    expect(moveProject(projects, [], "d", "a")).toEqual(["d", "a", "b", "c"]);
    expect(moveProject(projects, [], "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveProject(projects, ["b", "a"], "c", "b")).toEqual(["c", "b", "a", "d"]);
  });

  it("leaves the order untouched for unknown or identical targets", () => {
    const order = ["b", "a"];
    expect(moveProject(projects, order, "a", "missing")).toBe(order);
    expect(moveProject(projects, order, "a", "a")).toBe(order);
  });

  it("moves a Project one step and stops at the edges", () => {
    expect(moveProjectBy(projects, [], "b", -1)).toEqual(["b", "a", "c", "d"]);
    expect(moveProjectBy(projects, [], "b", 1)).toEqual(["a", "c", "b", "d"]);
    const order = ["a", "b", "c", "d"];
    expect(moveProjectBy(projects, order, "a", -1)).toBe(order);
    expect(moveProjectBy(projects, order, "d", 1)).toBe(order);
  });

  it("sinks Projects on offline computers without forgetting their arranged place", () => {
    const sources = [
      { id: "a", connectionState: "offline" as const },
      { id: "b", connectionState: "connected" as const },
      { id: "c", connectionState: "offline" as const },
      { id: "d", connectionState: "connecting" as const },
    ];
    expect(arrangeProjects(sources, []).map((project) => project.id)).toEqual(["b", "d", "a", "c"]);
    expect(arrangeProjects(sources.map(({ id }) => ({ id })), ["c", "a"]).map((project) => project.id))
      .toEqual(["c", "a", "b", "d"]);
  });

  it("moves Projects only within their reachable or offline side", () => {
    const sources = [
      { id: "a", connectionState: "offline" as const },
      { id: "b", connectionState: "connected" as const },
      { id: "c", connectionState: "offline" as const },
      { id: "d", connectionState: "connected" as const },
    ];
    expect(moveProject(sources, [], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveProject(sources, [], "a", "c")).toEqual(["b", "c", "a", "d"]);
    const order = ["a", "b", "c", "d"];
    expect(moveProject(sources, order, "d", "a")).toBe(order);
    // Arranged as b, d | a, c: Alt+↓ on the last reachable Project stops at the boundary.
    expect(moveProjectBy(sources, order, "b", 1)).toEqual(["a", "c", "d", "b"]);
    expect(moveProjectBy(sources, order, "d", 1)).toBe(order);
    expect(moveProjectBy(sources, order, "a", -1)).toBe(order);
  });

  it("round-trips through preference storage and fails closed on bad data", () => {
    const storage = memoryStorage();
    writeProjectOrder(["b", "a"], storage);
    expect(readProjectOrder(storage)).toEqual(["b", "a"]);
    expect(readProjectOrder(memoryStorage("not-json"))).toEqual([]);
    expect(readProjectOrder(memoryStorage(JSON.stringify(["a", 3, "", "a", "b"])))).toEqual(["a", "b"]);
  });
});

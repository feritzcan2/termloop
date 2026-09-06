import { describe, expect, it } from "vitest";
import {
  readWorkspaceViewMemory,
  rememberWorkspaceView,
  workspaceViewForProject,
} from "../src/renderer/workspace-view-memory.js";

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

describe("workspace view memory", () => {
  it("restores each Project's last workspace view", () => {
    const storage = memoryStorage();
    let memory = readWorkspaceViewMemory(storage);
    memory = rememberWorkspaceView(memory, "project-a", "overview", storage);
    memory = rememberWorkspaceView(memory, "project-b", "steward", storage);
    memory = rememberWorkspaceView(memory, "project-map", "map", storage);

    expect(workspaceViewForProject(memory, "project-a")).toBe("overview");
    expect(workspaceViewForProject(memory, "project-b")).toBe("steward");
    expect(workspaceViewForProject(memory, "project-map")).toBe("map");
    expect(workspaceViewForProject(readWorkspaceViewMemory(storage), "project-a")).toBe("overview");
    expect(workspaceViewForProject(memory, "project-new")).toBe("agents");
  });

  it("ignores malformed Projects and unsupported views", () => {
    const storage = memoryStorage(JSON.stringify({
      "project-agents": "agents",
      "project-bad": "settings",
      "": "history",
    }));

    expect(readWorkspaceViewMemory(storage)).toEqual({ "project-agents": "agents" });
    expect(workspaceViewForProject(readWorkspaceViewMemory(memoryStorage("not json")), "project-a")).toBe("agents");
  });

  it("keeps the in-session selection when storage is unavailable", () => {
    const storage = { setItem: () => { throw new Error("blocked"); } };
    const memory = rememberWorkspaceView({}, "project-a", "history", storage);
    expect(workspaceViewForProject(memory, "project-a")).toBe("history");
  });
});

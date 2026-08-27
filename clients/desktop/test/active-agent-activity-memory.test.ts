import { describe, expect, it } from "vitest";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import {
  readActiveAgentActivityMemory,
  updateActiveAgentActivityMemory,
  writeActiveAgentActivityMemory,
} from "../src/renderer/active-agent-activity-memory.js";

function storage(initial: string | null = null) {
  let value = initial;
  return {
    get value() { return value; },
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
}

function session(id: string): Session {
  return { id, kind: "Agent" } as Session;
}

function status(sessionId: string, observedAtEpochMs: number, planAt = 0): AgentStatus {
  return {
    sessionId,
    status: "idle",
    source: "appServer",
    observedAtEpochMs,
    ...(planAt > 0 ? { plan: { source: "codexAppServer", explanation: null, steps: [], updatedAtEpochMs: planAt } } : {}),
  } as AgentStatus;
}

describe("active Agent activity memory", () => {
  it("keeps the newest live or plan activity across an app restart", () => {
    const first = updateActiveAgentActivityMemory({}, "project-1", [session("a"), session("b")], [
      status("a", 200),
      status("b", 0, 300),
    ]);
    const restarted = updateActiveAgentActivityMemory(first, "project-1", [session("a"), session("b")], [
      status("a", 0),
      status("b", 0),
    ]);

    expect(restarted).toBe(first);
    expect(restarted["project-1"]).toEqual({ a: 200, b: 300 });
  });

  it("prunes Sessions absent from a non-empty Project projection", () => {
    const memory = { "project-1": { removed: 100, current: 200 } };
    expect(updateActiveAgentActivityMemory(memory, "project-1", [session("current")], [])).toEqual({
      "project-1": { current: 200 },
    });
  });

  it("reads only valid timestamps and tolerates unavailable storage", () => {
    const fake = storage('{"project-1":{"valid":123,"zero":0,"text":"10"}}');
    expect(readActiveAgentActivityMemory(fake)).toEqual({ "project-1": { valid: 123 } });
    expect(readActiveAgentActivityMemory({ getItem: () => { throw new Error("blocked"); } })).toEqual({});

    writeActiveAgentActivityMemory({ "project-1": { valid: 123 } }, fake);
    expect(JSON.parse(fake.value!)).toEqual({ "project-1": { valid: 123 } });
  });
});

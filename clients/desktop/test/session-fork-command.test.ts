import { describe, expect, it, vi } from "vitest";
import type { Session } from "../src/renderer/model.js";
import { selectedAgentForkCommand } from "../src/renderer/ui/session-fork-command.js";

const agent = {
  id: "selected-agent",
  kind: "Agent",
  name: "Selected Agent",
  forkable: true,
} as Session;

describe("selected Agent fork command", () => {
  it("forks exactly the selected logical Session without opening repair on success", async () => {
    const fork = vi.fn(async () => false);
    const repair = vi.fn();
    const command = selectedAgentForkCommand(agent, false, fork, repair);

    expect(command.disabled).toBe(false);
    await command.perform();

    expect(fork).toHaveBeenCalledExactlyOnceWith("selected-agent");
    expect(repair).not.toHaveBeenCalled();
  });

  it.each([
    ["no selection", undefined, false],
    ["terminal", { ...agent, kind: "Terminal" } as Session, false],
    ["unforkable Agent", { ...agent, forkable: false }, false],
    ["unavailable Project", agent, true],
  ] as const)("does not fork when there is an %s", async (_label, session, unavailable) => {
    const fork = vi.fn(async () => false);
    const repair = vi.fn();
    const command = selectedAgentForkCommand(session, unavailable, fork, repair);

    expect(command.disabled).toBe(true);
    await command.perform();

    expect(fork).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it("opens provider history repair for the source when the existing fork flow requests it", async () => {
    const fork = vi.fn(async () => true);
    const repair = vi.fn();

    await selectedAgentForkCommand(agent, false, fork, repair).perform();

    expect(repair).toHaveBeenCalledExactlyOnceWith("selected-agent");
  });
});

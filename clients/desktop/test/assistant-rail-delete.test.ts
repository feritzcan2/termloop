// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRail } from "../src/renderer/ui/AssistantRail.js";

describe("Steward reset", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("requires the destructive second click and returns to Build pipeline with agent", async () => {
    const deleteSteward = vi.fn(async (expectedRevision: number) => ({
      projectId: "project-1",
      deleted: true as const,
      deletedWorkers: 0,
      deletedRoutines: 0,
      deletedSessions: 1,
      deletedMessages: 2,
      playbookDeleted: true,
      stateRevision: expectedRevision + 1,
    }));
    await act(async () => root.render(createElement(AssistantRail, {
      projectId: "project-1",
      refreshToken: 0,
      sessions: [],
      statusesById: new Map(),
      tasks: [],
      playbookRuntime: null,
      disabled: false,
      selectedSessionId: undefined,
      selection: { kind: "steward" },
      agentCapabilities: [],
      getSteward: async () => ({
        configuration: {
          projectId: "project-1",
          agentId: "codex" as const,
          model: "default",
          permission: "bypassPermissions" as const,
          reasoning: "default" as const,
          enabled: false,
          executorSessionId: null,
          generation: 1,
          updatedAtEpochMs: 1,
          systemPrompt: "Coordinate this Project.",
        },
        defaultSystemPrompt: "Coordinate this Project.",
        promptContext: {
          initialPrompt: "Start.",
          instructionsPrompt: "Coordinate.",
          instructionDelivery: "codexDeveloperInstructions" as const,
          protectedPrompt: "Protected.",
          wakePrompt: "Wake.",
        },
        stateRevision: 7,
        supervisorAvailability: "available" as const,
        presence: {
          lastActivityAtEpochMs: null,
          activeCommandLabel: null,
          pendingProposal: false,
        },
      }),
      setSteward: async () => { throw new Error("unused"); },
      deleteSteward,
      listWorkers: async () => ({ configurations: [], promptContexts: [], stateRevision: 7 }),
      createWorker: async () => { throw new Error("unused"); },
      updateWorker: async () => { throw new Error("unused"); },
      deleteWorker: async () => { throw new Error("unused"); },
      listRoutines: async () => ({ configurations: [], stateRevision: 7 }),
      listRuntime: async () => ({ health: [], reports: [], reportsTruncated: false, stateRevision: 7 }),
      getPlaybook: async () => ({ playbook: null, stateRevision: 7 }),
      updatePlaybook: async () => { throw new Error("unused"); },
      setPlaybookTaskPosition: async () => { throw new Error("unused"); },
      runRoutineNow: async () => { throw new Error("unused"); },
      createRoutine: async () => { throw new Error("unused"); },
      updateRoutine: async () => { throw new Error("unused"); },
      deleteRoutine: async () => { throw new Error("unused"); },
      improvement: {
        start: async () => undefined,
        versions: async (target) => ({
          target,
          activeVersionId: null,
          versions: [],
          stateRevision: 7,
        }),
        restore: async () => "unused",
      },
      setupPromptImprovement: () => undefined,
      restartWorker: async () => null,
      restartSteward: async () => null,
      selectSession: () => undefined,
      openImproverTerminal: () => undefined,
      dismissImproverSession: () => undefined,
      openTask: () => undefined,
      openDetails: () => undefined,
    })));

    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Remove Project Steward"]');
    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    expect(deleteSteward).not.toHaveBeenCalled();
    expect(host.textContent).toContain("the Playbook, chat, and assistant sessions will be deleted");

    const confirm = host.querySelector<HTMLButtonElement>(
      '[aria-label="Yes, delete Project Steward and reset assistants"]',
    );
    await act(async () => confirm!.click());
    expect(deleteSteward).toHaveBeenCalledOnce();
    expect(deleteSteward).toHaveBeenCalledWith(7);
    expect(host.querySelector('[aria-label="Remove Project Steward"]')).toBeNull();
    expect(host.textContent).toContain("Build pipeline with agent");
  });
});

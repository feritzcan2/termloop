// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineConfigurationDto, RoutineHealthDto, WorkerConfigurationDto, WorkerConfigurationListResult } from "@termloop/contract/current";
import { AssistantRail } from "../src/renderer/ui/AssistantRail.js";

const worker: WorkerConfigurationDto = {
  id: "worker-1", projectId: "project-1", name: "Playbook Worker", agentId: "codex",
  model: "gpt-5.6-luna", permission: "default", reasoning: "medium", enabled: true,
  pingIntervalSeconds: 300, workerPrompt: "", systemPrompt: "", executorSessionId: null,
  generation: 1, updatedAtEpochMs: 1,
};

const routine: RoutineConfigurationDto = {
  id: "routine-review", projectId: "project-1", workerId: worker.id, kind: "ciPr",
  triggerMode: "onDemand", name: "Work ready for review", prompt: "Inspect the pull request.",
  stewardInstructions: "", enabled: true, scheduleIntervalSeconds: 60, generation: 1,
  contextMarkdown: "", contextRevision: 0, recentSourceKeys: [], relatedTaskIds: [],
  actionHandling: "off", pendingRoutineFindings: [], lastCheckStartedAtEpochMs: null,
  lastSuccessfulReportAtEpochMs: null, lastAttemptAtEpochMs: 1, updatedAtEpochMs: 1,
};

const attention: RoutineHealthDto = {
  routineId: routine.id, generation: 1, kind: routine.kind, triggerMode: routine.triggerMode,
  name: routine.name, contextMarkdown: "", contextRevision: 0, relatedTaskIds: [],
  state: "attention", checkId: null, deadlineEpochMs: null, pingSent: false,
  pendingTrigger: false, attentionMessage: "Azure DevOps authentication is unavailable.",
  lastSuccessfulReportAtEpochMs: null, lastAttemptAtEpochMs: 1, nextDueAtEpochMs: null,
};

function props(): ComponentProps<typeof AssistantRail> {
  return {
    projectId: "project-1", refreshToken: 0, sessions: [], statusesById: new Map(), tasks: [],
    playbookRuntime: null, disabled: false, selectedSessionId: undefined, selection: undefined,
    agentCapabilities: [],
    getSteward: async () => ({
      configuration: null, defaultSystemPrompt: "",
      promptContext: {
        initialPrompt: "", instructionsPrompt: "", instructionDelivery: "codexDeveloperInstructions",
        protectedPrompt: "", wakePrompt: "",
      },
      stateRevision: 1, supervisorAvailability: "available",
      presence: { lastActivityAtEpochMs: null, activeCommandLabel: null, pendingProposal: false },
    }),
    listWorkers: async () => ({ configurations: [worker], promptContexts: [], stateRevision: 1 }),
    listRoutines: async () => ({ configurations: [routine], stateRevision: 1 }),
    listRuntime: async () => ({ health: [attention], reports: [], reportsTruncated: false, stateRevision: 1 }),
    getPlaybook: async () => ({
      playbook: {
        projectId: "project-1", revision: 1, activePipelineName: "Delivery",
        milestones: [{
          id: "review", title: routine.name, gate: "automatic", routineId: routine.id,
          retryDelaySeconds: 300, condition: "A pull request is ready.", approver: null,
        }],
        savedPipelines: [], updatedAtEpochMs: 1,
      },
      stateRevision: 1,
    }),
    setSteward: vi.fn(), deleteSteward: vi.fn(), createWorker: vi.fn(), updateWorker: vi.fn(),
    deleteWorker: vi.fn(), updatePlaybook: vi.fn(), setPlaybookTaskPosition: vi.fn(),
    runRoutineNow: vi.fn(), createRoutine: vi.fn(), updateRoutine: vi.fn(), deleteRoutine: vi.fn(),
    improvement: undefined, setupPromptImprovement: vi.fn(), restartWorker: vi.fn(),
    restartSteward: vi.fn(), selectSession: vi.fn(), openImproverTerminal: vi.fn(),
    dismissImproverSession: vi.fn(), openTask: vi.fn(), openDetails: vi.fn(),
  } satisfies ComponentProps<typeof AssistantRail>;
}

describe("Assistant rail Playbook Routine status", () => {
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows an Attention badge on the affected Playbook step", async () => {
    await act(async () => {
      root.render(createElement(AssistantRail, props()));
      await Promise.resolve();
      await Promise.resolve();
    });

    const badge = host.querySelector<HTMLElement>(".ar-routine.playbook-step .ar-flag.attention");
    expect(badge?.textContent).toBe("Attention");
    expect(badge?.title).toContain("Azure DevOps authentication is unavailable.");
  });

  it("restores each Project immediately while its silent refresh is pending", async () => {
    let resolveProjectB: ((value: WorkerConfigurationListResult) => void) | undefined;
    const projectBWorkers = new Promise<WorkerConfigurationListResult>((resolve) => {
      resolveProjectB = resolve;
    });
    const projectBWorker = { ...worker, id: "worker-b", projectId: "project-b", name: "Project B Worker" };

    await act(async () => {
      root.render(createElement(AssistantRail, props()));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Playbook Worker");

    await act(async () => root.render(createElement(AssistantRail, {
      ...props(),
      projectId: "project-b",
      listWorkers: () => projectBWorkers,
    })));
    expect(host.textContent).not.toContain("Playbook Worker");

    await act(async () => {
      resolveProjectB?.({ configurations: [projectBWorker], promptContexts: [], stateRevision: 2 });
      await projectBWorkers;
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Project B Worker");

    await act(async () => root.render(createElement(AssistantRail, {
      ...props(),
      listWorkers: () => new Promise<WorkerConfigurationListResult>(() => undefined),
    })));
    expect(host.textContent).toContain("Playbook Worker");
    expect(host.textContent).not.toContain("Project B Worker");
  });
});

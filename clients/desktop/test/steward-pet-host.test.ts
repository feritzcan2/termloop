// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionMessageDto } from "@termloop/contract/current";
import { StewardPetHost } from "../src/renderer/ui/StewardPetHost.js";

function message(
  projectId: string,
  id: string,
  content: string,
  overrides: Partial<CompanionMessageDto> = {},
): CompanionMessageDto {
  return {
    id,
    projectId,
    sequence: 1,
    author: "steward",
    kind: "reply",
    content,
    createdAtEpochMs: 1,
    ...overrides,
  };
}

describe("StewardPetHost Project transcript baseline", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as typeof window.matchMedia;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps existing Steward chats closed when loading and switching Projects", async () => {
    const setEnabled = vi.fn(async () => undefined);
    const renderProject = async (projectId: string, baselineMessage: CompanionMessageDto) => {
      await act(async () => {
        root.render(createElement(StewardPetHost, {
          projectId,
          refreshToken: 0,
          sessions: [{ id: "session-1", lifecycle_state: "running" }] as never,
          agentStatuses: [],
          compact: true,
          setEnabled,
          userBusy: false,
          getSteward: async () => ({
            configuration: { enabled: true, executorSessionId: "session-1" },
            presence: {
              lastActivityAtEpochMs: null,
              activeCommandLabel: null,
              pendingProposal: false,
            },
          }) as never,
          listTranscript: async () => ({ messages: [baselineMessage] }) as never,
          respondToProposal: vi.fn(),
          acceptSuggestion: vi.fn(),
          listRuntime: async () => ({ reports: [] }) as never,
          openSteward: vi.fn(),
          dismissUtterance: vi.fn(),
          openReference: vi.fn(),
        }));
      });
    };

    await renderProject("project-a", message("project-a", "message-a", "Project A is ready."));

    expect(container.querySelector(".steward-pet")?.classList.contains("compact")).toBe(true);
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
    await act(async () => {
      (container.querySelector('[role="switch"]') as HTMLButtonElement).click();
    });
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(container.querySelector(".steward-pet-bubble")).toBeNull();

    await act(async () => {
      (container.querySelector(".steward-pet-body") as HTMLButtonElement).click();
    });
    expect(container.querySelector(".steward-pet-bubble")?.textContent).toContain("Project A is ready.");

    await renderProject("project-b", message("project-b", "message-b", "Project B is ready."));
    expect(container.querySelector(".steward-pet-bubble")).toBeNull();

    await act(async () => {
      (container.querySelector(".steward-pet-body") as HTMLButtonElement).click();
    });
    expect(container.querySelector(".steward-pet-bubble")?.textContent).toContain("Project B is ready.");
  });

  it("acts on a buried suggestion from the notification and replaces its controls with the receipt", async () => {
    const suggestion = message("project-a", "suggestion-1", "Prepare the verified handoff.", {
      sequence: 1,
      kind: "suggestion",
      refs: { taskId: "task-1" },
    });
    const update = message("project-a", "update-2", "The build is now green.", {
      sequence: 2,
      kind: "update",
      refs: { taskId: "task-1" },
    });
    const receipt = message("project-a", "receipt-3", "Accepted. Proceed with this suggestion.", {
      sequence: 3,
      author: "user",
      kind: "acceptance",
      refs: { taskId: "task-1" },
    });
    const acceptSuggestion = vi.fn(async () => ({ message: receipt, stateRevision: 4 } as never));
    const openSteward = vi.fn();

    await act(async () => {
      root.render(createElement(StewardPetHost, {
        projectId: "project-a",
        refreshToken: 0,
        sessions: [{ id: "session-1", lifecycle_state: "running" }] as never,
        agentStatuses: [],
        compact: true,
        userBusy: false,
        getSteward: async () => ({
          configuration: { enabled: true, executorSessionId: "session-1" },
          presence: { lastActivityAtEpochMs: null, activeCommandLabel: null, pendingProposal: false },
        }) as never,
        listTranscript: async () => ({ messages: [update, suggestion] }) as never,
        respondToProposal: vi.fn(),
        acceptSuggestion,
        listRuntime: async () => ({ reports: [] }) as never,
        openSteward,
        dismissUtterance: vi.fn(),
        openReference: vi.fn(),
      }));
    });

    expect(container.querySelector(".steward-pet-notification-mark")?.textContent).toBe("!");
    expect(container.querySelector(".steward-pet-bubble")).toBeNull();

    await act(async () => {
      (container.querySelector(".steward-pet-body") as HTMLButtonElement).click();
    });
    expect(container.querySelector(".steward-pet-bubble")?.textContent).toContain("The build is now green.");
    expect(container.querySelector(".steward-pet-open-question")?.textContent).toContain("Prepare the verified handoff.");
    expect(container.querySelector("textarea")).toBeNull();

    const accept = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Accept") as HTMLButtonElement;
    await act(async () => {
      accept.click();
    });

    expect(acceptSuggestion).toHaveBeenCalledWith("suggestion-1");
    expect(container.querySelector(".steward-pet-bubble")?.textContent).toContain("Accepted. Proceed with this suggestion.");
    expect(container.querySelector(".steward-pet-badge")?.textContent).toBe("Accepted");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Accept")).toBe(false);
    expect(container.querySelector(".steward-pet-notification-mark")).toBeNull();
  });

  it("routes proposal decisions directly and shows the declined receipt", async () => {
    const proposal = message("project-a", "proposal-1", "Approve the release?", {
      kind: "proposal",
      refs: { taskId: "task-1" },
    });
    const receipt = message("project-a", "receipt-2", "Not now.", {
      sequence: 2,
      author: "user",
      kind: "decline",
      refs: { taskId: "task-1" },
    });
    const respondToProposal = vi.fn(async () => ({ message: receipt, stateRevision: 3 } as never));

    await act(async () => {
      root.render(createElement(StewardPetHost, {
        projectId: "project-a",
        refreshToken: 0,
        sessions: [{ id: "session-1", lifecycle_state: "running" }] as never,
        agentStatuses: [],
        compact: true,
        userBusy: false,
        getSteward: async () => ({
          configuration: { enabled: true, executorSessionId: "session-1" },
          presence: { lastActivityAtEpochMs: null, activeCommandLabel: null, pendingProposal: true },
        }) as never,
        listTranscript: async () => ({ messages: [proposal] }) as never,
        respondToProposal,
        acceptSuggestion: vi.fn(),
        listRuntime: async () => ({ reports: [] }) as never,
        openSteward: vi.fn(),
        dismissUtterance: vi.fn(),
        openReference: vi.fn(),
      }));
    });
    await act(async () => {
      (container.querySelector(".steward-pet-body") as HTMLButtonElement).click();
    });

    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Approve")).toBe(true);
    const decline = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Not now") as HTMLButtonElement;
    await act(async () => {
      decline.click();
    });

    expect(respondToProposal).toHaveBeenCalledWith("proposal-1", "decline");
    expect(container.querySelector(".steward-pet-badge")?.textContent).toBe("Declined");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Approve")).toBe(false);
  });

  it("first run keeps the switch visible but disabled and routes the pet to Playbook setup", async () => {
    const setEnabled = vi.fn(async () => undefined);
    const openPlaybookSetup = vi.fn();
    const renderWithPlaybook = async (projectId: string, playbook: unknown) => {
      await act(async () => {
        root.render(createElement(StewardPetHost, {
          projectId,
          refreshToken: 0,
          sessions: [],
          agentStatuses: [],
          compact: true,
          setEnabled,
          userBusy: false,
          getSteward: async () => ({
            configuration: { enabled: false, executorSessionId: null },
            presence: { lastActivityAtEpochMs: null, activeCommandLabel: null, pendingProposal: false },
          }) as never,
          getPlaybook: async () => ({ playbook, stateRevision: 1 }) as never,
          openPlaybookSetup,
          listTranscript: async () => ({ messages: [] }) as never,
          respondToProposal: vi.fn(),
          acceptSuggestion: vi.fn(),
          listRuntime: async () => ({ reports: [] }) as never,
          openSteward: vi.fn(),
          dismissUtterance: vi.fn(),
          openReference: vi.fn(),
        }));
      });
    };

    await renderWithPlaybook("project-a", null);
    // No Playbook yet: the switch stays visible but cannot enable anything,
    // and clicking the pet routes to Playbook creation instead of the chat.
    const lockedSwitch = container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(lockedSwitch.disabled).toBe(true);
    await act(async () => { lockedSwitch.click(); });
    await act(async () => {
      (container.querySelector(".steward-pet-body") as HTMLButtonElement).click();
    });
    expect(openPlaybookSetup).toHaveBeenCalledTimes(1);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(container.querySelector(".steward-pet-bubble")).toBeNull();

    // Once the Playbook exists the ordinary enable switch returns.
    await renderWithPlaybook("project-b", { milestones: [{ id: "m1" }] });
    const liveSwitch = container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(liveSwitch.disabled).toBe(false);
    await act(async () => { liveSwitch.click(); });
    expect(setEnabled).toHaveBeenCalledWith(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AssistantTerminalHost,
  assistantTerminalKeepsSurfaceMounted,
  dismissChangesBeforeNavigation,
  openImproverSession,
  openWorkspaceSession,
  sessionRecoveryMessage,
  sessionShowsRecoveryStrip,
  shellAssistantStageVisible,
  shellNativeOverlayOpen,
  shellTerminalOccluded,
} from "../src/renderer/ui/Shell.js";
import { clampSidebarWidth } from "../src/renderer/sidebar-width.js";
import type { Session } from "../src/renderer/model.js";

describe("Shell navigation from the changes editor", () => {
  it("dismisses the editor before selecting an agent Session", () => {
    const events: string[] = [];
    const dismissChanges = vi.fn(() => events.push("dismiss"));
    const selectSession = vi.fn((sessionId: string) => events.push(`select:${sessionId}`));

    dismissChangesBeforeNavigation(dismissChanges, selectSession, "agent-session-1");

    expect(events).toEqual(["dismiss", "select:agent-session-1"]);
    expect(dismissChanges).toHaveBeenCalledOnce();
    expect(selectSession).toHaveBeenCalledWith("agent-session-1");
  });

  it("dismisses Steward details before opening an agent terminal", () => {
    const events: string[] = [];

    openWorkspaceSession(
      () => events.push("dismiss-changes"),
      () => events.push("dismiss-assistant"),
      (sessionId) => events.push(`select:${sessionId}`),
      "agent-session-1",
    );

    expect(events).toEqual([
      "dismiss-changes",
      "dismiss-assistant",
      "select:agent-session-1",
    ]);
  });

  it("keeps an assistant page open when Workspace selects its already-visible Agent", () => {
    const events: string[] = [];

    openWorkspaceSession(
      () => events.push("dismiss-changes"),
      () => events.push("dismiss-assistant"),
      (sessionId) => events.push(`select:${sessionId}`),
      "builder-session",
      true,
    );

    expect(events).toEqual([
      "dismiss-changes",
      "select:builder-session",
    ]);
  });

  it("dismisses step settings when its improver terminal is explicitly opened", () => {
    const events: string[] = [];

    openImproverSession(
      () => events.push("dismiss-changes"),
      () => events.push("dismiss-step-settings"),
      (sessionId) => events.push(`select:${sessionId}`),
      "routine-improver",
    );

    expect(events).toEqual([
      "dismiss-changes",
      "dismiss-step-settings",
      "select:routine-improver",
    ]);
  });

  it("shows assistant pages only in the Steward view so other views reveal the selected terminal", () => {
    const selection = { kind: "steward", initialView: "builder" } as const;
    expect(shellAssistantStageVisible("workspace", "steward", selection)).toBe(true);
    expect(shellAssistantStageVisible("workspace", "overview", selection)).toBe(false);
    expect(shellAssistantStageVisible("workspace", "agents", selection)).toBe(false);
    expect(shellAssistantStageVisible("skills", "steward", selection)).toBe(false);
    expect(shellAssistantStageVisible("workspace", "steward", undefined)).toBe(false);
  });
});

describe("Shell Session recovery", () => {
  const failedAgent = {
    id: "failed-agent",
    kind: "Agent",
    lifecycle_state: "resumeFailed",
    resume_failure_reason: "startupTimedOut",
  } as Session;

  it("shows the projected resume failure over the preserved Agent terminal", () => {
    expect(sessionShowsRecoveryStrip(failedAgent)).toBe(true);
    expect(sessionRecoveryMessage(failedAgent))
      .toBe("The provider did not become ready before the bounded timeout.");
  });

  it("does not cover a running Agent terminal with recovery UI", () => {
    expect(sessionShowsRecoveryStrip({
      ...failedAgent,
      lifecycle_state: "running",
      resume_failure_reason: null,
    })).toBe(false);
  });

  it("offers provider-history repair inside Steward and Worker terminal hosts", () => {
    const markup = renderToStaticMarkup(createElement(AssistantTerminalHost, {
      sessionId: failedAgent.id,
      session: {
        ...failedAgent,
        resume_failure_reason: "providerHistoryDamaged",
        retryable: false,
      },
      bindTerminalHost: () => undefined,
      resumeSession: async () => undefined,
      repairProviderHistory: () => undefined,
    }));

    expect(markup).toContain("data-session-recovery-state=\"resumeFailed\"");
    expect(markup).toContain("Repair history");
    expect(markup).toContain("provider conversation history is damaged");
    expect(assistantTerminalKeepsSurfaceMounted({
      ...failedAgent,
      resume_failure_reason: "providerHistoryDamaged",
    })).toBe(false);
  });

  it("offers Retry inside Steward and Worker terminal hosts for retryable failures", () => {
    const markup = renderToStaticMarkup(createElement(AssistantTerminalHost, {
      sessionId: failedAgent.id,
      session: { ...failedAgent, retryable: true },
      bindTerminalHost: () => undefined,
      resumeSession: async () => undefined,
      repairProviderHistory: () => undefined,
    }));

    expect(markup).toContain(">Retry</button>");
    expect(markup).not.toContain("Repair history");
  });

  it("remounts the persistent assistant terminal after recovery starts", () => {
    expect(assistantTerminalKeepsSurfaceMounted({
      ...failedAgent,
      lifecycle_state: "resuming",
      resume_failure_reason: null,
    })).toBe(true);
    expect(assistantTerminalKeepsSurfaceMounted({
      ...failedAgent,
      lifecycle_state: "running",
      resume_failure_reason: null,
    })).toBe(true);
  });
});

describe("Shell sidebar sizing", () => {
  it("re-clamps a previously wide sidebar when the window becomes narrow", () => {
    expect(clampSidebarWidth(480, 840)).toBe(480);
    expect(clampSidebarWidth(480, 472)).toBe(190);
  });

  it("occludes native terminals for the complete Session drag", () => {
    expect(shellTerminalOccluded(false, false)).toBe(false);
    expect(shellTerminalOccluded(false, true)).toBe(true);
    expect(shellTerminalOccluded(true, false)).toBe(true);
    expect(shellTerminalOccluded(false, false, true)).toBe(true);
  });

  it("makes the native child window interactive for Project relocation confirmation", () => {
    expect(shellNativeOverlayOpen({
      projectDialog: false,
      projectMenu: false,
      editProject: false,
      deleteProject: false,
      mobileConnect: false,
      renameSession: false,
      commandPalette: false,
      shortcutSettings: false,
      quickAction: false,
      runEditor: false,
      sessionMenu: false,
      taskRelocation: false,
      projectRelocation: true,
      providerHistoryRepair: false,
      taskRail: false,
      archivedRail: false,
    })).toBe(true);
  });

  it("makes the native overlay interactive for provider history repair", () => {
    expect(shellNativeOverlayOpen({
      projectDialog: false,
      projectMenu: false,
      editProject: false,
      deleteProject: false,
      mobileConnect: false,
      renameSession: false,
      commandPalette: false,
      shortcutSettings: false,
      quickAction: false,
      runEditor: false,
      sessionMenu: false,
      taskRelocation: false,
      projectRelocation: false,
      providerHistoryRepair: true,
      taskRail: false,
      archivedRail: false,
    })).toBe(true);
    expect(shellNativeOverlayOpen({
      projectDialog: false,
      projectMenu: false,
      editProject: false,
      deleteProject: false,
      mobileConnect: true,
      renameSession: false,
      commandPalette: false,
      shortcutSettings: false,
      quickAction: false,
      runEditor: false,
      sessionMenu: false,
      taskRelocation: false,
      projectRelocation: false,
      providerHistoryRepair: false,
      taskRail: false,
      archivedRail: false,
    })).toBe(true);
  });
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAccountSwitcher } from "../src/renderer/ui/AgentAccountSwitcher.js";
import type { AgentConnectionActions } from "../src/renderer/ui/AgentConnectionsPanel.js";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import { readAgentAccountSwitchPolicy, sessionsOnOtherAccounts, writeAgentAccountSwitchPolicy } from "../src/renderer/agent-account-switch-preference.js";

const work = "8f0c3c2e-1111-4222-8333-944455556666";
const accounts = (defaultId: string) => ({ revision: defaultId === "default" ? 3 : 4, accounts: [
  { agentId: "claude" as const, accountId: "default", name: "Personal", isDefault: defaultId === "default" },
  { agentId: "claude" as const, accountId: work, name: "Work", isDefault: defaultId === work },
  { agentId: "codex" as const, accountId: "default", name: "Default account", isDefault: true },
] });
function session(id: string, accountId: string, lifecycle: Session["lifecycle_state"] = "running"): Session {
  return { id, project_id: "p", name: null, kind: "Agent" as const, process: { program: "claude", args: [], cwd: "/", agent_id: "claude", template_ref: null, template_version: null }, lifecycle_state: lifecycle, runtime_epoch: 1, archived_at_epoch_ms: null, resume_failure_reason: null, retryable: false, closable: false, forkable: true, ask_to_source_session_id: null, run_configuration_id: null, agent_account_id: accountId };
}
const status = (sessionId: string, value: AgentStatus["status"]): AgentStatus => ({ sessionId, status: value, source: "hook", observedAtEpochMs: 1 });
function actions(): AgentConnectionActions {
  return {
    accounts: vi.fn(async () => accounts("default")), create: vi.fn(), rename: vi.fn(), remove: vi.fn(),
    setDefault: vi.fn(async () => accounts(work)),
    usage: vi.fn(async () => ({ accounts: [{ agentId: "claude" as const, accountId: work, state: "ok" as const, identity: { email: "me@work.com", organizationName: null, plan: "max" }, windows: [], fetchedAtEpochMs: 1, message: null }] })),
    list: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitCode: vi.fn(), openSignIn: vi.fn(),
  } as unknown as AgentConnectionActions;
}

describe("sidebar agent account switcher", () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith(label))!;

  it("switches the default and restarts idle Sessions now and busy ones after their turn", async () => {
    const api = actions();
    const switchSession = vi.fn(async () => undefined);
    const sessions = [session("idle", "default"), session("busy", "default"), session("done", "default", "exited"), session("already", work)];
    const props = { profileId: "local", actions: api, sessions, switchSession, openSettings: vi.fn() };
    await act(async () => root.render(createElement(AgentAccountSwitcher, { ...props, agentStatuses: [status("idle", "idle"), status("busy", "working")] })));
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-account-trigger")!.click());
    expect(container.textContent).toContain("Personal");
    await act(async () => button("Work").click());
    expect(api.setDefault).toHaveBeenCalledWith("local", { agentId: "claude", accountId: work, expectedRevision: 3 });
    expect(container.textContent).toContain("2 running Claude Session(s) still use another account");
    await act(async () => container.querySelector<HTMLInputElement>(".agent-account-prompt input")!.click());
    await act(async () => button("Restart Sessions").click());
    expect(switchSession).toHaveBeenCalledTimes(1);
    expect(switchSession).toHaveBeenCalledWith("idle", work);
    expect(readAgentAccountSwitchPolicy()).toBe("restart");
    await act(async () => root.render(createElement(AgentAccountSwitcher, { ...props, agentStatuses: [status("idle", "idle"), status("busy", "idle")] })));
    expect(switchSession).toHaveBeenCalledWith("busy", work);
  });

  it("keeps running Sessions when that is the remembered choice", async () => {
    writeAgentAccountSwitchPolicy("keep");
    const api = actions();
    const switchSession = vi.fn(async () => undefined);
    await act(async () => root.render(createElement(AgentAccountSwitcher, { profileId: "local", actions: api, sessions: [session("idle", "default")], agentStatuses: [], switchSession, openSettings: vi.fn() })));
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-account-trigger")!.click());
    await act(async () => button("Work").click());
    expect(container.querySelector(".agent-account-prompt")).toBeNull();
    expect(switchSession).not.toHaveBeenCalled();
  });

  it("selects only running Sessions of the provider on another account", () => {
    const other = { ...session("codex", "default"), process: { ...session("x", "default").process, agent_id: "codex" } };
    expect(sessionsOnOtherAccounts([session("a", "default"), session("b", work), session("c", "default", "exited"), other], "claude", work).map((item) => item.id)).toEqual(["a"]);
  });
});

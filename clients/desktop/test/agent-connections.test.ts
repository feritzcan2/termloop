// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAuthOperationDto, AgentAuthStatusDto } from "@termloop/contract/current";
import { AgentConnectionsPanel, type AgentConnectionActions } from "../src/renderer/ui/AgentConnectionsPanel.js";
import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";

const profile: ConnectionProfileSummary = { id: "netcup", name: "Netcup", transport: "ssh", scope: "full", endpoint: "server", enabled: true, persistence: "encrypted", state: "connected" };
const operation: AgentAuthOperationDto = { agentId: "codex", accountId: "default", operationId: "attempt", action: "signIn", phase: "awaitingBrowser", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234", acceptsCode: false, message: "Enter the code in your browser.", expiresAtEpochMs: Date.now() + 900_000 };
const status: AgentAuthStatusDto = { agentId: "codex", accountId: "default", label: "Codex", installed: true, version: "codex 1.0", authState: "signedOut", installSupported: true, busy: false, operation: null };
function actions(): AgentConnectionActions {
  const snapshot = { revision: 0, accounts: [{ agentId: "codex" as const, accountId: "default", name: "Default account", isDefault: true }, { agentId: "claude" as const, accountId: "default", name: "Default account", isDefault: true }] };
  return { accounts: vi.fn(async () => snapshot), create: vi.fn(async () => snapshot), rename: vi.fn(async () => snapshot), setDefault: vi.fn(async () => snapshot), list: vi.fn(async (_profile, params) => [{ ...status, agentId: params?.agentId ?? "codex", accountId: params?.accountId ?? "default", label: params?.agentId === "claude" ? "Claude" : "Codex" }]), start: vi.fn(async () => operation), get: vi.fn(async () => operation), cancel: vi.fn(async () => ({ ...operation, verificationUrl: null, userCode: null, phase: "cancelled" as const })), submitCode: vi.fn(async () => operation), openSignIn: vi.fn(async () => {}) };
}

describe("server agent account settings", () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    vi.useFakeTimers(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;

  it("routes sign-in and browser opening to the exact server and clears cancelled challenges", async () => {
    const api = actions();
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    expect(api.list).toHaveBeenCalledWith("netcup", { agentId: "codex", accountId: "default" });
    await act(async () => button("Sign in").click());
    expect(api.start).toHaveBeenCalledWith("netcup", "codex", "default", "signIn");
    expect(container.textContent).toContain("ABCD-1234");
    expect(api.openSignIn).not.toHaveBeenCalled();
    await act(async () => button("Open sign-in page").click());
    expect(api.openSignIn).toHaveBeenCalledWith("netcup", { agentId: "codex", accountId: "default", operationId: "attempt" });
    await act(async () => button("Cancel setup").click());
    expect(container.textContent).not.toContain("ABCD-1234");
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(api.get).not.toHaveBeenCalled();
  });

  it("refreshes installed state after completion without a daemon restart", async () => {
    const api = actions();
    vi.mocked(api.list).mockResolvedValueOnce([{ ...status, installed: false }]).mockResolvedValue([{ ...status, installed: true }]);
    vi.mocked(api.start).mockResolvedValue({ ...operation, action: "install", phase: "installing", verificationUrl: null, userCode: null });
    vi.mocked(api.get).mockResolvedValue({ ...operation, action: "install", phase: "succeeded", verificationUrl: null, userCode: null });
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    await act(async () => button("Install Codex").click());
    expect(api.start).toHaveBeenCalledWith("netcup", "codex", "default", "install");
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(api.list).toHaveBeenCalledTimes(3);
    expect(button("Sign in")).toBeDefined();
  });

  it("stops checking after a status timeout and retries just the failed account", async () => {
    const api = actions();
    vi.mocked(api.list).mockRejectedValueOnce(new Error("request timeout"));
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    expect(container.textContent).toContain("This server took too long to respond");
    expect(container.textContent).not.toContain("request timeout");
    expect(container.textContent).not.toContain("Checking this account");
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => button("Retry account check").click());
    expect(api.list).toHaveBeenCalledTimes(3);
    expect(api.list).toHaveBeenLastCalledWith("netcup", { agentId: "codex", accountId: "default" });
    expect(container.textContent).not.toContain("This server took too long to respond");
    expect(button("Retry account check")).toBeUndefined();
    expect(button("Sign in")).toBeDefined();
  });

  it.each([{ ...profile, state: "offline" as const }, { ...profile, transport: "local" as const, scope: "local" as const, state: "offline" as const }, { ...profile, scope: "readOnly" as const }])("does not read or expose account controls without a full connected server", async (unavailable) => {
    const api = actions();
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile: unavailable, actions: api })));
    expect(api.list).not.toHaveBeenCalled();
    expect(button("Sign in")).toBeUndefined();
    expect(button("Refresh").disabled).toBe(true);
  });

  it("resumes its own in-memory attempt after reopening and stops polling when offline", async () => {
    const api = actions(); vi.mocked(api.list).mockResolvedValue([{ ...status, busy: true, operation }]);
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    expect(container.textContent).toContain("ABCD-1234");
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile: { ...profile, state: "offline" }, actions: api })));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("ABCD-1234");
  });

  it("requires an explicit server-wide logout confirmation", async () => {
    const api = actions(); vi.mocked(api.list).mockResolvedValue([{ ...status, authState: "signedIn" }]);
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    await act(async () => button("Sign out").click());
    expect(api.start).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Other accounts stay connected");
    await act(async () => button("Sign out on server").click());
    expect(api.start).toHaveBeenCalledWith("netcup", "codex", "default", "signOut");
  });

  it("ignores a challenge response that arrives after the cancel intent", async () => {
    const api = actions();
    vi.mocked(api.list).mockResolvedValue([{ ...status, busy: true, operation }]);
    let deliver!: (value: AgentAuthOperationDto) => void;
    vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
    vi.mocked(api.cancel).mockResolvedValue({ ...operation, verificationUrl: null, userCode: null, message: "Cancelling…" });
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    await act(async () => button("Cancel setup").click());
    await act(async () => deliver(operation));
    expect(container.textContent).not.toContain("ABCD-1234");
    expect(container.textContent).toContain("Cancelling…");
  });

  it("cannot restore a cancelled challenge through a stale manual refresh", async () => {
    const api = actions();
    let deliver!: (value: AgentAuthStatusDto[]) => void;
    let reads = 0;
    vi.mocked(api.list).mockImplementation(async (_profile, params) => {
      if (params?.agentId === "claude") return [{ ...status, agentId: "claude", label: "Claude" }];
      if (++reads === 1) return [{ ...status, operation, busy: true }];
      return new Promise((resolve) => { deliver = resolve; });
    });
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    await act(async () => button("Refresh").click());
    await act(async () => button("Cancel setup").click());
    await act(async () => deliver([{ ...status, operation, busy: true }]));
    expect(container.textContent).not.toContain("ABCD-1234");
    expect(button("Open sign-in page")).toBeUndefined();
  });

  it("keeps setup disabled when a failed operation still owns an unfinished process", async () => {
    const api = actions(); vi.mocked(api.list).mockResolvedValue([{ ...status, busy: true, operation: { ...operation, phase: "failed", verificationUrl: null, userCode: null, message: "Restart this server before retrying setup." } }]);
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    expect(button("Sign in").disabled).toBe(true);
    expect(button("Update CLI").disabled).toBe(true);
    expect(container.textContent).toContain("Restart this server");
    expect(api.get).not.toHaveBeenCalled();
  });

  it("does not expose or replace another client's setup attempt", async () => {
    const api = actions(); vi.mocked(api.list).mockResolvedValue([{ ...status, busy: true, operation: null }]);
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    expect(button("Sign in").disabled).toBe(true);
    expect(button("Cancel setup")).toBeUndefined();
    expect(container.textContent).toContain("Another connection");
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe("named account management", () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  const typeName = async (name: string) => act(async () => {
    const input = container.querySelector<HTMLInputElement>('.agent-account-name-form input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("creates an isolated account, renames it, sets its server default and signs into that exact ID", async () => {
    const api = actions();
    const initial = await api.accounts("netcup");
    const id = "c3dcf1a0-2548-420c-b662-2a2143a567da";
    const created = { revision: 1, accounts: [...initial.accounts, { agentId: "codex" as const, accountId: id, name: "Work", isDefault: false }], createdAccountId: id };
    vi.mocked(api.create).mockResolvedValue(created);
    vi.mocked(api.rename).mockResolvedValue({ revision: 2, accounts: created.accounts.map((account) => account.accountId === id ? { ...account, name: "Personal" } : account) });
    vi.mocked(api.setDefault).mockResolvedValue({ revision: 3, accounts: created.accounts.map((account) => account.agentId === "codex" ? { ...account, isDefault: account.accountId === id } : account) });
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    await act(async () => button("Add account").click()); await typeName("Work");
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(api.create).toHaveBeenCalledWith("netcup", { agentId: "codex", name: "Work", expectedRevision: 0 });
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="codex account"]')!.value).toBe(id);
    expect(api.list).toHaveBeenCalledWith("netcup", { agentId: "codex", accountId: id });
    await act(async () => button("Rename").click()); await typeName("Personal");
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(api.rename).toHaveBeenCalledWith("netcup", { agentId: "codex", accountId: id, name: "Personal", expectedRevision: 1 });
    await act(async () => button("Use by default").click());
    expect(api.setDefault).toHaveBeenCalledWith("netcup", { agentId: "codex", accountId: id, expectedRevision: 2 });
    await act(async () => button("Sign in").click());
    expect(api.start).toHaveBeenCalledWith("netcup", "codex", id, "signIn");
  });

  it("discards a private challenge that arrives after switching accounts", async () => {
    const api = actions(); const initial = await api.accounts("netcup");
    const id = "c3dcf1a0-2548-420c-b662-2a2143a567da";
    vi.mocked(api.accounts).mockResolvedValue({ ...initial, accounts: [...initial.accounts, { agentId: "codex", accountId: id, name: "Work", isDefault: false }] });
    let deliver!: (value: AgentAuthOperationDto) => void;
    vi.mocked(api.start).mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    await act(async () => button("Sign in").click());
    await act(async () => { const select = container.querySelector<HTMLSelectElement>('select[aria-label="codex account"]')!; select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => deliver(operation));
    expect(container.textContent).not.toContain("ABCD-1234");
    expect(button("Open sign-in page")).toBeUndefined();
  });
});

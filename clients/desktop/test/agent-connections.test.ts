// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAuthOperationDto, AgentAuthStatusDto } from "@termloop/contract/current";
import { AgentConnectionsPanel, type AgentConnectionActions } from "../src/renderer/ui/AgentConnectionsPanel.js";
import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";

const profile: ConnectionProfileSummary = { id: "netcup", name: "Netcup", transport: "ssh", scope: "full", endpoint: "server", enabled: true, persistence: "encrypted", state: "connected" };
const operation: AgentAuthOperationDto = { agentId: "codex", operationId: "attempt", action: "signIn", phase: "awaitingBrowser", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234", acceptsCode: false, message: "Enter the code in your browser.", expiresAtEpochMs: Date.now() + 900_000 };
const status: AgentAuthStatusDto = { agentId: "codex", label: "Codex", installed: true, version: "codex 1.0", authState: "signedOut", installSupported: true, busy: false, operation: null };
function actions(): AgentConnectionActions {
  return { list: vi.fn(async () => [status]), start: vi.fn(async () => operation), get: vi.fn(async () => operation), cancel: vi.fn(async () => ({ ...operation, verificationUrl: null, userCode: null, phase: "cancelled" as const })), submitCode: vi.fn(async () => operation), openSignIn: vi.fn(async () => {}) };
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
    expect(api.list).toHaveBeenCalledWith("netcup");
    await act(async () => button("Sign in").click());
    expect(api.start).toHaveBeenCalledWith("netcup", "codex", "signIn");
    expect(container.textContent).toContain("ABCD-1234");
    expect(api.openSignIn).not.toHaveBeenCalled();
    await act(async () => button("Open sign-in page").click());
    expect(api.openSignIn).toHaveBeenCalledWith("netcup", { agentId: "codex", operationId: "attempt" });
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
    expect(api.start).toHaveBeenCalledWith("netcup", "codex", "install");
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(api.list).toHaveBeenCalledTimes(2);
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
    expect(container.textContent).toContain("every client");
    await act(async () => button("Sign out on server").click());
    expect(api.start).toHaveBeenCalledWith("netcup", "codex", "signOut");
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

  it("does not expose or replace another client's setup attempt", async () => {
    const api = actions(); vi.mocked(api.list).mockResolvedValue([{ ...status, busy: true, operation: null }]);
    await act(async () => root.render(createElement(AgentConnectionsPanel, { profile, actions: api })));
    expect(button("Sign in").disabled).toBe(true);
    expect(button("Cancel setup")).toBeUndefined();
    expect(container.textContent).toContain("Another connection");
    expect(api.get).not.toHaveBeenCalled();
  });
});

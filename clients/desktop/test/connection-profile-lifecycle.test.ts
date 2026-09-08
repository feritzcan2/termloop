import { describe, expect, it, vi } from "vitest";

import type { ConnectionProfileConnectInput, ConnectionProfileSummary } from "../src/connection-profile-types.js";
import { ConnectionProfileLifecycle } from "../src/main/connection-profile-lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const profile = (id: string): ConnectionProfileSummary => ({
    id, name: id, transport: "tailscale", scope: "full", endpoint: id,
    enabled: true, persistence: "sessionOnly",
  });
  const stored = new Map(["a", "b"].map((id) => [id, profile(id)]));
  const snapshot = () => [...stored.values()].map((value) => ({ ...value }));
  const profiles = {
    connect: vi.fn(async (input: ConnectionProfileConnectInput) => {
      const connected = { ...profile("new"), name: input.name };
      stored.set(connected.id, connected);
      return { profile: connected, warning: "Available for this app session only." };
    }),
    setEnabled: vi.fn(async (id: string, enabled: boolean) => {
      const current = stored.get(id);
      if (!current) throw new Error("missing profile");
      stored.set(id, { ...current, enabled });
    }),
    remove: vi.fn(async (id: string) => {
      if (!stored.delete(id)) throw new Error("missing profile");
    }),
  };
  const resourceOwner = () => {
    const live = new Set(["a", "b"]);
    return { live, stopProfile: vi.fn((id: string) => { live.delete(id); }) };
  };
  const connections = { ...resourceOwner(), summaries: vi.fn(async () => snapshot()) };
  const gateways = resourceOwner();
  const forwards = resourceOwner();
  const lifecycle = new ConnectionProfileLifecycle(profiles, connections, gateways, forwards);
  return { lifecycle, profiles, connections, gateways, forwards, stored, snapshot };
}

describe("ConnectionProfileLifecycle", () => {
  it("finishes a disable and its refresh before a queued enable can change the profile", async () => {
    const f = fixture();
    const refreshing = deferred();
    const releaseRefresh = deferred();
    f.connections.summaries.mockImplementationOnce(async () => {
      refreshing.resolve();
      await releaseRefresh.promise;
      return f.snapshot();
    });

    const disabled = f.lifecycle.setEnabled("a", false);
    await refreshing.promise;
    const enabled = f.lifecycle.setEnabled("a", true);
    await Promise.resolve();

    expect(f.profiles.setEnabled.mock.calls).toEqual([["a", false]]);
    for (const owner of [f.connections, f.gateways, f.forwards]) {
      expect(owner.live.has("a")).toBe(false);
      expect(owner.live.has("b")).toBe(true);
    }
    releaseRefresh.resolve();
    expect(await disabled).toContainEqual(expect.objectContaining({ id: "a", enabled: false }));
    expect(await enabled).toContainEqual(expect.objectContaining({ id: "a", enabled: true }));
    expect(f.profiles.setEnabled.mock.calls).toEqual([["a", false], ["a", true]]);
    for (const owner of [f.connections, f.gateways, f.forwards]) {
      expect(owner.stopProfile.mock.calls).toEqual([["a"]]);
    }
  });

  it("keeps a queued remove behind connection enrollment and registry activation", async () => {
    const f = fixture();
    const refreshing = deferred();
    const releaseRefresh = deferred();
    f.connections.summaries.mockImplementationOnce(async () => {
      refreshing.resolve();
      await releaseRefresh.promise;
      return f.snapshot();
    });
    const connected = f.lifecycle.connect({
      name: "New server", transport: { kind: "tailscale", baseUrl: "wss://new" },
    });
    await refreshing.promise;
    const removed = f.lifecycle.remove("new");
    await Promise.resolve();
    expect(f.profiles.remove).not.toHaveBeenCalled();

    releaseRefresh.resolve();
    await expect(connected).resolves.toMatchObject({
      profile: { id: "new", name: "New server", persistence: "sessionOnly" },
      warning: "Available for this app session only.",
    });
    expect((await removed).map((value) => value.id)).toEqual(["a", "b"]);
    for (const owner of [f.connections, f.gateways, f.forwards]) {
      expect(owner.stopProfile.mock.calls).toEqual([["new"]]);
    }
  });

  it("leaves resources live on a failed write and continues with the next mutation", async () => {
    const f = fixture();
    const failure = new Error("profile write failed");
    f.profiles.setEnabled.mockRejectedValueOnce(failure);
    const failed = expect(f.lifecycle.setEnabled("a", false)).rejects.toBe(failure);
    const removed = f.lifecycle.remove("b");
    await failed;
    await removed;

    expect(f.stored.get("a")?.enabled).toBe(true);
    expect(f.connections.summaries).toHaveBeenCalledOnce();
    for (const owner of [f.connections, f.gateways, f.forwards]) {
      expect(owner.live.has("a")).toBe(true);
      expect(owner.live.has("b")).toBe(false);
      expect(owner.stopProfile.mock.calls).toEqual([["b"]]);
    }
  });

  it("attempts every resource cleanup after commit even when one cleanup fails", async () => {
    const f = fixture();
    const failure = new Error("gateway stop failed");
    f.gateways.stopProfile.mockImplementationOnce(() => { throw failure; });
    await expect(f.lifecycle.remove("a")).rejects.toMatchObject({
      message: "Connection profile was saved, but its connections could not be fully refreshed.",
      errors: [failure],
    });
    expect(f.stored.has("a")).toBe(false);
    expect(f.connections.summaries).toHaveBeenCalledOnce();
    expect(f.connections.live.has("a")).toBe(false);
    expect(f.forwards.live.has("a")).toBe(false);
    for (const owner of [f.connections, f.gateways, f.forwards]) {
      expect(owner.stopProfile.mock.calls).toEqual([["a"]]);
      expect(owner.live.has("b")).toBe(true);
    }
    await expect(f.lifecycle.setEnabled("b", false)).resolves.toEqual([
      expect.objectContaining({ id: "b", enabled: false }),
    ]);
  });

  it("does not skip committed cleanup when the registry refresh fails", async () => {
    const f = fixture();
    const failure = new Error("registry refresh failed");
    f.connections.summaries.mockRejectedValueOnce(failure);
    await expect(f.lifecycle.setEnabled("a", false)).rejects.toMatchObject({ errors: [failure] });
    expect(f.stored.get("a")?.enabled).toBe(false);
    for (const owner of [f.connections, f.gateways, f.forwards]) {
      expect(owner.live.has("a")).toBe(false);
      expect(owner.live.has("b")).toBe(true);
    }
    await expect(f.lifecycle.setEnabled("a", true)).resolves.toContainEqual(
      expect.objectContaining({ id: "a", enabled: true }),
    );
    expect(f.forwards.stopProfile).toHaveBeenCalledOnce();
  });
});

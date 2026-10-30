import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "." },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../src/main/access-websocket.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/main/access-websocket.js")>(),
  remoteConnectionFailureMessage: vi.fn(() => undefined),
}));

import { remoteConnectionFailureMessage } from "../src/main/access-websocket.js";
import type { DesktopConnectionConfig } from "../src/main/connection-profiles.js";
import { ConnectionRegistry } from "../src/main/connection-registry.js";

const PROFILE_A = "123e4567-e89b-42d3-a456-426614174000";
const PROFILE_B = "123e4567-e89b-42d3-a456-426614174001";

describe("ConnectionRegistry routing", () => {
  it("sends a destructive command only to the explicitly named source", async () => {
    const calls: Array<{ profileId: string; method: string; args: unknown[] }> = [];
    const summaries = [
      { id: "local", name: "This computer", transport: "local", scope: "local", endpoint: "local", enabled: true, persistence: "local" },
      { id: PROFILE_A, name: "Server A", transport: "tailscale", scope: "full", endpoint: "a", enabled: true, persistence: "encrypted" },
      { id: PROFILE_B, name: "Server B", transport: "tailscale", scope: "full", endpoint: "b", enabled: true, persistence: "encrypted" },
    ] as const;
    const profiles = {
      list: async () => summaries,
      remoteConfig: async (profileId: string): Promise<DesktopConnectionConfig> => ({
        kind: "remote",
        profileId,
        controlUrl: `ws://${profileId}/control`,
        terminalUrl: `ws://${profileId}/terminal`,
        token: "0".repeat(64),
        terminalToken: "0".repeat(64),
        credential: {
          deviceId: "a".repeat(32),
          privateKey: {},
          serverFingerprint: `sha256:${"b".repeat(64)}`,
        },
      }),
    };
    const registry = new ConnectionRegistry(
      { invalidated: vi.fn(), statusChanged: vi.fn() },
      profiles as never,
      (config) => ({
        call: async (method: string, ...args: unknown[]) => {
          calls.push({ profileId: config.kind === "remote" ? config.profileId : "local", method, args });
          return { deleted: true } as never;
        },
        close: vi.fn(),
      }) as never,
    );

    await registry.call(PROFILE_B, "project.delete", { projectId: "same-project-id" });

    expect(calls).toEqual([{
      profileId: PROFILE_B,
      method: "project.delete",
      args: [{ projectId: "same-project-id" }],
    }]);
  });

  it("does not flap a subscription-connected source offline after one failed call", async () => {
    const statusChanged = vi.fn();
    const call = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("temporary request failure"));
    const profiles = {
      list: async () => [{
        id: PROFILE_A,
        name: "Server A",
        transport: "tailscale",
        scope: "full",
        endpoint: "a",
        enabled: true,
        persistence: "encrypted",
      }],
      remoteConfig: async (profileId: string): Promise<DesktopConnectionConfig> => ({
        kind: "remote",
        profileId,
        controlUrl: `ws://${profileId}/control`,
        terminalUrl: `ws://${profileId}/terminal`,
        token: "0".repeat(64),
        terminalToken: "0".repeat(64),
        credential: {
          deviceId: "a".repeat(32),
          privateKey: {},
          serverFingerprint: `sha256:${"b".repeat(64)}`,
        },
      }),
    };
    const registry = new ConnectionRegistry(
      { invalidated: vi.fn(), statusChanged },
      profiles as never,
      () => ({ call, close: vi.fn() }) as never,
    );

    await registry.call(PROFILE_A, "project.list");
    statusChanged.mockClear();

    await expect(registry.call(PROFILE_A, "project.list"))
      .rejects.toThrow("temporary request failure");
    expect(statusChanged).not.toHaveBeenCalled();
    await expect(registry.summaries()).resolves.toEqual([
      expect.objectContaining({ id: PROFILE_A, state: "connected" }),
    ]);
  });

  it("reports why a remote handshake was refused instead of a bare transport failure", async () => {
    const mismatch = "Version mismatch: server termloop.v2, desktop termloop.v3";
    vi.mocked(remoteConnectionFailureMessage).mockReturnValueOnce(mismatch);
    const statusChanged = vi.fn();
    const profiles = {
      list: async () => [{
        id: PROFILE_A,
        name: "Server A",
        transport: "ssh",
        scope: "full",
        endpoint: "a",
        enabled: true,
        persistence: "encrypted",
      }],
      remoteConfig: async (profileId: string): Promise<DesktopConnectionConfig> => ({
        kind: "remote",
        profileId,
        controlUrl: `ws://${profileId}/control`,
        terminalUrl: `ws://${profileId}/terminal`,
        token: "0".repeat(64),
        terminalToken: "0".repeat(64),
        credential: {
          deviceId: "a".repeat(32),
          privateKey: {},
          serverFingerprint: `sha256:${"b".repeat(64)}`,
        },
      }),
    };
    const registry = new ConnectionRegistry(
      { invalidated: vi.fn(), statusChanged },
      profiles as never,
      () => ({ call: vi.fn().mockRejectedValue(new Error("connection failed")), close: vi.fn() }) as never,
    );

    await expect(registry.call(PROFILE_A, "project.list")).rejects.toThrow(mismatch);
    expect(remoteConnectionFailureMessage).toHaveBeenCalledWith(PROFILE_A);
    expect(statusChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: PROFILE_A, state: "offline", message: mismatch }),
    );
  });
});

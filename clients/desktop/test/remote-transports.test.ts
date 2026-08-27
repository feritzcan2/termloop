import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { accessEndpoint, tailscaleAccessBaseUrl } from "../src/main/transports/tailscale.js";
import { isSshLocalForwardBindFailure, sshTunnelArgs } from "../src/platform/ssh-runtime.js";
import { readConnectionProfileFile, writeConnectionProfileFile } from "../src/platform/connection-profile-storage.js";
import { secureCredentialStorageAvailable } from "../src/platform/secure-storage.js";

describe("remote desktop transports", () => {
  it("accepts secure Tailscale origins without URL credentials", () => {
    expect(tailscaleAccessBaseUrl("wss://server.tailnet.ts.net/"))
      .toBe("wss://server.tailnet.ts.net");
    expect(accessEndpoint("wss://server.tailnet.ts.net", "control"))
      .toBe("wss://server.tailnet.ts.net/control");
    expect(() => tailscaleAccessBaseUrl("ws://server.tailnet.ts.net"))
      .toThrow(/require wss/);
    expect(() => tailscaleAccessBaseUrl("wss://user:secret@server.tailnet.ts.net"))
      .toThrow(/credentials/);
    expect(() => tailscaleAccessBaseUrl("wss://server.tailnet.ts.net/control?token=secret"))
      .toThrow(/credentials, query parameters, or fragments/);
    expect(() => tailscaleAccessBaseUrl(`wss://${"a".repeat(2_048)}.example`))
      .toThrow(/valid wss/);
  });

  it("permits plaintext WebSockets only through loopback transport adapters", () => {
    expect(tailscaleAccessBaseUrl("ws://127.0.0.1:43717"))
      .toBe("ws://127.0.0.1:43717");
    expect(tailscaleAccessBaseUrl("ws://localhost:43717"))
      .toBe("ws://localhost:43717");
  });

  it("builds a noninteractive strict SSH forward", () => {
    const args = sshTunnelArgs({ host: "server.example", user: "alice", remotePort: 43717 }, 50123);
    expect(args).toEqual([
      "-N", "-T",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-L", "127.0.0.1:50123:127.0.0.1:43717",
      "alice@server.example",
    ]);
    expect(args).not.toContain("StrictHostKeyChecking=accept-new");
    expect(args).not.toContain("StrictHostKeyChecking=no");
    expect(() => sshTunnelArgs({ host: "-oProxyCommand=bad", remotePort: 43717 }, 50123))
      .toThrow(/unsupported characters/);
    expect(() => sshTunnelArgs({ host: "server.example", user: "bad user", remotePort: 43717 }, 50123))
      .toThrow(/unsupported characters/);
    expect(() => sshTunnelArgs({ host: "server.example", user: "-oProxyCommand", remotePort: 43717 }, 50123))
      .toThrow(/unsupported characters/);
    expect(() => sshTunnelArgs({ host: "a".repeat(256), remotePort: 43717 }, 50123))
      .toThrow(/unsupported characters/);
  });

  it("recognizes only retryable local SSH forward bind races", () => {
    expect(isSshLocalForwardBindFailure("bind [127.0.0.1]:50123: Address already in use"))
      .toBe(true);
    expect(isSshLocalForwardBindFailure("channel_setup_fwd_listener_tcpip: cannot listen to port: 50123"))
      .toBe(true);
    expect(isSshLocalForwardBindFailure("Host key verification failed."))
      .toBe(false);
  });

  it("rejects Linux basic-text credential storage without probing that backend on other hosts", () => {
    const storage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: vi.fn(() => "basic_text"),
    };
    expect(secureCredentialStorageAvailable(storage, "linux")).toBe(false);
    expect(storage.getSelectedStorageBackend).toHaveBeenCalledOnce();
    storage.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
    expect(secureCredentialStorageAvailable(storage, "linux")).toBe(true);
    storage.getSelectedStorageBackend.mockClear();
    expect(secureCredentialStorageAvailable(storage, "darwin")).toBe(true);
    expect(storage.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it("atomically replaces the private connection profile file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-profile-store-"));
    const file = path.join(directory, "nested", "profiles.json");
    try {
      expect(await readConnectionProfileFile(file)).toBeUndefined();
      await writeConnectionProfileFile(file, '{"version":1}');
      await writeConnectionProfileFile(file, '{"version":2}');
      expect(await readConnectionProfileFile(file)).toBe('{"version":2}');
      expect(await readFile(file, "utf8")).toBe('{"version":2}');
      await expect(writeConnectionProfileFile(file, "x".repeat(1024 * 1024 + 1)))
        .rejects.toThrow(/durable size limit/);
      expect(await readFile(file, "utf8")).toBe('{"version":2}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

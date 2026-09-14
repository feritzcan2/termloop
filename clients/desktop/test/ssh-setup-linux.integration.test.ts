import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SshSetupManager } from "../src/platform/ssh-setup.js";
import { authenticateSetup, createManagedIdentity, discoverHostIdentity, remoteCommand } from "../src/platform/ssh-setup-connection.js";
import { remoteCliCommand, serverUserCommand } from "../src/platform/ssh-setup-scripts.js";

// Opt-in: a disposable Debian 13 x64/systemd host, exposed only on loopback.
// Supply a matching server package and its protocol to exercise installation
// without publishing a release. Never point this fixture at a production host.
describe("fresh Linux SSH setup", () => {
  it.runIf(!!process.env.TERMLOOP_TEST_SSH_PORT)("installs and restarts the real stable server with key access and automatic updates", async () => {
    const port = Number(process.env.TERMLOOP_TEST_SSH_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Expected a loopback fixture SSH port");
    const protocol = process.env.TERMLOOP_TEST_SERVER_PROTOCOL;
    const archive = process.env.TERMLOOP_TEST_SERVER_PACKAGE;
    if (!protocol || !/^sha256:[a-f0-9]{64}$/.test(protocol) || !archive) throw new Error("Supply a server package and its expected protocol for this fixture");
    const root = await mkdtemp(path.join(os.tmpdir(), "termloop linux ssh fixture "));
    const manager = new SshSetupManager(root, path.resolve("../../tools/server"), "2.0.4", protocol);
    try {
      const first = await manager.start(1, { address: "127.0.0.1", user: "root", sshPort: port, name: "Disposable Debian" });
      const review = await manager.login(1, { id: first.id, fingerprint: first.fingerprint, password: "termloop-fixture-only" });
      expect(review.phase, review.message).toBe("review");
      await manager.selectArchive(1, first.id, archive);
      manager.install(1, first.id);
      let result = manager.status(1, first.id);
      while (result.phase === "installing") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = manager.status(1, first.id);
      }
      expect(result.phase, result.message).toBe("ready");
      expect(manager.connectionInput(1, first.id).transport).toMatchObject({ user: "termloop-admin", sshPort: port, remotePort: 43717 });
      const target = { host: "127.0.0.1", port, name: "Fixture", user: "termloop-admin", identityFiles: [] };
      const signal = new AbortController().signal;
      const identity = await discoverHostIdentity(target, signal);
      expect(identity.fingerprint).toBe(first.fingerprint);
      const managed = await createManagedIdentity(root, first.id, target, identity);
      const client = await authenticateSetup(target, identity, {}, signal, managed);
      try {
        const status = JSON.parse(await remoteCommand(client, serverUserCommand("termloop-admin", "user", 'node "$HOME/.local/share/termloop-server/current/termloop-server-manager.mjs" status')));
        expect(status).toMatchObject({ installed: true, running: true, autoUpdate: true, version: "2.0.4" });
        const version = JSON.parse(await remoteCommand(client, remoteCliCommand("termloop-admin", "user", "version")));
        expect(version.protocolVersion).toBe(protocol);
        await remoteCommand(client, serverUserCommand("termloop-admin", "user", "systemctl --user restart termloop-next.service"));
        let recovered = false;
        for (let i = 0; i < 30; i++) {
          try { await remoteCommand(client, remoteCliCommand("termloop-admin", "user", "ping")); recovered = true; break; }
          catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
        }
        expect(recovered).toBe(true);
        const incompatible = process.env.TERMLOOP_TEST_INCOMPATIBLE_PACKAGE;
        if (incompatible) {
          const processId = () => remoteCommand(client, serverUserCommand("termloop-admin", "user", "systemctl --user show termloop-next.service --property=MainPID --value"));
          const before = await processId();
          const another = await manager.start(1, { address: "127.0.0.1", user: "root", sshPort: port });
          expect((await manager.login(1, { id: another.id, fingerprint: another.fingerprint, password: "termloop-fixture-only" })).phase).toBe("review");
          await manager.selectArchive(1, another.id, incompatible);
          manager.install(1, another.id);
          while (manager.status(1, another.id).phase === "installing") await new Promise((resolve) => setTimeout(resolve, 1000));
          expect(manager.status(1, another.id).message).toContain("not compatible");
          expect(await processId()).toBe(before);
          await remoteCommand(client, remoteCliCommand("termloop-admin", "user", "ping"));
        }
      } finally { client.end(); }
    } finally { manager.cancelOwner(1); await rm(root, { recursive: true, force: true }); }
  }, 20 * 60_000);
});

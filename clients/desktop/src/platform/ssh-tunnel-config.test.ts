import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sshCommandArgs, sshTunnelArgs } from "./ssh-runtime.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("OpenSSH tunnel configuration", () => {
  it.each(["yes", "no"])("owns tunnel readiness with configured ClearAllForwardings=%s", async (clear) => {
    const root = await mkdtemp(path.join(tmpdir(), "termloop-forward-config-"));
    roots.push(root);
    const file = path.join(root, "config");
    await writeFile(file, `Host fixture\n  HostName 127.0.0.1\n  User fixture-user\n  Port 2222\n  IdentityFile "/keys with spaces/device"\n  IdentitiesOnly yes\n  ProxyJump bastion\n  ClearAllForwardings ${clear}\n  ExitOnForwardFailure yes\n  LocalForward 127.0.0.1:50234 127.0.0.1:43717\n`);
    const args = sshTunnelArgs({ host: "fixture", remotePort: 43717 }, 50123);
    const result = (await execute("ssh", ["-G", "-F", file, ...args])).stdout;
    expect(args).not.toContain("-F");
    for (const line of [
      "hostname 127.0.0.1", "user fixture-user", "port 2222", "identityfile /keys with spaces/device",
      "identitiesonly yes", "proxyjump bastion", "clearallforwardings no", "exitonforwardfailure no",
      "stricthostkeychecking true", "loglevel ERROR", "permitlocalcommand yes",
      "localcommand echo TERMLOOP_SSH_FORWARD_READY 1>&2",
      "localforward [127.0.0.1]:50123 [127.0.0.1]:43717",
    ]) expect(result).toContain(line);
  });

  it("still disables every forward for remote commands without replacing LocalCommand", async () => {
    const args = sshCommandArgs({ host: "fixture", remotePort: 43717 }, "fixed-command");
    const result = (await execute("ssh", ["-G", "-F", devNull, ...args])).stdout;
    expect(result).toContain("clearallforwardings yes");
    expect(result).not.toMatch(/^localforward /m);
    expect(args.join(" ")).not.toContain("TERMLOOP_SSH_FORWARD_READY");
    expect(args).not.toContain("PermitLocalCommand=yes");
  });
});

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { reconcileGatewayInstall } from "../scripts/mobile-access-installer.mjs";
import { runWindowsPowerShell } from "../scripts/mobile-access-windows.mjs";

const execFile = promisify(execFileCallback);

describe.skipIf(process.platform !== "win32")("Windows Mobile Access service", () => {
  it("enrolls from packaged assets, preserves pairing, repairs a stopped task and rolls back failed updates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop mobile Ö '$-"));
    const dnsName = `fixture-${randomBytes(8).toString("hex")}.example.ts.net`;
    const connectionId = `mac-${createHash("sha256").update(dnsName).digest("hex").slice(0, 16)}`;
    const label = `ai.termloop.mobile-access.${connectionId.slice(4)}`;
    const localData = path.join(directory, "Local App Data");
    const state = path.join(localData, "termloop-next", "mobile-access", connectionId);
    const runtimeFile = path.join(localData, "termloop-next", "runtime.json");
    const artifactDirectory = path.join(directory, "packaged assets");
    const port = await freePort();
    const v1 = artifact(1);
    const nodeExecutable = process.env.TERMLOOP_TEST_MOBILE_NODE_BINARY ?? process.execPath;
    try {
      await mkdir(path.dirname(runtimeFile), { recursive: true });
      await writeFile(runtimeFile, JSON.stringify({
        protocolVersion: `sha256:${"a".repeat(64)}`,
        controlUrl: "ws://127.0.0.1:48100/control", terminalUrl: "ws://127.0.0.1:48100/terminal",
        token: "never-ship-full-control", readOnlyToken: "r".repeat(64), terminalToken: "t".repeat(64),
      }));
      // Node plays the external Tailscale CLI, without touching the host tailnet.
      await writeFile(path.join(directory, "status"), `console.log(JSON.stringify(${JSON.stringify({ BackendState: "Running", Self: { Online: true, DNSName: `${dnsName}.`, HostName: "Fixture Windows" } })}));`);
      await writeFile(path.join(directory, "serve"), "require('node:fs').writeFileSync('serve-call.json', JSON.stringify(process.argv.slice(2)))");
      await mkdir(path.join(artifactDirectory, "transcriber"), { recursive: true });
      await writeFile(path.join(artifactDirectory, "gateway-artifact.json"), JSON.stringify(v1.artifact));
      await writeFile(path.join(artifactDirectory, "mobile-access-gateway.mjs"), v1.bundle);
      await writeFile(path.join(artifactDirectory, "transcriber", "Transcriber.swift"), v1.transcriber);
      const command = [path.resolve("scripts/mobile-access.mjs"), "--artifact-dir", artifactDirectory,
        "--tailscale-bin", process.execPath, "--node-executable", nodeExecutable,
        "--electron-run-as-node", "--gateway-port", String(port), "--print"];
      const env = { ...process.env, LOCALAPPDATA: localData };
      delete env.TERMLOOP_RUNTIME_FILE;
      const enroll = () => execFile(process.execPath, command, { cwd: directory, env, windowsHide: true, timeout: 90_000 });
      const { stdout } = await enroll();
      const code = stdout.split(/\r?\n/).find((line) => line.startsWith("TLMP1:"));
      const pairing = JSON.parse(code.slice(6));
      expect(pairing).toMatchObject({ name: "Fixture Windows", connectionId, controlUrl: `wss://${dnsName}/control` });
      expect(code).not.toContain("never-ship-full-control");
      expect(pairing.controlToken).not.toBe("r".repeat(64));
      expect(pairing.terminalToken).not.toBe("t".repeat(64));
      expect(JSON.parse(await readFile(path.join(directory, "serve-call.json"), "utf8")))
        .toEqual(["--bg", "--yes", `127.0.0.1:${port}`]);
      const config = JSON.parse(await readFile(path.join(state, "gateway.json"), "utf8"));
      expect(config).toMatchObject({ hostPlatform: "win32", runtimeFile, logFile: path.join(state, "gateway.log") });
      expect(config.apnsConfigFile).toBe(path.join(localData, "termloop-next", "apns", "config.json"));
      const health = () => fetch(`http://127.0.0.1:${port}/.well-known/termloop-mobile-access`).then((response) => response.json());
      const first = await health();
      expect(first).toMatchObject({ buildId: v1.artifact.buildId, node: "1" });
      await truncate(config.logFile, 0);
      const details = JSON.parse(await taskOperation(label, "inspect", state));
      expect(details).toMatchObject({ logon: 3, runLevel: 0, limit: "PT0S", battery: false, stopOnBattery: false, instances: 2, trigger: 9, protected: true });
      expect(details.identities).toHaveLength(2);
      expect(details.identities).toContain("S-1-5-18");
      expect(details.action).not.toContain(pairing.controlToken);
      expect(details.action).not.toContain(pairing.terminalToken);

      const repeated = await enroll();
      expect(repeated.stdout.split(/\r?\n/).find((line) => line.startsWith("TLMP1:"))).toBe(code);
      expect((await health()).pid).toBe(first.pid);
      const install = (desired) => reconcileGatewayInstall({ stateDirectory: state, hostPlatform: "win32", desired, nodeExecutable, electronRunAsNode: true });
      expect(await install(v1)).toMatchObject({ status: "current" });
      await taskOperation(label, "stop");
      expect(await install(v1)).toMatchObject({ status: "serviceUpdated" });
      expect((await health()).pid).not.toBe(first.pid);

      const v2 = artifact(2);
      expect(await install(v2)).toMatchObject({ status: "updated" });
      expect((await health()).buildId).toBe(v2.artifact.buildId);
      await expect(install(v1)).rejects.toThrow("Refusing gateway downgrade");
      const broken = artifact(3, true);
      await expect(install(broken)).rejects.toThrow("did not report the desired build");
      expect(JSON.parse(await readFile(path.join(state, "gateway-install.json"), "utf8")).buildId).toBe(v2.artifact.buildId);
      expect(JSON.parse(await readFile(path.join(state, "gateway.json"), "utf8")).controlToken).toBe(pairing.controlToken);
      await waitFor(async () => (await health()).buildId === v2.artifact.buildId);
    } finally {
      await taskOperation(label, "delete");
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 120_000);
});

function artifact(sequence, broken = false) {
  const buildId = `fixture-windows-${sequence}`;
  const bundle = Buffer.from(broken ? "throw new Error('fixture failed update')" : `
    import http from 'node:http';
    import { readFileSync } from 'node:fs';
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    http.createServer((_req, res) => res.end(JSON.stringify({ buildId: '${buildId}', pid: process.pid, node: process.env.ELECTRON_RUN_AS_NODE }))).listen(config.port, '127.0.0.1');
  `);
  const transcriber = Buffer.from("fixture transcriber");
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  return { bundle, transcriber, artifact: {
    manifestVersion: 1, buildId, releaseVersion: "2.0.0", channel: "production", sequence, owner: "termloop.windows.fixture",
    compatibility: { mobileTransport: { min: 2, max: 2 }, mobileApi: { min: 1, max: 1 }, configSchema: { min: 1, max: 2 } },
    artifactSha256: digest(bundle), transcriberSha256: digest(transcriber), bundleFile: "mobile-access-gateway.mjs", transcriberFile: "transcriber/Transcriber.swift",
  } };
}

async function taskOperation(label, operation, directory) {
  return runWindowsPowerShell(`
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = $inputData.label + '.' + $sid
$task = $null
try { $task = $folder.GetTask($name) } catch { if ($inputData.operation -ne 'delete') { throw } }
if ($inputData.operation -eq 'inspect') {
  $acl = Get-Acl -LiteralPath $inputData.directory
  @{ logon = $task.Definition.Principal.LogonType; runLevel = $task.Definition.Principal.RunLevel;
    limit = $task.Definition.Settings.ExecutionTimeLimit; battery = $task.Definition.Settings.DisallowStartIfOnBatteries;
    stopOnBattery = $task.Definition.Settings.StopIfGoingOnBatteries; instances = $task.Definition.Settings.MultipleInstances;
    trigger = $task.Definition.Triggers.Item(1).Type; action = $task.Definition.Actions.Item(1).Arguments;
    protected = $acl.AreAccessRulesProtected; identities = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })
  } | ConvertTo-Json -Compress
} elseif ($null -ne $task) {
  $task.Stop(0)
  if ($inputData.operation -eq 'delete') { $folder.DeleteTask($name, 0) }
}
`, { label, operation, directory });
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check) {
  for (let index = 0; index < 100; index += 1) {
    try { if (await check()) return; } catch { /* Wait for scheduler launch. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fixture gateway did not recover");
}

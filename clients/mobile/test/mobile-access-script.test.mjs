import { execFile as execFileCallback } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe("mobile access bootstrap", () => {
  it.skipIf(process.platform === "win32")("installs a stable gateway and never ships rotating daemon credentials", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-access-"));
    const runtime = path.join(directory, "runtime.json");
    const calls = path.join(directory, "calls.txt");
    const launchCalls = path.join(directory, "launch-calls.txt");
    const launchState = path.join(directory, "launch-state");
    const tailscale = path.join(directory, "tailscale");
    const launchctl = path.join(directory, "launchctl");
    const state = path.join(directory, "state");
    const launchAgentDirectory = path.join(directory, "LaunchAgents");
    writeFileSync(runtime, JSON.stringify({
      protocolVersion: `sha256:${"a".repeat(64)}`,
      controlUrl: "ws://127.0.0.1:48100/control",
      terminalUrl: "ws://127.0.0.1:48100/terminal",
      token: "full-control-must-not-ship",
      readOnlyToken: "r".repeat(64),
      terminalToken: "t".repeat(64),
    }));
    writeFileSync(tailscale, `#!/bin/sh
if [ "$1" = "status" ]; then
  printf '%s' '{"BackendState":"Running","Self":{"Online":true,"DNSName":"mac.example.ts.net.","HostName":"Fixture Mac"}}'
elif [ "$1" = "serve" ]; then
  printf '%s' "$*" > "$CALL_LOG"
elif [ "$1" = "version" ]; then
  printf '%s' '1.0'
else
  exit 2
fi
`);
    chmodSync(tailscale, 0o700);
    writeFileSync(launchctl, `#!/bin/sh
printf '%s\n' "$*" >> "$LAUNCH_LOG"
if [ "$1" = "print" ]; then
  [ -f "$LAUNCH_STATE" ]
elif [ "$1" = "bootstrap" ]; then
  : > "$LAUNCH_STATE"
elif [ "$1" = "bootout" ]; then
  rm -f "$LAUNCH_STATE"
fi
`);
    chmodSync(launchctl, 0o700);

    const command = [
      path.resolve("scripts/mobile-access.mjs"),
      "--runtime", runtime,
      "--tailscale-bin", tailscale,
      "--launchctl-bin", launchctl,
      "--state-dir", state,
      "--launch-agent-dir", launchAgentDirectory,
      "--gateway-port", "49222",
      "--platform", "darwin",
      "--test-platform",
      "--skip-gateway-wait",
      "--print",
    ];
    const environment = {
      ...process.env,
      CALL_LOG: calls,
      LAUNCH_LOG: launchCalls,
      LAUNCH_STATE: launchState,
    };
    const { stdout } = await execFile(process.execPath, command, {
      cwd: path.resolve("."),
      env: environment,
      encoding: "utf8",
    });
    const code = stdout.split("\n")[0];
    expect(code.startsWith("TLMP1:")).toBe(true);
    const payload = JSON.parse(code.slice("TLMP1:".length));
    expect(payload).toMatchObject({
      name: "Fixture Mac",
      controlUrl: "wss://mac.example.ts.net/control",
      terminalUrl: "wss://mac.example.ts.net/terminal",
    });
    expect(payload.controlToken).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.terminalToken).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.controlToken).not.toBe("r".repeat(64));
    expect(payload.terminalToken).not.toBe("t".repeat(64));
    expect(JSON.stringify(payload)).not.toContain("full-control-must-not-ship");
    expect(JSON.stringify(payload)).not.toContain("r".repeat(64));
    expect(JSON.stringify(payload)).not.toContain("t".repeat(64));
    expect(readFileSync(calls, "utf8")).toBe("serve --bg --yes 127.0.0.1:49222");
    expect(readFileSync(launchCalls, "utf8")).toContain("bootstrap");
    const installedGateway = path.join(state, "mobile-access-gateway.mjs");
    expect(readFileSync(installedGateway, "utf8")).toContain("TermLoop is starting");
    const plist = readFileSync(path.join(
      launchAgentDirectory,
      "ai.termloop.mobile-access.6343ac534b7a01f6.plist",
    ), "utf8");
    expect(plist).toContain(installedGateway);
    expect(plist).not.toContain(path.resolve("scripts/mobile-access-gateway.mjs"));
    expect(statSync(path.join(
      launchAgentDirectory,
      "ai.termloop.mobile-access.6343ac534b7a01f6.plist",
    )).mode & 0o777).toBe(0o644);
    expect(statSync(path.join(state, "gateway.json")).mode & 0o777).toBe(0o600);

    // A gateway that fails while the phone cannot reach it has to leave a trace,
    // so the job's output must land in an owner-only file rather than /dev/null.
    const gatewayLog = path.join(state, "gateway.log");
    expect(plist).toContain(`<key>StandardOutPath</key><string>${gatewayLog}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key><string>${gatewayLog}</string>`);
    expect(plist).not.toContain("/dev/null");
    expect(statSync(gatewayLog).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path.join(state, "gateway.json"), "utf8")).logFile).toBe(gatewayLog);
    writeFileSync(gatewayLog, "first run crashed here\n");

    writeFileSync(runtime, JSON.stringify({
      protocolVersion: `sha256:${"a".repeat(64)}`,
      controlUrl: "ws://127.0.0.1:49999/control",
      terminalUrl: "ws://127.0.0.1:49999/terminal",
      token: "different-full-control-must-not-ship",
      readOnlyToken: "x".repeat(64),
      terminalToken: "y".repeat(64),
    }));
    const { stdout: repeated } = await execFile(process.execPath, command, {
      cwd: path.resolve("."), env: environment, encoding: "utf8",
    });
    const repeatedPayload = JSON.parse(repeated.split("\n")[0].slice("TLMP1:".length));
    expect(repeatedPayload.controlToken).toBe(payload.controlToken);
    expect(repeatedPayload.terminalToken).toBe(payload.terminalToken);
    const recordedLaunchCalls = readFileSync(launchCalls, "utf8").split("\n");
    expect(recordedLaunchCalls.filter((call) => call.startsWith("bootstrap "))).toHaveLength(1);
    expect(recordedLaunchCalls.filter((call) => call.startsWith("kickstart "))).toHaveLength(2);
    expect(recordedLaunchCalls.some((call) => call.startsWith("bootout "))).toBe(false);
    // Reinstalling keeps exactly one earlier generation instead of discarding
    // the evidence or growing a single file forever.
    expect(readFileSync(`${gatewayLog}.previous`, "utf8")).toBe("first run crashed here\n");
    expect(statSync(`${gatewayLog}.previous`).mode & 0o777).toBe(0o600);
    expect(readFileSync(gatewayLog, "utf8")).toBe("");
    expect(statSync(gatewayLog).mode & 0o777).toBe(0o600);

    // launchd runs its own copy of a loaded job, so an install that changes the
    // plist has to unregister the earlier generation instead of only restarting
    // it. Otherwise every existing computer keeps the job it was first given.
    const plistFile = path.join(launchAgentDirectory, "ai.termloop.mobile-access.6343ac534b7a01f6.plist");
    writeFileSync(plistFile, plist.replace(gatewayLog, "/dev/null"));
    await execFile(process.execPath, command, {
      cwd: path.resolve("."), env: environment, encoding: "utf8",
    });
    expect(readFileSync(plistFile, "utf8")).toBe(plist);
    const reloadCalls = readFileSync(launchCalls, "utf8").split("\n");
    expect(reloadCalls.filter((call) => call.startsWith("bootout "))).toHaveLength(1);
    expect(reloadCalls.filter((call) => call.startsWith("bootstrap "))).toHaveLength(2);
    expect(reloadCalls.filter((call) => call.startsWith("kickstart "))).toHaveLength(3);
    const domain = `gui/${process.getuid()}`;
    expect(reloadCalls.indexOf(`bootout ${domain}/ai.termloop.mobile-access.6343ac534b7a01f6`))
      .toBeLessThan(reloadCalls.lastIndexOf(`bootstrap ${domain} ${plistFile}`));
  }, 20_000);

  it.skipIf(process.platform === "win32")("installs and restarts a persistent systemd user service on Linux", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-access-linux-"));
    const runtime = path.join(directory, "runtime.json");
    const tailscaleCalls = path.join(directory, "tailscale-calls.txt");
    const systemctlCalls = path.join(directory, "systemctl-calls.txt");
    const tailscale = path.join(directory, "tailscale");
    const systemctl = path.join(directory, "systemctl");
    const state = path.join(directory, "state");
    const serviceDirectory = path.join(directory, "systemd/user");
    writeFileSync(runtime, JSON.stringify({
      protocolVersion: `sha256:${"b".repeat(64)}`,
      controlUrl: "ws://127.0.0.1:48200/control",
      terminalUrl: "ws://127.0.0.1:48200/terminal",
      token: "linux-full-control-must-not-ship",
      readOnlyToken: "u".repeat(64),
      terminalToken: "v".repeat(64),
    }));
    writeFileSync(tailscale, `#!/bin/sh
if [ "$1" = "status" ]; then
  printf '%s' '{"BackendState":"Running","Self":{"Online":true,"DNSName":"ubuntu.example.ts.net.","HostName":"Ubuntu Workstation"}}'
elif [ "$1" = "serve" ]; then
  printf '%s' "$*" > "$CALL_LOG"
elif [ "$1" = "version" ]; then
  printf '%s' '1.0'
else
  exit 2
fi
`);
    chmodSync(tailscale, 0o700);
    writeFileSync(systemctl, `#!/bin/sh
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
`);
    chmodSync(systemctl, 0o700);

    const { stdout } = await execFile(process.execPath, [
      path.resolve("scripts/mobile-access.mjs"),
      "--runtime", runtime,
      "--tailscale-bin", tailscale,
      "--systemctl-bin", systemctl,
      "--state-dir", state,
      "--service-dir", serviceDirectory,
      "--gateway-port", "49333",
      "--platform", "linux",
      "--skip-gateway-wait",
      "--print",
    ], {
      cwd: path.resolve("."),
      env: { ...process.env, CALL_LOG: tailscaleCalls, SYSTEMCTL_LOG: systemctlCalls },
      encoding: "utf8",
    });

    const code = stdout.split("\n")[0];
    expect(code.startsWith("TLMP1:")).toBe(true);
    const payload = JSON.parse(code.slice("TLMP1:".length));
    expect(payload).toMatchObject({
      name: "Ubuntu Workstation",
      controlUrl: "wss://ubuntu.example.ts.net/control",
      terminalUrl: "wss://ubuntu.example.ts.net/terminal",
    });
    expect(JSON.stringify(payload)).not.toContain("linux-full-control-must-not-ship");
    expect(JSON.stringify(payload)).not.toContain("u".repeat(64));
    expect(JSON.stringify(payload)).not.toContain("v".repeat(64));
    expect(readFileSync(tailscaleCalls, "utf8")).toBe("serve --bg --yes 127.0.0.1:49333");
    expect(readFileSync(systemctlCalls, "utf8")).toBe([
      "--user daemon-reload",
      `--user enable ai.termloop.mobile-access.${payload.connectionId.slice(4)}.service`,
      `--user restart ai.termloop.mobile-access.${payload.connectionId.slice(4)}.service`,
      "",
    ].join("\n"));

    const config = JSON.parse(readFileSync(path.join(state, "gateway.json"), "utf8"));
    expect(config.hostPlatform).toBe("linux");
    expect(config.apnsConfigFile).toContain("termloop-next/apns/config.json");
    expect(statSync(path.join(state, "gateway.json")).mode & 0o777).toBe(0o600);
    const unitFile = path.join(
      serviceDirectory,
      `ai.termloop.mobile-access.${payload.connectionId.slice(4)}.service`,
    );
    const unit = readFileSync(unitFile, "utf8");
    expect(unit).toContain(`ExecStart="${process.execPath}"`);
    expect(unit).toContain(`WorkingDirectory="${state}"`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).not.toContain(config.controlToken);
    expect(unit).not.toContain(config.terminalToken);
    // systemd already retains this output in the journal, so the Linux service
    // keeps no private log file and the gateway applies no bound of its own.
    expect(config.logFile).toBeUndefined();
    expect(unit).not.toContain("StandardOutput=");
    expect(statSync(unitFile).mode & 0o777).toBe(0o644);
  }, 15_000);
});

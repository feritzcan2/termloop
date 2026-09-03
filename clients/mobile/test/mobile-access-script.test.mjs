import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { reconcileGatewayInstall } from "../scripts/mobile-access-installer.mjs";

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
    const installManifest = JSON.parse(readFileSync(path.join(state, "gateway-install.json"), "utf8"));
    expect(installManifest).toMatchObject({
      manifestVersion: 1,
      channel: "development",
      sequence: 3,
      compatibility: {
        mobileTransport: { min: 2, max: 2 },
        mobileApi: { min: 1, max: 1 },
        configSchema: { min: 1, max: 2 },
      },
    });
    expect(installManifest.buildId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(installManifest.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(installedGateway, "utf8")).toContain(installManifest.buildId);
    expect(createHash("sha256").update(readFileSync(installedGateway)).digest("hex"))
      .toBe(installManifest.artifactSha256);
    expect(JSON.stringify(installManifest)).not.toContain(payload.controlToken);
    expect(JSON.stringify(installManifest)).not.toContain(payload.terminalToken);
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
    expect(recordedLaunchCalls.filter((call) => call.startsWith("kickstart "))).toHaveLength(0);
    expect(recordedLaunchCalls.filter((call) => call.startsWith("kill SIGTERM "))).toHaveLength(0);
    expect(recordedLaunchCalls.some((call) => call.startsWith("bootout "))).toBe(false);
    // The runtime file path and artifact are unchanged; rotating daemon tokens
    // are read from that file at request time, so no restart or log rotation occurs.
    expect(existsSync(`${gatewayLog}.previous`)).toBe(false);
    expect(readFileSync(gatewayLog, "utf8")).toBe("first run crashed here\n");
    expect(statSync(gatewayLog).mode & 0o777).toBe(0o600);

    // Reconciliation uses only enrolled state and the source artifact. A missing
    // daemon discovery file and an unavailable Tailscale command do not matter.
    const beforeReconcileCalls = serviceMutationCalls(readFileSync(launchCalls, "utf8"));
    const reconcile = await execFile(process.execPath, [
      path.resolve("scripts/mobile-access.mjs"),
      "--reconcile",
      "--state-dir", state,
      "--launch-agent-dir", launchAgentDirectory,
      "--launchctl-bin", launchctl,
      "--platform", "darwin",
      "--test-platform",
      "--skip-gateway-wait",
    ], { cwd: path.resolve("."), env: environment, encoding: "utf8" });
    expect(JSON.parse(reconcile.stdout)).toMatchObject({ status: "current", buildId: installManifest.buildId });
    expect(serviceMutationCalls(readFileSync(launchCalls, "utf8"))).toEqual(beforeReconcileCalls);

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
    expect(reloadCalls.filter((call) => call.startsWith("kickstart "))).toHaveLength(0);
    const domain = `gui/${process.getuid()}`;
    expect(reloadCalls.indexOf(`bootout ${domain}/ai.termloop.mobile-access.6343ac534b7a01f6`))
      .toBeLessThan(reloadCalls.lastIndexOf(`bootstrap ${domain} ${plistFile}`));

    const quietCommand = command.map((argument) => argument === "--print" ? "--quiet" : argument);
    const { stdout: quietOutput } = await execFile(process.execPath, quietCommand, {
      cwd: path.resolve("."), env: environment, encoding: "utf8",
    });
    expect(quietOutput).not.toContain("TLMP1:");
    expect(quietOutput).toContain("Tailnet endpoint: https://mac.example.ts.net");

    // Pairing is an explicit human action, so a packaged build may take over a
    // development-owned install without regenerating the stable device tokens.
    const productionEnrollment = await execFile(process.execPath, [
      ...command,
      "--channel", "production",
      "--owner", "ai.termloop.desktop",
    ], { cwd: path.resolve("."), env: environment, encoding: "utf8" });
    const productionPayload = JSON.parse(
      productionEnrollment.stdout.split("\n")[0].slice("TLMP1:".length),
    );
    expect(productionPayload.controlToken).toBe(payload.controlToken);
    expect(productionPayload.terminalToken).toBe(payload.terminalToken);
    const productionManifest = JSON.parse(
      readFileSync(path.join(state, "gateway-install.json"), "utf8"),
    );
    expect(productionManifest).toMatchObject({
      channel: "production",
      owner: "ai.termloop.desktop",
      installOverrides: [expect.objectContaining({
        policy: "enrollment",
        reason: "explicit enrollment",
        previousChannel: "development",
        previousOwner: installManifest.owner,
      })],
    });

    await execFile(process.execPath, [
      path.resolve("scripts/mobile-access.mjs"),
      "--reconcile",
      "--force",
      "--force-reason", "explicit fixture repair",
      "--state-dir", state,
      "--launch-agent-dir", launchAgentDirectory,
      "--launchctl-bin", launchctl,
      "--platform", "darwin",
      "--test-platform",
      "--skip-gateway-wait",
    ], { cwd: path.resolve("."), env: environment, encoding: "utf8" });
    expect(JSON.parse(readFileSync(path.join(state, "gateway-install.json"), "utf8")))
      .toMatchObject({
        channel: "development",
        installOverrides: expect.arrayContaining([expect.objectContaining({
          policy: "force",
          reason: "explicit fixture repair",
          previousChannel: "production",
          previousOwner: "ai.termloop.desktop",
        })]),
      });
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

  it.skipIf(process.platform === "win32")("serializes reconciliation, preserves tokens, and refuses downgrades", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-reconcile-"));
    const state = path.join(directory, "state");
    const launchAgentDirectory = path.join(directory, "LaunchAgents");
    const launchctl = path.join(directory, "launchctl");
    const launchState = path.join(directory, "launch-state");
    const launchCalls = path.join(directory, "launch-calls.txt");
    const tokens = { controlToken: "c".repeat(64), terminalToken: "t".repeat(64) };
    await import("node:fs/promises").then(({ mkdir }) => mkdir(state, { recursive: true }));
    writeFileSync(path.join(state, "gateway.json"), JSON.stringify({
      version: 2,
      connectionId: "mac-0123456789abcdef",
      hostPlatform: "darwin",
      port: 49223,
      runtimeFile: path.join(directory, "missing-runtime.json"),
      logFile: path.join(state, "gateway.log"),
      ...tokens,
    }));
    writeFileSync(path.join(state, "gateway.log"), "");
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
    const previousLaunchLog = process.env.LAUNCH_LOG;
    const previousLaunchState = process.env.LAUNCH_STATE;
    process.env.LAUNCH_LOG = launchCalls;
    process.env.LAUNCH_STATE = launchState;
    try {
      const v2 = fixtureArtifact(2, "gateway-v2");
      await reconcileGatewayInstall({
        stateDirectory: state,
        desired: v2,
        hostPlatform: "darwin",
        launchctlBin: launchctl,
        launchAgentDirectory,
        skipGatewayWait: true,
        testPlatform: true,
      });
      const afterInstallCalls = serviceMutationCalls(readFileSync(launchCalls, "utf8"));
      const concurrent = await Promise.all([1, 2].map(() => reconcileGatewayInstall({
        stateDirectory: state,
        desired: v2,
        hostPlatform: "darwin",
        launchctlBin: launchctl,
        launchAgentDirectory,
        skipGatewayWait: true,
        testPlatform: true,
      })));
      expect(concurrent.map(({ status }) => status)).toEqual(["current", "current"]);
      expect(serviceMutationCalls(readFileSync(launchCalls, "utf8"))).toEqual(afterInstallCalls);

      const nextRuntimeFile = path.join(directory, "next-runtime.json");
      const configUpdate = await reconcileGatewayInstall({
        stateDirectory: state,
        desired: v2,
        hostPlatform: "darwin",
        launchctlBin: launchctl,
        launchAgentDirectory,
        skipGatewayWait: true,
        testPlatform: true,
        nextConfig: {
          ...JSON.parse(readFileSync(path.join(state, "gateway.json"), "utf8")),
          runtimeFile: nextRuntimeFile,
        },
      });
      expect(configUpdate.status).toBe("configUpdated");
      expect(readFileSync(launchCalls, "utf8")).toContain("kill SIGTERM");
      expect(JSON.parse(readFileSync(path.join(state, "gateway.json"), "utf8")).runtimeFile)
        .toBe(nextRuntimeFile);

      const v3 = fixtureArtifact(3, "gateway-v3");
      await reconcileGatewayInstall({
        stateDirectory: state,
        desired: v3,
        hostPlatform: "darwin",
        launchctlBin: launchctl,
        launchAgentDirectory,
        skipGatewayWait: true,
        testPlatform: true,
      });
      expect(readFileSync(launchCalls, "utf8")).toContain("kill SIGTERM");
      expect(JSON.parse(readFileSync(path.join(state, "gateway.json"), "utf8"))).toMatchObject(tokens);
      expect(readFileSync(path.join(state, "mobile-access-gateway.previous.mjs"), "utf8")).toBe("gateway-v2");

      // A service restart failure restores the last-known-good complete bundle
      // and manifest; credentials remain in the untouched gateway.json.
      writeFileSync(launchctl, `#!/bin/sh
printf '%s\n' "$*" >> "$LAUNCH_LOG"
if [ "$1" = "print" ]; then [ -f "$LAUNCH_STATE" ]; fi
if [ "$1" = "kill" ]; then exit 7; fi
`);
      chmodSync(launchctl, 0o700);
      await expect(reconcileGatewayInstall({
        stateDirectory: state,
        desired: fixtureArtifact(4, "gateway-v4"),
        hostPlatform: "darwin",
        launchctlBin: launchctl,
        launchAgentDirectory,
        skipGatewayWait: true,
        testPlatform: true,
        nextConfig: {
          ...JSON.parse(readFileSync(path.join(state, "gateway.json"), "utf8")),
          runtimeFile: path.join(directory, "new-runtime.json"),
        },
      })).rejects.toThrow();
      expect(readFileSync(path.join(state, "mobile-access-gateway.mjs"), "utf8")).toBe("gateway-v3");
      expect(JSON.parse(readFileSync(path.join(state, "gateway-install.json"), "utf8")))
        .toMatchObject({ sequence: 3, buildId: v3.artifact.buildId });
      expect(readFileSync(path.join(state, "transcriber", "Transcriber.swift"), "utf8"))
        .toBe("fixture transcriber gateway-v3");
      expect(JSON.parse(readFileSync(path.join(state, "gateway.json"), "utf8"))).toMatchObject(tokens);
      expect(JSON.parse(readFileSync(path.join(state, "gateway.json"), "utf8")).runtimeFile)
        .toBe(nextRuntimeFile);

      await expect(reconcileGatewayInstall({
        stateDirectory: state,
        desired: v2,
        hostPlatform: "darwin",
        launchctlBin: launchctl,
        launchAgentDirectory,
        skipGatewayWait: true,
        testPlatform: true,
      })).rejects.toThrow("Refusing gateway downgrade");

      writeFileSync(path.join(state, "gateway-install.json"), "{corrupt");
      await expect(reconcileGatewayInstall({
        stateDirectory: state,
        desired: v3,
        hostPlatform: "darwin",
        launchctlBin: launchctl,
        launchAgentDirectory,
        skipGatewayWait: true,
        testPlatform: true,
      })).rejects.toThrow("manifest is corrupt; refusing automatic replacement");
    } finally {
      if (previousLaunchLog === undefined) delete process.env.LAUNCH_LOG;
      else process.env.LAUNCH_LOG = previousLaunchLog;
      if (previousLaunchState === undefined) delete process.env.LAUNCH_STATE;
      else process.env.LAUNCH_STATE = previousLaunchState;
    }
  });

  it.skipIf(process.platform === "win32")("keeps unattended ownership strict and audits explicit overrides", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-mobile-policy-"));
    const state = path.join(directory, "state");
    const serviceDirectory = path.join(directory, "systemd");
    const systemctl = path.join(directory, "systemctl");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(state, { recursive: true }));
    const tokens = { controlToken: "c".repeat(64), terminalToken: "t".repeat(64) };
    writeFileSync(path.join(state, "gateway.json"), JSON.stringify({
      version: 2,
      connectionId: "mac-fedcba9876543210",
      hostPlatform: "linux",
      port: 49224,
      runtimeFile: path.join(directory, "runtime.json"),
      ...tokens,
    }));
    writeFileSync(systemctl, "#!/bin/sh\nexit 0\n");
    chmodSync(systemctl, 0o700);
    const install = (desired, options = {}) => reconcileGatewayInstall({
      stateDirectory: state,
      desired,
      hostPlatform: "linux",
      systemctlBin: systemctl,
      serviceDirectory,
      skipGatewayWait: true,
      ...options,
    });
    const development = fixtureArtifact(3, "dev-checkout-a", {
      channel: "development",
      owner: "termloop.dev.checkout-a",
    });
    const production = fixtureArtifact(3, "production", {
      channel: "production",
      owner: "ai.termloop.desktop",
    });
    await install(development);

    await expect(install(production)).rejects.toThrow(
      "Refusing to replace development gateway with production",
    );
    await expect(install(fixtureArtifact(2, "older-production", {
      channel: "production",
      owner: "ai.termloop.desktop",
    }), { installPolicy: "enrollment" })).rejects.toThrow("Refusing gateway downgrade");

    await install(production, { installPolicy: "enrollment" });
    let manifest = JSON.parse(readFileSync(path.join(state, "gateway-install.json"), "utf8"));
    expect(manifest).toMatchObject({
      channel: "production",
      owner: "ai.termloop.desktop",
      installOverrides: [expect.objectContaining({
        policy: "enrollment",
        previousChannel: "development",
        previousOwner: "termloop.dev.checkout-a",
      })],
    });
    expect(JSON.parse(readFileSync(path.join(state, "gateway.json"), "utf8"))).toMatchObject(tokens);

    const forcedDevelopment = fixtureArtifact(2, "forced-dev", {
      channel: "development",
      owner: "termloop.dev.checkout-b",
    });
    await install(forcedDevelopment, { forceReason: "operator repair from test" });
    manifest = JSON.parse(readFileSync(path.join(state, "gateway-install.json"), "utf8"));
    expect(manifest).toMatchObject({
      channel: "development",
      owner: "termloop.dev.checkout-b",
      sequence: 2,
    });
    expect(manifest.installOverrides).toEqual(expect.arrayContaining([
      expect.objectContaining({
        policy: "force",
        reason: "operator repair from test",
        previousChannel: "production",
        previousOwner: "ai.termloop.desktop",
        previousSequence: 3,
      }),
    ]));

    const nextCheckout = fixtureArtifact(2, "dev-checkout-c", {
      channel: "development",
      owner: "termloop.dev.checkout-c",
    });
    await install(nextCheckout, { installPolicy: "developmentTakeover" });
    manifest = JSON.parse(readFileSync(path.join(state, "gateway-install.json"), "utf8"));
    expect(manifest).toMatchObject({
      owner: "termloop.dev.checkout-c",
      installOverrides: expect.arrayContaining([expect.objectContaining({
        policy: "developmentTakeover",
        previousOwner: "termloop.dev.checkout-b",
      })]),
    });
  });
});

function fixtureArtifact(sequence, content, metadata = {}) {
  const bundle = Buffer.from(content);
  const transcriber = Buffer.from(`fixture transcriber ${content}`);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  return {
    bundle,
    transcriber,
    artifact: {
      manifestVersion: 1,
      buildId: `sha256:${digest(bundle)}`,
      releaseVersion: "2.0.0",
      channel: "development",
      sequence,
      owner: "termloop.fixture",
      ...metadata,
      compatibility: {
        mobileTransport: { min: 2, max: 2 },
        mobileApi: { min: 1, max: 1 },
        configSchema: { min: 1, max: 2 },
      },
      sourceGraphSha256: digest(bundle),
      artifactSha256: digest(bundle),
      transcriberSha256: digest(transcriber),
      bundleFile: "mobile-access-gateway.mjs",
      transcriberFile: "transcriber/Transcriber.swift",
    },
  };
}

function serviceMutationCalls(log) {
  return log.split("\n").filter((line) => /^(bootstrap|bootout|kill|kickstart) /.test(line));
}

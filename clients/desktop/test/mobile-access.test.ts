import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  mobileAccessNodeExecutable,
  mobileAccessScriptPath,
  packagedMobileAccessScriptPath,
  prepareMobileAccessQr,
  prepareLocalMobileAccessQr,
  publishMobileAgentGroups,
  publishMobileNotificationPreferences,
  reconcilePackagedMobileAccess,
  shouldReconcilePackagedMobileAccess,
} from "../src/platform/mobile-access.js";
import { defaultNotificationPreferences } from "../src/notification-preferences.js";

describe("mobile access QR preparation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
      force: true,
      recursive: true,
    })));
  });

  async function script(source: string): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-mobile-access-test-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "fixture.mjs");
    await writeFile(file, source);
    return file;
  }

  it("resolves the source script from the checkout when the desktop runs from a launch bundle", () => {
    expect(mobileAccessScriptPath(
      "/Library/Application Support/termloop-next/launches/bundle.123/clients/desktop/dist",
      "/Volumes/code/termloop-next",
    )).toBe(path.join(
      "/Volumes/code/termloop-next",
      "clients",
      "mobile",
      "scripts",
      "mobile-access.mjs",
    ));
  });

  it("falls back to node when the launcher provides an empty executable", () => {
    expect(mobileAccessNodeExecutable()).toBe("node");
    expect(mobileAccessNodeExecutable(" ")).toBe("node");
    expect(mobileAccessNodeExecutable("/opt/node/bin/node")).toBe("/opt/node/bin/node");
  });

  it("runs packaged reconciliation through Electron's Node mode", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-mobile-access-bundle-"));
    temporaryDirectories.push(directory);
    const mobileDirectory = path.join(directory, "mobile-access");
    await mkdir(mobileDirectory);
    const packagedScript = packagedMobileAccessScriptPath(directory);
    await writeFile(packagedScript, `console.log(JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }));`);

    const outcome = JSON.parse(await reconcilePackagedMobileAccess(directory, process.execPath));

    expect(outcome.node).toBe("1");
    expect(outcome.args).toEqual(expect.arrayContaining([
      "--reconcile",
      "--artifact-dir",
      mobileDirectory,
      "--electron-run-as-node",
    ]));
  });

  it("auto-reconciles packaged macOS, Linux and Windows applications", () => {
    expect(shouldReconcilePackagedMobileAccess(true, "darwin")).toBe(true);
    expect(shouldReconcilePackagedMobileAccess(true, "linux")).toBe(true);
    expect(shouldReconcilePackagedMobileAccess(true, "win32")).toBe(true);
    expect(shouldReconcilePackagedMobileAccess(false, "darwin")).toBe(false);
    expect(shouldReconcilePackagedMobileAccess(true, "freebsd")).toBe(false);
  });

  it("runs packaged pairing from unpacked assets with the bundled Node runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "termloop packaged mobile-"));
    temporaryDirectories.push(root);
    const bundle = path.join(root, "app.asar", "dist");
    const pairingScript = packagedMobileAccessScriptPath(bundle);
    expect(pairingScript).toBe(path.join(root, "app.asar.unpacked", "dist", "mobile-access", "mobile-access.mjs"));
    await mkdir(path.dirname(pairingScript), { recursive: true });
    const calls = path.join(root, "calls.json");
    await writeFile(pairingScript, `
      const { writeFileSync } = await import('node:fs');
      writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }));
      console.log('TLMP1:{"fixture":true}');
    `);
    const svg = await prepareLocalMobileAccessQr({ isPackaged: true, bundleDirectory: bundle, nodeExecutable: "missing-node" });
    expect(svg).toMatch(/^<svg/);
    expect(svg).not.toContain("fixture");
    const invocation = JSON.parse(await readFile(calls, "utf8"));
    expect(invocation.node).toBe("1");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--print", "--artifact-dir", path.dirname(pairingScript), "--node-executable", process.execPath,
      "--electron-run-as-node", "--runtime",
    ]));
  });

  it("turns a versioned pairing payload into QR geometry without returning the payload", async () => {
    const pairingScript = await script('console.log(\'TLMP1:{"fixture":true}\');');

    const svg = await prepareMobileAccessQr(pairingScript, process.execPath);

    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('style="stroke-linecap:butt;stroke-linejoin:miter;stroke-width:1"');
    expect(svg).not.toContain("TLMP1:");
    expect(svg).not.toContain("fixture");
  });

  it("rejects output that does not contain a pairing payload", async () => {
    const pairingScript = await script('console.log("not a pairing code");');

    await expect(prepareMobileAccessQr(pairingScript, process.execPath)).rejects.toThrow(
      "Mobile Access did not produce a valid pairing code.",
    );
  });

  it("redacts pairing credentials from failed bootstrap output", async () => {
    const pairingScript = await script(`console.log('TLMP1:private-pairing-credential'); console.error('private-error-credential'); process.exit(1);`);
    await expect(prepareMobileAccessQr(pairingScript, process.execPath)).rejects.toThrow(
      "Mobile Access could not start. Check Tailscale and the computer's background service, then try again.",
    );
  });

  it("explains a missing Tailscale installation without exposing child errors", async () => {
    const pairingScript = await script(`throw new Error('Tailscale CLI was not found.');`);
    await expect(prepareMobileAccessQr(pairingScript, process.execPath)).rejects.toThrow(
      "Install and connect Tailscale on this computer, then try Mobile Access again.",
    );
  });

  it("publishes every local peer-group member to enrolled mobile gateways", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "termloop-mobile-groups-"));
    temporaryDirectories.push(stateRoot);
    const gatewayDirectory = path.join(stateRoot, "mac-0123456789abcdef");
    await mkdir(gatewayDirectory);
    await writeFile(path.join(gatewayDirectory, "gateway.json"), "{}", { mode: 0o600 });
    const sessionIds = ["agent-1", "agent-2", "agent-3", "agent-4"];

    await expect(publishMobileAgentGroups({
      version: 2,
      profiles: {
        local: {
          projects: {},
          sessionOrderByProject: { "project-1": sessionIds },
          agentGroupsByProject: {
            "project-1": [{ sessionIds, name: "Review crew" }],
          },
        },
        remote: {
          projects: {},
          sessionOrderByProject: {},
          agentGroupsByProject: {
            "remote-project": [{ sessionIds: ["remote-1", "remote-2"] }],
          },
        },
      },
    }, stateRoot)).resolves.toBe(1);

    expect(JSON.parse(await readFile(path.join(gatewayDirectory, "agent-groups.json"), "utf8")))
      .toEqual({
        version: 1,
        groupsByProject: {
          "project-1": [{ sessionIds, name: "Review crew" }],
        },
      });
  });

  it.each([
    { developmentProfileTag: "files" },
    { smoke: true },
  ])("preserves primary gateway preferences when an isolated desktop publishes: %j", async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "termloop-mobile-preferences-test-"));
    temporaryDirectories.push(root);
    const gatewayDirectory = path.join(root, "mac-0123456789abcdef");
    await mkdir(gatewayDirectory);
    await writeFile(path.join(gatewayDirectory, "gateway.json"), "{}");
    const primary = {
      mobile: { ...defaultNotificationPreferences.mobile, notifyWhenMacActive: true },
      watch: { ...defaultNotificationPreferences.watch, notifyWhenMacActive: true },
    };
    expect(await publishMobileNotificationPreferences(primary, root)).toBe(1);
    expect(await publishMobileNotificationPreferences(defaultNotificationPreferences, root, context)).toBe(0);
    expect(JSON.parse(await readFile(path.join(gatewayDirectory, "notification-preferences.json"), "utf8")))
      .toEqual({ version: 1, ...primary });
  });

  it("publishes Mobile and Watch notification preferences to enrolled gateways", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "termloop-mobile-notifications-"));
    temporaryDirectories.push(stateRoot);
    const gatewayDirectory = path.join(stateRoot, "mac-0123456789abcdef");
    await mkdir(gatewayDirectory);
    await writeFile(path.join(gatewayDirectory, "gateway.json"), "{}", { mode: 0o600 });
    const preferences = {
      ...defaultNotificationPreferences,
      mobile: {
        ...defaultNotificationPreferences.mobile,
        agentReadyForReview: false,
      },
      watch: {
        ...defaultNotificationPreferences.watch,
        playSound: false,
      },
    };

    await expect(publishMobileNotificationPreferences(preferences, stateRoot)).resolves.toBe(1);
    expect(JSON.parse(await readFile(
      path.join(gatewayDirectory, "notification-preferences.json"),
      "utf8",
    ))).toEqual({
      version: 1,
      mobile: preferences.mobile,
      watch: preferences.watch,
    });
  });
});

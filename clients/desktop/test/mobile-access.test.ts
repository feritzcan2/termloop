import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  mobileAccessNodeExecutable,
  mobileAccessScriptPath,
  packagedMobileAccessScriptPath,
  prepareMobileAccessQr,
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

  it("auto-reconciles only packaged macOS and Linux applications", () => {
    expect(shouldReconcilePackagedMobileAccess(true, "darwin")).toBe(true);
    expect(shouldReconcilePackagedMobileAccess(true, "linux")).toBe(true);
    expect(shouldReconcilePackagedMobileAccess(true, "win32")).toBe(false);
    expect(shouldReconcilePackagedMobileAccess(false, "darwin")).toBe(false);
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

import { execFile } from "node:child_process";
import { chmod, lstat, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import QRCode from "qrcode/lib/browser.js";

import type { LayoutDocument } from "../layout/model.js";
import type { NotificationPreferences } from "../notification-preferences.js";

const run = promisify(execFile);
const MAX_BOOTSTRAP_OUTPUT_BYTES = 32 * 1024;
const MAX_AGENT_GROUP_PROJECTION_BYTES = 256 * 1024;
let agentGroupPublishSequence = 0;
let notificationPreferencesPublishSequence = 0;

export function mobileAccessScriptPath(bundleDirectory: string, checkout?: string): string {
  return checkout
    ? path.join(checkout, "clients", "mobile", "scripts", "mobile-access.mjs")
    : path.resolve(bundleDirectory, "../../mobile/scripts/mobile-access.mjs");
}

export function mobileAccessNodeExecutable(configured?: string): string {
  return configured?.trim() || "node";
}

export function packagedMobileAccessScriptPath(bundleDirectory: string): string {
  return path.join(bundleDirectory, "mobile-access", "mobile-access.mjs");
}

export function shouldReconcilePackagedMobileAccess(
  isPackaged: boolean,
  platform = process.platform,
): boolean {
  return isPackaged && (platform === "darwin" || platform === "linux");
}

export async function reconcilePackagedMobileAccess(
  bundleDirectory: string,
  nodeExecutable = process.execPath,
): Promise<string> {
  const script = packagedMobileAccessScriptPath(bundleDirectory);
  const artifactDirectory = path.dirname(script);
  const { stdout } = await run(nodeExecutable, [
    script,
    "--reconcile",
    "--artifact-dir", artifactDirectory,
    "--node-executable", nodeExecutable,
    "--electron-run-as-node",
  ], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    maxBuffer: MAX_BOOTSTRAP_OUTPUT_BYTES,
    timeout: 30_000,
  });
  return stdout.trim();
}

/// Starts the existing owner-mobile gateway without exposing its raw credentials to
/// the renderer. Only the rendered QR geometry crosses IPC.
export async function prepareMobileAccessQr(
  scriptPath: string,
  nodeExecutable = "node",
): Promise<string> {
  const { stdout } = await run(nodeExecutable, [scriptPath, "--print"], {
    maxBuffer: MAX_BOOTSTRAP_OUTPUT_BYTES,
    timeout: 30_000,
  });
  const code = stdout.split(/\r?\n/).find((line) => line.startsWith("TLMP1:"));
  if (!code || code.length > 8 * 1024) {
    throw new Error("Mobile Access did not produce a valid pairing code.");
  }
  const svg = await QRCode.toString(code, {
    type: "svg",
    errorCorrectionLevel: "L",
    margin: 2,
    width: 340,
    color: { dark: "#111517", light: "#ffffff" },
  });
  // The desktop icon system gives every SVG rounded 1.5px strokes. QRCode's SVG
  // renderer relies on the SVG defaults (square 1px strokes), so keep those
  // geometry-critical values self-contained instead of inheriting app chrome CSS.
  return svg.replace(
    "<svg ",
    '<svg style="stroke-linecap:butt;stroke-linejoin:miter;stroke-width:1" ',
  );
}

/// Publishes only the local Mac's presentation groups beside each enrolled
/// owner-mobile gateway. The daemon remains unaware of client layout, while the
/// phone can render the same explicit peer grouping through its authenticated
/// gateway. The complete layout and remote-profile groups never cross this seam.
export async function publishMobileAgentGroups(
  document: LayoutDocument,
  stateRoot = mobileAccessStateRoot(),
): Promise<number> {
  const groupsByProject = document.profiles.local?.agentGroupsByProject ?? {};
  const source = `${JSON.stringify({ version: 1, groupsByProject })}\n`;
  if (Buffer.byteLength(source) > MAX_AGENT_GROUP_PROJECTION_BYTES) {
    throw new Error("mobileAgentGroupProjectionTooLarge");
  }
  const entries = await readdir(stateRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  let published = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^mac-[a-f0-9]{16}$/u.test(entry.name)) continue;
    const directory = path.join(stateRoot, entry.name);
    const config = await lstat(path.join(directory, "gateway.json")).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!config?.isFile() || config.isSymbolicLink()) continue;
    const destination = path.join(directory, "agent-groups.json");
    const temporary = `${destination}.tmp-${process.pid}-${++agentGroupPublishSequence}`;
    try {
      await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
      await chmod(destination, 0o600);
      published += 1;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  return published;
}

/// Publishes this Mac's iPhone and Apple Watch delivery policy beside every
/// enrolled gateway. The gateway reads latest state before each APNs delivery,
/// so changing a switch does not require restarting Mobile Access.
export async function publishMobileNotificationPreferences(
  preferences: Pick<NotificationPreferences, "mobile" | "watch">,
  stateRoot = mobileAccessStateRoot(),
): Promise<number> {
  const source = `${JSON.stringify({
    version: 1,
    mobile: preferences.mobile,
    watch: preferences.watch,
  })}\n`;
  const entries = await readdir(stateRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  let published = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^mac-[a-f0-9]{16}$/u.test(entry.name)) continue;
    const directory = path.join(stateRoot, entry.name);
    const config = await lstat(path.join(directory, "gateway.json")).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!config?.isFile() || config.isSymbolicLink()) continue;
    const destination = path.join(directory, "notification-preferences.json");
    const temporary = `${destination}.tmp-${process.pid}-${++notificationPreferencesPublishSequence}`;
    try {
      await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
      await chmod(destination, 0o600);
      published += 1;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  return published;
}

function mobileAccessStateRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/TermLoop Mobile Access");
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "termloop-next", "mobile-access");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

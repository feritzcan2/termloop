import { execFile } from "node:child_process";
import { chmod, lstat, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import QRCode from "qrcode/lib/browser.js";
import { defaultRuntimeFile } from "./discovery.js";

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
  const unpacked = bundleDirectory.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  return path.join(unpacked, "mobile-access", "mobile-access.mjs");
}

export async function prepareLocalMobileAccessQr(options: {
  isPackaged: boolean;
  bundleDirectory: string;
  checkout?: string | undefined;
  nodeExecutable?: string | undefined;
}): Promise<string> {
  const script = options.isPackaged
    ? packagedMobileAccessScriptPath(options.bundleDirectory)
    : mobileAccessScriptPath(options.bundleDirectory, options.checkout);
  return prepareMobileAccessQr(
    script,
    options.isPackaged ? process.execPath : mobileAccessNodeExecutable(options.nodeExecutable),
    {
      runtimeFile: defaultRuntimeFile(process.env),
      ...(options.isPackaged ? { artifactDirectory: path.dirname(script), electronRunAsNode: true } : {}),
    },
  );
}

export function shouldReconcilePackagedMobileAccess(
  isPackaged: boolean,
  platform = process.platform,
): boolean {
  return isPackaged && (platform === "darwin" || platform === "linux" || platform === "win32");
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
    timeout: 90_000,
    windowsHide: true,
  });
  return stdout.trim();
}

/// Starts the existing owner-mobile gateway without exposing its raw credentials to
/// the renderer. Only the rendered QR geometry crosses IPC.
export async function prepareMobileAccessQr(
  scriptPath: string,
  nodeExecutable = "node",
  options: { artifactDirectory?: string; electronRunAsNode?: boolean; runtimeFile?: string } = {},
): Promise<string> {
  const { stdout } = await run(nodeExecutable, [scriptPath, "--print",
    ...(options.runtimeFile ? ["--runtime", options.runtimeFile] : []),
    ...(options.artifactDirectory ? ["--artifact-dir", options.artifactDirectory, "--node-executable", nodeExecutable] : []),
    ...(options.electronRunAsNode ? ["--electron-run-as-node"] : []),
  ], {
    env: { ...process.env, ...(options.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    maxBuffer: MAX_BOOTSTRAP_OUTPUT_BYTES,
    timeout: 90_000,
    windowsHide: true,
  }).catch((cause: unknown) => { throw mobileAccessPreparationError(cause); });
  const code = stdout.split(/\r?\n/).find((line) => line.startsWith("TLMP1:"));
  if (!code || code.length > 8 * 1024) {
    throw new Error("Mobile Access did not produce a valid pairing code.");
  }
  return mobilePairingQr(code);
}

function mobileAccessPreparationError(cause: unknown): Error {
  // execFile's message can contain stdout, including a pairing credential. Only
  // allowlisted diagnostics cross IPC; never forward the child error wholesale.
  const error = cause as { stderr?: string; killed?: boolean };
  const diagnostic = error?.stderr ?? "";
  if (diagnostic.includes("Tailscale CLI was not found")) {
    return new Error("Install and connect Tailscale on this computer, then try Mobile Access again.");
  }
  if (diagnostic.includes("Tailscale is not connected")) {
    return new Error("Connect Tailscale on this computer, then try Mobile Access again.");
  }
  if (diagnostic.includes("ENOENT") && diagnostic.includes("runtime.json")) {
    return new Error("TermLoop's local server is not ready. Wait for it to connect, then try Mobile Access again.");
  }
  if (error?.killed) return new Error("Mobile Access setup timed out. Check Tailscale and try again.");
  return new Error("Mobile Access could not start. Check Tailscale and the computer's background service, then try again.");
}

export async function mobilePairingQr(code: string): Promise<string> {
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
  context: { developmentProfileTag?: string | undefined; smoke?: boolean } = {},
): Promise<number> {
  // Isolated desktops share this host's enrolled gateway, but their private
  // defaults must never replace the primary desktop's notification choices.
  if (context.developmentProfileTag || context.smoke) return 0;
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
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "termloop-next", "mobile-access");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/TermLoop Mobile Access");
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "termloop-next", "mobile-access");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

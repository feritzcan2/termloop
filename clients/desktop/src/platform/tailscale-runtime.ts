import { execFile } from "node:child_process";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;
const MAX_DISCOVERABLE_PEERS = 64;
export const TERMLOOP_TAILSCALE_HTTPS_PORT = 43_717;

export type TailscaleCommandResult = {
  stdout: string;
  stderr: string;
};

export type TailscaleCommandRunner = (args: readonly string[]) => Promise<TailscaleCommandResult>;

export type TailscaleServeInspection =
  | { state: "available"; baseUrl: string }
  | { state: "ready"; baseUrl: string }
  | { state: "conflict"; message: string }
  | { state: "unavailable"; message: string };

export type TailscalePeer = {
  name: string;
  dnsName: string;
  baseUrl: string;
};

export class TailscaleRuntimeError extends Error {
  constructor(
    readonly code: "tailscaleUnavailable" | "tailscaleSignedOut" | "tailscaleServeFailed",
    message: string,
  ) {
    super(message);
    this.name = "TailscaleRuntimeError";
  }
}

export async function inspectTailscaleServe(
  accessPort: number,
  runner: TailscaleCommandRunner = runTailscale,
): Promise<TailscaleServeInspection> {
  validatePort(accessPort);
  try {
    const node = parseTailscaleNodeStatus((await runner(["status", "--json"])).stdout, accessPort);
    const serve = await runner(["serve", "status", "--json"]);
    const mapping = inspectServeJson(serve.stdout, accessPort);
    if (mapping.state !== "available") return mapping;
    return { state: "available", baseUrl: node.baseUrl };
  } catch (error) {
    if (error instanceof TailscaleRuntimeError) {
      return { state: "unavailable", message: error.message };
    }
    return {
      state: "unavailable",
      message: "Tailscale status could not be read. Open Tailscale, sign in, and try again.",
    };
  }
}

export async function listOnlineTailscalePeers(
  runner: TailscaleCommandRunner = runTailscale,
): Promise<TailscalePeer[]> {
  return parseOnlineTailscalePeers((await runner(["status", "--json"])).stdout);
}

export function parseOnlineTailscalePeers(source: string): TailscalePeer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TailscaleRuntimeError(
      "tailscaleServeFailed",
      "Tailscale returned an unreadable device list. Update Tailscale and try again.",
    );
  }
  if (!isObject(parsed) || parsed.BackendState !== "Running") {
    throw new TailscaleRuntimeError(
      "tailscaleSignedOut",
      "Tailscale is not connected. Open Tailscale, sign in, and try again.",
    );
  }
  if (!isObject(parsed.Peer)) return [];
  const peers = new Map<string, TailscalePeer>();
  for (const candidate of Object.values(parsed.Peer)) {
    if (peers.size >= MAX_DISCOVERABLE_PEERS) break;
    if (!isObject(candidate) || candidate.Online !== true) continue;
    const dnsName = typeof candidate.DNSName === "string"
      ? normalizedTailscaleDnsName(candidate.DNSName)
      : undefined;
    if (!dnsName || peers.has(dnsName)) continue;
    const hostName = typeof candidate.HostName === "string"
      ? displayPeerName(candidate.HostName)
      : undefined;
    peers.set(dnsName, {
      name: hostName ?? dnsName.split(".")[0]!,
      dnsName,
      baseUrl: `wss://${dnsName}:${TERMLOOP_TAILSCALE_HTTPS_PORT}`,
    });
  }
  return [...peers.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function configureTailscaleServe(
  accessPort: number,
  runner: TailscaleCommandRunner = runTailscale,
): Promise<string> {
  const before = await inspectTailscaleServe(accessPort, runner);
  if (before.state === "ready") return before.baseUrl;
  if (before.state === "conflict" || before.state === "unavailable") {
    throw new TailscaleRuntimeError("tailscaleServeFailed", before.message);
  }
  const target = loopbackTarget(accessPort);
  await runner(["serve", "--bg", "--yes", `--https=${accessPort}`, target]);
  const after = await inspectTailscaleServe(accessPort, runner);
  if (after.state === "ready") return after.baseUrl;
  if (after.state === "conflict" || after.state === "unavailable") {
    throw new TailscaleRuntimeError("tailscaleServeFailed", after.message);
  }
  // A successful background update can become visible to `serve status` a
  // moment later. The node URL is already authenticated output from status.
  return after.baseUrl;
}

export async function disableTermLoopTailscaleServe(
  accessPort: number,
  runner: TailscaleCommandRunner = runTailscale,
): Promise<void> {
  const current = await inspectTailscaleServe(accessPort, runner);
  if (current.state !== "ready") return;
  await runner(["serve", "--yes", `--https=${accessPort}`, "off"]);
}

export function parseTailscaleNodeStatus(source: string, httpsPort: number): { baseUrl: string } {
  validatePort(httpsPort);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TailscaleRuntimeError(
      "tailscaleServeFailed",
      "Tailscale returned an unreadable status. Update Tailscale and try again.",
    );
  }
  if (!isObject(parsed) || parsed.BackendState !== "Running") {
    throw new TailscaleRuntimeError(
      "tailscaleSignedOut",
      "Tailscale is not connected. Open Tailscale, sign in, and try again.",
    );
  }
  const self = parsed.Self;
  const dnsName = isObject(self) && typeof self.DNSName === "string"
    ? normalizedTailscaleDnsName(self.DNSName)
    : undefined;
  if (!dnsName) {
    throw new TailscaleRuntimeError(
      "tailscaleServeFailed",
      "Tailscale MagicDNS is unavailable for this computer. Enable MagicDNS and HTTPS in the tailnet, then try again.",
    );
  }
  return { baseUrl: `wss://${dnsName}:${httpsPort}` };
}

export function inspectServeJson(source: string, httpsPort: number): TailscaleServeInspection {
  validatePort(httpsPort);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source || "{}");
  } catch {
    return { state: "available", baseUrl: "" };
  }
  if (!isObject(parsed) || !isObject(parsed.Web)) {
    return { state: "available", baseUrl: "" };
  }
  const target = loopbackTarget(httpsPort);
  for (const [hostAndPort, configuration] of Object.entries(parsed.Web)) {
    if (httpsPortForHost(hostAndPort) !== httpsPort) continue;
    const dnsName = normalizedTailscaleDnsName(hostAndPortWithoutPort(hostAndPort));
    if (dnsName && containsString(configuration, target)) {
      return { state: "ready", baseUrl: `wss://${dnsName}:${httpsPort}` };
    }
    return {
      state: "conflict",
      message: `Tailscale Serve port ${httpsPort} is already used by another service. Choose SSH or free that port in Tailscale first.`,
    };
  }
  return { state: "available", baseUrl: "" };
}

function runTailscale(args: readonly string[]): Promise<TailscaleCommandResult> {
  return runCandidates(tailscaleExecutableCandidates(), args, 0);
}

function runCandidates(
  candidates: readonly string[],
  args: readonly string[],
  index: number,
): Promise<TailscaleCommandResult> {
  const executable = candidates[index];
  if (!executable) {
    return Promise.reject(new TailscaleRuntimeError(
      "tailscaleUnavailable",
      "Tailscale is not installed or its command-line bridge is unavailable. Install and open Tailscale, then try again.",
    ));
  }
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        void runCandidates(candidates, args, index + 1).then(resolve, reject);
        return;
      }
      const diagnostic = `${stderr}\n${stdout}`;
      if (/logged out|not logged in|needslogin|please log in/i.test(diagnostic)) {
        reject(new TailscaleRuntimeError(
          "tailscaleSignedOut",
          "Tailscale is not connected. Open Tailscale, sign in, and try again.",
        ));
        return;
      }
      reject(new TailscaleRuntimeError(
        "tailscaleServeFailed",
        "Tailscale Serve could not be configured. Check that Tailscale is running and this device is allowed to use Serve and HTTPS.",
      ));
    });
  });
}

function tailscaleExecutableCandidates(): string[] {
  if (process.platform === "darwin") {
    return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles;
    return ["tailscale.exe", ...(programFiles ? [`${programFiles}\\Tailscale\\tailscale.exe`] : [])];
  }
  return ["tailscale"];
}

function normalizedTailscaleDnsName(value: string): string | undefined {
  const normalized = value.trim().replace(/\.$/, "").toLowerCase();
  if (normalized.length === 0 || normalized.length > 253 || !normalized.endsWith(".ts.net")) return undefined;
  if (!normalized.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) return undefined;
  return normalized;
}

function displayPeerName(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= 80
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function httpsPortForHost(hostAndPort: string): number | undefined {
  try {
    const parsed = new URL(`https://${hostAndPort}`);
    return parsed.port ? Number(parsed.port) : 443;
  } catch {
    return undefined;
  }
}

function hostAndPortWithoutPort(hostAndPort: string): string {
  try {
    return new URL(`https://${hostAndPort}`).hostname;
  } catch {
    return "";
  }
}

function containsString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsString(item, expected));
  if (!isObject(value)) return false;
  return Object.values(value).some((item) => containsString(item, expected));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loopbackTarget(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("TermLoop access port is invalid");
  }
}

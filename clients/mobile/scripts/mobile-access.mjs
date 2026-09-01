import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildGatewayArtifact,
  defaultArtifactMetadata,
  readGatewayArtifact,
  readGatewayConfig,
  reconcileGatewayInstall,
} from "./mobile-access-installer.mjs";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const has = (name) => args.includes(name);
const hostPlatform = option("--platform") ?? process.platform;
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

await main();

async function main() {
  const metadata = defaultArtifactMetadata({
    releaseVersion: option("--release-version"),
    channel: option("--channel"),
    sequence: option("--sequence"),
    owner: option("--owner"),
  });
  const artifactDirectory = option("--artifact-dir");
  if (has("--build-artifact")) {
    if (artifactDirectory === undefined) throw new Error("--build-artifact requires --artifact-dir.");
    const desired = await buildGatewayArtifact({ scriptsDirectory, artifactDirectory, metadata });
    console.log(JSON.stringify({ status: "built", buildId: desired.artifact.buildId, artifactDirectory }));
    return;
  }
  if (!["darwin", "linux"].includes(hostPlatform) && !has("--test-platform")) {
    throw new Error("Persistent mobile access currently requires macOS or Linux.");
  }
  const desired = artifactDirectory === undefined
    ? await buildGatewayArtifact({ scriptsDirectory, metadata })
    : await readGatewayArtifact(artifactDirectory);
  if (has("--reconcile")) {
    if (has("--force") && has("--take-development-ownership")) {
      throw new Error("Use either --force or --take-development-ownership, not both.");
    }
    const stateDirectories = await reconcileStateDirectories(hostPlatform);
    if (stateDirectories.length === 0) {
      console.log(JSON.stringify({ status: "notInstalled" }));
      return;
    }
    for (const stateDirectory of stateDirectories) {
      const config = await readGatewayConfig(path.join(stateDirectory, "gateway.json"));
      if (config === undefined) continue;
      const result = await installExisting(
        stateDirectory,
        config.hostPlatform ?? hostPlatform,
        desired,
        undefined,
        has("--take-development-ownership") ? "developmentTakeover" : "strict",
      );
      console.log(JSON.stringify(result));
    }
    return;
  }
  await enroll(desired);
}

async function enroll(desired) {
  const runtimeFile = option("--runtime") ?? defaultRuntimeFile(hostPlatform);
  const discovery = JSON.parse(await readFile(runtimeFile, "utf8"));
  validateDiscovery(discovery);
  const tailscaleBin = option("--tailscale-bin") ?? await findTailscale();
  const status = JSON.parse((await execFile(tailscaleBin, ["status", "--json"])).stdout);
  if (status.BackendState !== "Running" || status.Self?.Online !== true) {
    throw new Error("Tailscale is not connected on this computer.");
  }
  const dnsName = requiredString(status.Self?.DNSName, "Tailscale DNS name").replace(/\.$/, "");
  const hostName = option("--name") ?? requiredString(status.Self?.HostName, "Tailscale device name");
  const connectionId = `mac-${createHash("sha256").update(dnsName).digest("hex").slice(0, 16)}`;
  const stateDirectory = option("--state-dir") ?? defaultStateDirectory(hostPlatform, connectionId);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const configFile = path.join(stateDirectory, "gateway.json");
  const existing = await readGatewayConfig(configFile);
  const gatewayPort = Number(option("--gateway-port") ?? existing?.port ?? 46321);
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535) {
    throw new Error("Mobile access gateway port is invalid.");
  }
  const logFile = hostPlatform === "darwin" ? path.join(stateDirectory, "gateway.log") : undefined;
  const config = {
    version: 2,
    connectionId,
    macName: hostName,
    hostPlatform,
    runtimeFile,
    port: gatewayPort,
    controlToken: existing?.controlToken ?? randomBytes(32).toString("hex"),
    terminalToken: existing?.terminalToken ?? randomBytes(32).toString("hex"),
    watchToken: existing?.watchToken ?? randomBytes(32).toString("hex"),
    pushDevicesFile: path.join(stateDirectory, "push-devices.json"),
    apnsConfigFile: option("--apns-config") ?? existing?.apnsConfigFile ?? defaultApnsConfigFile(hostPlatform),
    ...(logFile === undefined ? {} : { logFile }),
  };
  if (logFile !== undefined && existing === undefined) await initializeGatewayLog(logFile);
  await installExisting(stateDirectory, hostPlatform, desired, config, "enrollment");
  await execFile(tailscaleBin, ["serve", "--bg", "--yes", `127.0.0.1:${gatewayPort}`]);

  const payload = {
    version: 1,
    connectionId,
    name: hostName,
    protocolVersion: requiredString(discovery.protocolVersion, "protocolVersion"),
    controlUrl: `wss://${dnsName}/control`,
    controlToken: config.controlToken,
    terminalUrl: `wss://${dnsName}/terminal`,
    terminalToken: config.terminalToken,
  };
  const code = `TLMP1:${JSON.stringify(payload)}`;
  if (has("--quiet")) {
    // Reinstalling an existing gateway must not print its durable credentials.
  } else if (has("--print")) console.log(code);
  else {
    const copied = await copyToClipboard(code, hostPlatform);
    const qrcode = (await import("qrcode-terminal")).default;
    console.log("Scan this QR in TermLoop Mobile:");
    qrcode.generate(code, { small: true }, (qr) => console.log(qr));
    console.log(copied
      ? "The same pair code was also copied to your clipboard."
      : "No supported clipboard command was found; scan the QR instead.");
    console.log("This is a one-time pairing code; daemon restarts no longer require re-pairing.");
    console.log("On iPhone: TermLoop → Pair a computer → Scan QR.");
  }
  const label = `ai.termloop.mobile-access.${connectionId.slice(4)}`;
  console.log(`Tailnet endpoint: https://${dnsName}`);
  console.log(logFile === undefined
    ? `Gateway log: journalctl --user -u ${label}.service`
    : `Gateway log: ${logFile} (previous run: ${logFile}.previous)`);
  console.log("Keep Tailscale connected on both devices. TermLoop Mobile will reconnect automatically.");
}

async function installExisting(stateDirectory, platform, desired, nextConfig, installPolicy) {
  return await reconcileGatewayInstall({
    stateDirectory,
    desired,
    hostPlatform: platform,
    launchctlBin: option("--launchctl-bin") ?? "launchctl",
    systemctlBin: option("--systemctl-bin") ?? "systemctl",
    launchAgentDirectory: option("--launch-agent-dir"),
    serviceDirectory: option("--service-dir"),
    nodeExecutable: option("--node-executable") ?? process.execPath,
    electronRunAsNode: has("--electron-run-as-node"),
    skipGatewayWait: has("--skip-gateway-wait"),
    testPlatform: has("--test-platform"),
    nextConfig,
    installPolicy,
    forceReason: has("--force") ? option("--force-reason") ?? "explicit --force flag" : undefined,
  });
}

async function reconcileStateDirectories(platform) {
  const explicit = option("--state-dir");
  if (explicit !== undefined) return [explicit];
  const root = defaultStateRoot(platform);
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && /^mac-[a-f0-9]{16}$/.test(entry.name))
    .map((entry) => path.join(root, entry.name));
}

async function initializeGatewayLog(file) {
  try {
    await rename(file, `${file}.previous`);
    await chmod(`${file}.previous`, 0o600);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(file, "", { mode: 0o600 });
  await chmod(file, 0o600);
}

function validateDiscovery(value) {
  requiredString(value.protocolVersion, "protocolVersion");
  requiredString(value.readOnlyToken, "readOnlyToken");
  requiredString(value.terminalToken, "terminalToken");
  const control = new URL(requiredString(value.controlUrl, "controlUrl"));
  const terminal = new URL(requiredString(value.terminalUrl, "terminalUrl"));
  if (control.protocol !== "ws:" || terminal.protocol !== "ws:"
    || control.hostname !== "127.0.0.1" || terminal.hostname !== "127.0.0.1"
    || control.username || control.password || terminal.username || terminal.password
    || control.port.length === 0 || control.port !== terminal.port
    || control.pathname !== "/control" || terminal.pathname !== "/terminal"
    || control.search || terminal.search || control.hash || terminal.hash) {
    throw new Error("Daemon discovery is not the expected shared loopback WebSocket listener.");
  }
}

async function findTailscale() {
  const candidates = hostPlatform === "darwin"
    ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]
    : ["tailscale", "/usr/bin/tailscale"];
  for (const candidate of candidates) {
    try { await execFile(candidate, ["version"]); return candidate; } catch { /* Try next path. */ }
  }
  throw new Error("Tailscale CLI was not found. Install and connect Tailscale on this computer.");
}

function defaultRuntimeFile(platform) {
  if (process.env.TERMLOOP_RUNTIME_FILE) return process.env.TERMLOOP_RUNTIME_FILE;
  if (platform === "darwin") return path.join(os.homedir(), "Library/Application Support/termloop-next/runtime.json");
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
  const base = process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `termloop-next-${uid}`);
  return path.join(base, "termloop-next", "runtime.json");
}

function defaultStateRoot(platform) {
  if (platform === "darwin") return path.join(os.homedir(), "Library/Application Support/TermLoop Mobile Access");
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "termloop-next", "mobile-access");
}

function defaultStateDirectory(platform, connectionId) {
  return path.join(defaultStateRoot(platform), connectionId);
}

function defaultApnsConfigFile(platform) {
  if (platform === "darwin") return path.join(os.homedir(), "Library/Application Support/TermLoop/apns/config.json");
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "termloop-next", "apns", "config.json");
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Runtime discovery is missing ${name}.`);
  return value;
}

async function copyToClipboard(value, platform) {
  const candidates = platform === "darwin"
    ? [["pbcopy", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [command, commandArgs] of candidates) {
    if (await tryCopyToClipboard(command, commandArgs, value)) return true;
  }
  return false;
}

async function tryCopyToClipboard(command, commandArgs, value) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.end(value);
  });
}

import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import qrcode from "qrcode-terminal";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const has = (name) => args.includes(name);
const hostPlatform = option("--platform") ?? process.platform;

if (!["darwin", "linux"].includes(hostPlatform) && !has("--test-platform")) {
  throw new Error("Persistent mobile access currently requires macOS or Linux.");
}

const runtimeFile = option("--runtime") ?? defaultRuntimeFile(hostPlatform);
const tailscaleBin = option("--tailscale-bin") ?? await findTailscale();
const launchctlBin = option("--launchctl-bin") ?? "launchctl";
const systemctlBin = option("--systemctl-bin") ?? "systemctl";
const discovery = JSON.parse(await readFile(runtimeFile, "utf8"));
validateDiscovery(discovery);
const status = JSON.parse((await execFile(tailscaleBin, ["status", "--json"])).stdout);
if (status.BackendState !== "Running" || status.Self?.Online !== true) {
  throw new Error("Tailscale is not connected on this computer.");
}
const dnsName = requiredString(status.Self?.DNSName, "Tailscale DNS name").replace(/\.$/, "");
const hostName = option("--name") ?? requiredString(status.Self?.HostName, "Tailscale device name");
// Keep the established identifier prefix so existing Mac pairings stay stable.
const connectionId = `mac-${createHash("sha256").update(dnsName).digest("hex").slice(0, 16)}`;
const stateDirectory = option("--state-dir") ?? defaultStateDirectory(hostPlatform, connectionId);
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
await chmod(stateDirectory, 0o700);

const configFile = path.join(stateDirectory, "gateway.json");
const existing = await readExistingConfig(configFile);
const relayUrl = option("--relay-url")
  ?? process.env.TERMLOOP_MOBILE_RELAY_URL
  ?? existing?.relay?.url;
if (relayUrl !== undefined) validateRelayUrl(relayUrl);
const gatewayPort = Number(option("--gateway-port") ?? existing?.port ?? 46321);
if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535) {
  throw new Error("Mobile access gateway port is invalid.");
}
// launchd discards a job's output unless the plist names a file, so a failing
// gateway used to leave no trace at all. systemd already keeps this output in
// the journal, so only the macOS job needs its own file.
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
  ...(relayUrl === undefined ? {} : {
    relay: {
      url: relayUrl,
      roomId: existing?.relay?.roomId ?? randomBytes(16).toString("hex"),
      token: existing?.relay?.token ?? randomBytes(32).toString("base64url"),
      encryptionKey: existing?.relay?.encryptionKey ?? randomBytes(32).toString("base64url"),
    },
  }),
  watchToken: existing?.watchToken ?? randomBytes(32).toString("hex"),
  pushDevicesFile: path.join(stateDirectory, "push-devices.json"),
  apnsConfigFile: option("--apns-config") ?? defaultApnsConfigFile(hostPlatform),
  ...(logFile === undefined ? {} : { logFile }),
};
await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await chmod(configFile, 0o600);

const label = `ai.termloop.mobile-access.${connectionId.slice(4)}`;
const gatewaySource = path.join(path.dirname(fileURLToPath(import.meta.url)), "mobile-access-gateway.mjs");
const gatewayScript = path.join(stateDirectory, "mobile-access-gateway.mjs");
await build({
  entryPoints: [gatewaySource],
  outfile: gatewayScript,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: 'import { createRequire as __termloopCreateRequire } from "node:module"; const require = __termloopCreateRequire(import.meta.url);',
  },
  legalComments: "none",
  logLevel: "silent",
});
await chmod(gatewayScript, 0o700);
// esbuild inlines the gateway's JavaScript, but the wrist-voice transcriber is
// compiled from Swift on first use. Its source travels next to the installed
// gateway so the same relative lookup works from the repo and from the
// installed copy.
const transcriberSource = path.join(path.dirname(fileURLToPath(import.meta.url)), "transcriber", "Transcriber.swift");
const transcriberTarget = path.join(stateDirectory, "transcriber", "Transcriber.swift");
await mkdir(path.dirname(transcriberTarget), { recursive: true, mode: 0o700 });
// Rewrite only a changed source: the compiled transcriber is invalidated by the
// source mtime, and a needless rewrite pushes a ~20s recompile onto the first
// wrist request after every install.
const nextTranscriberSource = await readFile(transcriberSource, "utf8");
const currentTranscriberSource = await readFile(transcriberTarget, "utf8").catch(() => undefined);
if (currentTranscriberSource !== nextTranscriberSource) {
  await writeFile(transcriberTarget, nextTranscriberSource, { mode: 0o600 });
}
if (hostPlatform === "darwin") {
  await rotateGatewayLog(logFile);
  await installLaunchAgent({ label, launchctlBin, gatewayScript, configFile, logFile });
} else {
  await installSystemdUserService({ label, systemctlBin, gatewayScript, configFile, stateDirectory });
}
if (!has("--skip-gateway-wait")) await waitForGateway(gatewayPort);

if (config.relay === undefined || has("--keep-tailscale-serve")) {
  await execFile(tailscaleBin, ["serve", "--bg", "--yes", `127.0.0.1:${gatewayPort}`]);
} else {
  // Remove only TermLoop's root gateway mapping. `serve reset` would also erase
  // unrelated ports and the separately owned /mobile-install handler.
  await execFile(tailscaleBin, ["serve", "--https=443", "--set-path=/", "--yes", "off"]);
}

const payload = {
  version: config.relay === undefined ? 1 : 2,
  connectionId,
  name: hostName,
  protocolVersion: requiredString(discovery.protocolVersion, "protocolVersion"),
  controlUrl: `wss://${dnsName}/control`,
  controlToken: config.controlToken,
  terminalUrl: `wss://${dnsName}/terminal`,
  terminalToken: config.terminalToken,
  ...(config.relay === undefined ? {} : { relay: config.relay }),
};
const code = `TLMP1:${JSON.stringify(payload)}`;

if (has("--print")) console.log(code);
else {
  const copied = await copyToClipboard(code, hostPlatform);
  console.log("Scan this QR in TermLoop Mobile:");
  qrcode.generate(code, { small: true }, (qr) => console.log(qr));
  console.log(copied
    ? "The same pair code was also copied to your clipboard."
    : "No supported clipboard command was found; scan the QR instead.");
  console.log("This is a one-time pairing code; daemon restarts no longer require re-pairing.");
  console.log("On iPhone: TermLoop → Pair a computer → Scan QR.");
}
console.log(config.relay === undefined
  ? `Tailnet endpoint: https://${dnsName}`
  : `Relay endpoint: ${config.relay.url} (end-to-end encrypted)`);
console.log(logFile === undefined
  ? `Gateway log: journalctl --user -u ${label}.service`
  : `Gateway log: ${logFile} (previous run: ${logFile}.previous)`);
console.log(config.relay === undefined
  ? "Keep Tailscale connected on both devices. TermLoop Mobile will reconnect automatically."
  : "The Mac keeps one outbound relay connection; TermLoop Mobile will reconnect automatically.");

// The previous run's output is the only evidence of a gateway that failed while
// the phone could not reach it, so keep exactly one generation and start each
// install from an empty file instead of growing one forever.
async function rotateGatewayLog(file) {
  try {
    await rename(file, `${file}.previous`);
    await chmod(`${file}.previous`, 0o600);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  // Pre-create the file so launchd appends to an owner-only log instead of
  // creating one under its own umask.
  await writeFile(file, "", { mode: 0o600 });
  await chmod(file, 0o600);
}

async function installLaunchAgent({ label, launchctlBin: command, gatewayScript, configFile, logFile }) {
  const directory = option("--launch-agent-dir") ?? path.join(os.homedir(), "Library/LaunchAgents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${label}.plist`);
  const desired = launchAgentPlist(label, process.execPath, gatewayScript, configFile, logFile);
  const installed = await readFile(file, "utf8").catch(() => undefined);
  // launchd rejects a user LaunchAgent plist that is private to the owner. The
  // plist contains paths only; the credential-bearing config remains mode 0600.
  await writeFile(file, desired, { mode: 0o644 });
  await chmod(file, 0o644);
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
  const target = `${domain}/${label}`;
  const loaded = await launchAgentLoaded(command, target);
  // launchd keeps its own copy of a loaded job, so rewriting the plist alone
  // leaves an earlier generation running. Only an actual change is worth tearing
  // a live gateway down for; an unchanged install still just restarts.
  if (loaded && installed !== desired) await bootoutLaunchAgent(command, target);
  if (!loaded || installed !== desired) {
    await bootstrapLaunchAgent(command, domain, file, target);
  }
  await execFile(command, ["kickstart", "-k", target]);
}

async function bootoutLaunchAgent(command, target) {
  try {
    await execFile(command, ["bootout", target]);
  } catch { /* Already gone: bootstrap below re-registers the current plist. */ }
}

async function installSystemdUserService({ label, systemctlBin: command, gatewayScript, configFile, stateDirectory }) {
  const directory = option("--service-dir") ?? path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "systemd/user",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unit = `${label}.service`;
  const file = path.join(directory, unit);
  await writeFile(
    file,
    systemdUserUnit(label, process.execPath, gatewayScript, configFile, stateDirectory),
    { mode: 0o644 },
  );
  await chmod(file, 0o644);
  try {
    await execFile(command, ["--user", "daemon-reload"]);
    await execFile(command, ["--user", "enable", unit]);
    await execFile(command, ["--user", "restart", unit]);
  } catch (error) {
    throw new Error(
      `TermLoop could not start its systemd user service. Ensure a user session is running and systemctl --user works. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function launchAgentLoaded(command, target) {
  try {
    await execFile(command, ["print", target]);
    return true;
  } catch {
    return false;
  }
}

async function bootstrapLaunchAgent(command, domainName, file, target) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await execFile(command, ["bootstrap", domainName, file]);
      return;
    } catch (error) {
      // launchd may register the job even when bootstrap reports EIO. Treat the
      // observable loaded job as success instead of tearing down a live gateway.
      if (await launchAgentLoaded(command, target)) return;
      lastError = error;
      if (attempt < 2 && !has("--test-platform")) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  throw lastError;
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

async function readExistingConfig(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if ((value?.version === 1 || value?.version === 2) && Number.isInteger(value.port)
      && typeof value.controlToken === "string" && value.controlToken.length === 64
      && typeof value.terminalToken === "string" && value.terminalToken.length === 64) return value;
  } catch { /* First install or corrupt state: issue a fresh device credential. */ }
  return undefined;
}

function validateRelayUrl(value) {
  const url = new URL(value);
  const local = url.protocol === "ws:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "wss:" || local)
    || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, "") !== "/v1/relay") {
    throw new Error("Mobile relay must be a credential-free wss://.../v1/relay endpoint.");
  }
}

async function waitForGateway(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch { /* Keep waiting for LaunchAgent startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TermLoop Mobile access gateway did not become ready.");
}

function launchAgentPlist(label, node, script, config, log) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string><string>${xml(script)}</string><string>${xml(config)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

function systemdUserUnit(label, node, script, config, stateDirectory) {
  return `[Unit]
Description=TermLoop Mobile Access (${label})
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(node)} ${systemdQuote(script)} ${systemdQuote(config)}
WorkingDirectory=${systemdQuote(stateDirectory)}
Restart=always
RestartSec=2
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

function systemdQuote(value) {
  if (/[\r\n]/.test(value)) throw new Error("systemd service paths cannot contain newlines.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function findTailscale() {
  const candidates = hostPlatform === "darwin"
    // Prefer the CLI shipped by the GUI app. A Homebrew client can target a
    // different daemon generation and made installs appear healthy while Serve
    // was actually owned by the app extension.
    ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]
    : ["tailscale", "/usr/bin/tailscale"];
  for (const candidate of candidates) {
    try { await execFile(candidate, ["version"]); return candidate; } catch { /* Try next path. */ }
  }
  throw new Error("Tailscale CLI was not found. Install and connect Tailscale on this computer.");
}

function defaultRuntimeFile(platform) {
  if (process.env.TERMLOOP_RUNTIME_FILE) return process.env.TERMLOOP_RUNTIME_FILE;
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/termloop-next/runtime.json");
  }
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
  const base = process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `termloop-next-${uid}`);
  return path.join(base, "termloop-next", "runtime.json");
}

function defaultStateDirectory(platform, connectionId) {
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/TermLoop Mobile Access", connectionId);
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "termloop-next", "mobile-access", connectionId);
}

function defaultApnsConfigFile(platform) {
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/TermLoop/apns/config.json");
  }
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

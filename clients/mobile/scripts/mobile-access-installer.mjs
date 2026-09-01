import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ARTIFACT_FILE = "gateway-artifact.json";
const BUNDLE_FILE = "mobile-access-gateway.mjs";
const INSTALL_FILE = "gateway-install.json";
const PREVIOUS_BUNDLE_FILE = "mobile-access-gateway.previous.mjs";
const PREVIOUS_INSTALL_FILE = "gateway-install.previous.json";
const PREVIOUS_TRANSCRIBER_FILE = "transcriber/Transcriber.previous.swift";
const PREVIOUS_CONFIG_FILE = "gateway.previous.json";
const LOCK_FILE = ".gateway-install.lock";
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 120_000;

export const GATEWAY_COMPATIBILITY = Object.freeze({
  mobileTransport: { min: 2, max: 2 },
  mobileApi: { min: 1, max: 1 },
  configSchema: { min: 1, max: 2 },
});

export function defaultArtifactMetadata(options = {}) {
  const channel = options.channel ?? "development";
  return {
    manifestVersion: 1,
    releaseVersion: options.releaseVersion ?? "2.0.0",
    channel,
    sequence: integer(options.sequence ?? 2, "gateway sequence"),
    owner: options.owner ?? defaultInstallerOwner(channel),
    compatibility: GATEWAY_COMPATIBILITY,
  };
}

export async function buildGatewayArtifact({ scriptsDirectory, artifactDirectory, metadata }) {
  const { build } = await import("esbuild");
  const gatewaySource = path.join(scriptsDirectory, "mobile-access-gateway.mjs");
  const buildOptions = {
    entryPoints: [gatewaySource],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    metafile: true,
    banner: {
      js: 'import { createRequire as __termloopCreateRequire } from "node:module"; const require = __termloopCreateRequire(import.meta.url);',
    },
    legalComments: "none",
    logLevel: "silent",
  };
  const provisional = await build({
    ...buildOptions,
    define: { __TERMLOOP_GATEWAY_IDENTITY__: JSON.stringify({ ...metadata, buildId: "pending" }) },
  });
  const sourceGraphSha256 = hash(Buffer.concat([
    Buffer.from(`${stableJson(metadata)}\n${stableJson(provisional.metafile?.inputs ?? {})}\n`),
    Buffer.from(provisional.outputFiles[0].contents),
  ]));
  const identity = { ...metadata, buildId: `sha256:${sourceGraphSha256}` };
  const result = await build({
    ...buildOptions,
    define: { __TERMLOOP_GATEWAY_IDENTITY__: JSON.stringify(identity) },
  });
  const bundle = Buffer.from(result.outputFiles[0].contents);
  const transcriber = await readFile(path.join(scriptsDirectory, "transcriber", "Transcriber.swift"));
  const artifact = {
    ...identity,
    sourceGraphSha256,
    artifactSha256: hash(bundle),
    transcriberSha256: hash(transcriber),
    bundleFile: BUNDLE_FILE,
    transcriberFile: "transcriber/Transcriber.swift",
  };
  if (artifactDirectory !== undefined) {
    await mkdir(path.join(artifactDirectory, "transcriber"), { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(artifactDirectory, BUNDLE_FILE), bundle, 0o700);
    await atomicWrite(
      path.join(artifactDirectory, "transcriber", "Transcriber.swift"),
      transcriber,
      0o600,
    );
    await atomicWrite(path.join(artifactDirectory, ARTIFACT_FILE), jsonLine(artifact), 0o600);
  }
  return { artifact, bundle, transcriber };
}

export async function readGatewayArtifact(artifactDirectory) {
  const artifact = JSON.parse(await readFile(path.join(artifactDirectory, ARTIFACT_FILE), "utf8"));
  validateArtifact(artifact);
  const bundle = await readFile(path.join(artifactDirectory, artifact.bundleFile));
  const transcriber = await readFile(path.join(artifactDirectory, artifact.transcriberFile));
  if (hash(bundle) !== artifact.artifactSha256 || hash(transcriber) !== artifact.transcriberSha256) {
    throw new Error("Mobile access gateway artifact verification failed.");
  }
  return { artifact, bundle, transcriber };
}

export async function reconcileGatewayInstall({
  stateDirectory,
  desired,
  hostPlatform,
  launchctlBin = "launchctl",
  systemctlBin = "systemctl",
  launchAgentDirectory,
  serviceDirectory,
  nodeExecutable = process.execPath,
  electronRunAsNode = false,
  skipGatewayWait = false,
  testPlatform = false,
  nextConfig,
  installPolicy = "strict",
  forceReason,
}) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  return await withInstallLock(stateDirectory, async () => {
    const configFile = path.join(stateDirectory, "gateway.json");
    const enrolledConfig = await readGatewayConfig(configFile);
    if (enrolledConfig === undefined && nextConfig === undefined) {
      throw new Error(`No enrolled mobile access gateway exists at ${stateDirectory}.`);
    }
    const config = nextConfig ?? enrolledConfig;
    if (config === undefined || validatedGatewayConfig(config) === undefined) {
      throw new Error("Mobile access gateway config is invalid.");
    }
    const installed = await readInstallManifest(path.join(stateDirectory, INSTALL_FILE));
    const policyOverride = authorizeInstall({
      installed,
      desired: desired.artifact,
      installPolicy,
      forceReason,
    });
    const configChanged = stableJson(enrolledConfig) !== stableJson(config);

    const gatewayScript = path.join(stateDirectory, BUNDLE_FILE);
    const installedBytes = await readFile(gatewayScript).catch(() => undefined);
    const artifactChanged = installedBytes === undefined
      || hash(installedBytes) !== desired.artifact.artifactSha256
      || installed?.buildId !== desired.artifact.buildId;
    const label = `ai.termloop.mobile-access.${requiredConnectionId(config, stateDirectory).slice(4)}`;
    const logFile = hostPlatform === "darwin"
      ? config.logFile ?? path.join(stateDirectory, "gateway.log")
      : undefined;
    const service = hostPlatform === "darwin"
      ? await launchAgentPlan({
        label,
        nodeExecutable,
        electronRunAsNode,
        gatewayScript,
        configFile,
        logFile,
        directory: launchAgentDirectory,
        launchctlBin,
        testPlatform,
      })
      : await systemdPlan({
        label,
        nodeExecutable,
        gatewayScript,
        configFile,
        stateDirectory,
        electronRunAsNode,
        directory: serviceDirectory,
        systemctlBin,
      });

    if (!artifactChanged && !configChanged && !service.changed) {
      return { stateDirectory, status: "current", buildId: desired.artifact.buildId };
    }

    const installOverrides = [
      ...(Array.isArray(installed?.installOverrides) ? installed.installOverrides : []),
      ...(policyOverride === undefined ? [] : [policyOverride]),
    ].slice(-8);
    const nextInstall = {
      ...desired.artifact,
      installedAt: new Date().toISOString(),
      installerIdentity: `${desired.artifact.owner}@${desired.artifact.releaseVersion}`,
      nodeExecutable,
      ...(installOverrides.length === 0 ? {} : { installOverrides }),
    };
    if (artifactChanged) {
      await preservePrevious(stateDirectory, installedBytes, installed);
      await atomicWrite(gatewayScript, desired.bundle, 0o700);
      await installTranscriber(stateDirectory, desired);
      await atomicWrite(path.join(stateDirectory, INSTALL_FILE), jsonLine(nextInstall), 0o600);
    }
    if (configChanged) {
      await preservePreviousConfig(stateDirectory, enrolledConfig);
      await atomicWrite(configFile, jsonLine(config), 0o600);
    }

    try {
      await service.apply({ restartRequired: artifactChanged || configChanged });
      if (!skipGatewayWait) {
        let healthy = await waitForGatewayBuild(config.port, desired.artifact.buildId);
        if (!healthy) {
          await service.forceRestart();
          healthy = await waitForGatewayBuild(config.port, desired.artifact.buildId);
        }
        if (!healthy) throw new Error("Updated mobile access gateway did not report the desired build.");
      }
    } catch (error) {
      const artifactRestored = artifactChanged && await restorePrevious(stateDirectory);
      const configRestored = configChanged && await restorePreviousConfig(stateDirectory, enrolledConfig !== undefined);
      if (artifactRestored || configRestored) {
        await service.forceRestart().catch(() => {});
      }
      throw error;
    }
    return {
      stateDirectory,
      status: artifactChanged ? "updated" : configChanged ? "configUpdated" : "serviceUpdated",
      buildId: desired.artifact.buildId,
    };
  });
}

export async function readGatewayConfig(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return validatedGatewayConfig(value);
  } catch { /* Missing/corrupt state is not an enrolled gateway. */ }
  return undefined;
}

function validatedGatewayConfig(value) {
  if ((value?.version === 1 || value?.version === 2) && Number.isInteger(value.port)
    && typeof value.controlToken === "string" && value.controlToken.length === 64
    && typeof value.terminalToken === "string" && value.terminalToken.length === 64) return value;
  return undefined;
}

async function launchAgentPlan(input) {
  const directory = input.directory ?? path.join(os.homedir(), "Library/LaunchAgents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${input.label}.plist`);
  const desired = launchAgentPlist(input);
  const installed = await readFile(file, "utf8").catch(() => undefined);
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
  const target = `${domain}/${input.label}`;
  const loaded = await launchAgentLoaded(input.launchctlBin, target);
  return {
    changed: installed !== desired || !loaded,
    async apply({ restartRequired }) {
      if (installed !== desired) {
        await atomicWrite(file, desired, 0o644);
        if (loaded) await bootoutLaunchAgent(input.launchctlBin, target);
        await bootstrapLaunchAgent(input.launchctlBin, domain, file, target, input.testPlatform);
        return;
      }
      if (!loaded) {
        await bootstrapLaunchAgent(input.launchctlBin, domain, file, target, input.testPlatform);
        return;
      }
      if (restartRequired) await execFile(input.launchctlBin, ["kill", "SIGTERM", target]);
    },
    async forceRestart() {
      await execFile(input.launchctlBin, ["kickstart", "-k", target]);
    },
  };
}

async function systemdPlan(input) {
  const directory = input.directory ?? path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "systemd/user",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unit = `${input.label}.service`;
  const file = path.join(directory, unit);
  const desired = systemdUserUnit(input);
  const installed = await readFile(file, "utf8").catch(() => undefined);
  return {
    changed: installed !== desired,
    async apply({ restartRequired }) {
      if (installed !== desired) {
        await atomicWrite(file, desired, 0o644);
        await execFile(input.systemctlBin, ["--user", "daemon-reload"]);
        await execFile(input.systemctlBin, ["--user", "enable", unit]);
      }
      if (restartRequired || installed !== desired) {
        await execFile(input.systemctlBin, ["--user", "restart", unit]);
      }
    },
    async forceRestart() {
      await execFile(input.systemctlBin, ["--user", "restart", unit]);
    },
  };
}

async function preservePrevious(stateDirectory, installedBytes, installed) {
  if (installedBytes !== undefined) {
    await atomicWrite(path.join(stateDirectory, PREVIOUS_BUNDLE_FILE), installedBytes, 0o700);
  }
  if (installed !== undefined) {
    await atomicWrite(path.join(stateDirectory, PREVIOUS_INSTALL_FILE), jsonLine(installed), 0o600);
  }
  const transcriber = await readFile(path.join(stateDirectory, "transcriber", "Transcriber.swift"))
    .catch(() => undefined);
  if (transcriber !== undefined) {
    await atomicWrite(path.join(stateDirectory, PREVIOUS_TRANSCRIBER_FILE), transcriber, 0o600);
  }
}

async function restorePrevious(stateDirectory) {
  const previous = await readFile(path.join(stateDirectory, PREVIOUS_BUNDLE_FILE)).catch(() => undefined);
  if (previous === undefined) return false;
  await atomicWrite(path.join(stateDirectory, BUNDLE_FILE), previous, 0o700);
  const previousInstall = await readFile(path.join(stateDirectory, PREVIOUS_INSTALL_FILE)).catch(() => undefined);
  if (previousInstall === undefined) await unlink(path.join(stateDirectory, INSTALL_FILE)).catch(() => {});
  else await atomicWrite(path.join(stateDirectory, INSTALL_FILE), previousInstall, 0o600);
  const previousTranscriber = await readFile(path.join(stateDirectory, PREVIOUS_TRANSCRIBER_FILE))
    .catch(() => undefined);
  if (previousTranscriber !== undefined) {
    await atomicWrite(
      path.join(stateDirectory, "transcriber", "Transcriber.swift"),
      previousTranscriber,
      0o600,
    );
  }
  return true;
}

async function preservePreviousConfig(stateDirectory, config) {
  const file = path.join(stateDirectory, PREVIOUS_CONFIG_FILE);
  if (config === undefined) await unlink(file).catch(() => {});
  else await atomicWrite(file, jsonLine(config), 0o600);
}

async function restorePreviousConfig(stateDirectory, hadPrevious) {
  const configFile = path.join(stateDirectory, "gateway.json");
  if (!hadPrevious) {
    await unlink(configFile).catch(() => {});
    return true;
  }
  const previous = await readFile(path.join(stateDirectory, PREVIOUS_CONFIG_FILE)).catch(() => undefined);
  if (previous === undefined) return false;
  await atomicWrite(configFile, previous, 0o600);
  return true;
}

async function installTranscriber(stateDirectory, desired) {
  const target = path.join(stateDirectory, "transcriber", "Transcriber.swift");
  const current = await readFile(target).catch(() => undefined);
  if (current !== undefined && hash(current) === desired.artifact.transcriberSha256) return;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await atomicWrite(target, desired.transcriber, 0o600);
}

function authorizeInstall({ installed, desired, installPolicy, forceReason }) {
  if (!["strict", "enrollment", "developmentTakeover"].includes(installPolicy)) {
    throw new Error(`Unknown mobile access install policy: ${installPolicy}.`);
  }
  if (forceReason !== undefined && (typeof forceReason !== "string" || forceReason.trim().length === 0)) {
    throw new Error("A forced gateway install requires a non-empty reason.");
  }
  if (installed === undefined) return undefined;

  const channelChanged = installed.channel !== desired.channel;
  const ownerChanged = installed.owner !== desired.owner;
  const downgrade = installed.sequence > desired.sequence;
  const sameSequenceConflict = installed.sequence === desired.sequence
    && installed.buildId !== desired.buildId
    && desired.channel !== "development";
  if (forceReason === undefined) {
    if (channelChanged && installPolicy !== "enrollment") {
      throw new Error(`Refusing to replace ${installed.channel} gateway with ${desired.channel}.`);
    }
    const developmentTakeover = installPolicy === "developmentTakeover"
      && installed.channel === "development" && desired.channel === "development";
    if (ownerChanged && installPolicy !== "enrollment" && !developmentTakeover) {
      throw new Error(`Refusing to replace gateway owned by ${installed.owner} from ${desired.owner}.`);
    }
    if (downgrade) {
      throw new Error(`Refusing gateway downgrade from sequence ${installed.sequence} to ${desired.sequence}.`);
    }
    if (sameSequenceConflict && installPolicy === "strict") {
      throw new Error(`Refusing a different ${desired.channel} gateway at sequence ${desired.sequence}.`);
    }
  }

  const enrollmentOverride = installPolicy === "enrollment"
    && (channelChanged || ownerChanged || sameSequenceConflict);
  const developmentOverride = installPolicy === "developmentTakeover" && ownerChanged;
  const forcedOverride = forceReason !== undefined
    && (channelChanged || ownerChanged || downgrade || sameSequenceConflict);
  if (!enrollmentOverride && !developmentOverride && !forcedOverride) return undefined;
  return {
    at: new Date().toISOString(),
    policy: forceReason === undefined ? installPolicy : "force",
    reason: forceReason?.trim()
      ?? (installPolicy === "enrollment"
        ? "explicit enrollment"
        : "explicit development launcher takeover"),
    previousOwner: installed.owner,
    previousChannel: installed.channel,
    previousSequence: installed.sequence,
    previousBuildId: installed.buildId,
  };
}

async function readInstallManifest(file) {
  let body;
  try {
    body = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(body);
    validateArtifact(value);
    if (typeof value.installedAt !== "string" || typeof value.installerIdentity !== "string") {
      throw new Error("missing install identity");
    }
    return value;
  } catch (error) {
    throw new Error(
      `Installed mobile access manifest is corrupt; refusing automatic replacement. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateArtifact(value) {
  if (value?.manifestVersion !== 1 || typeof value.buildId !== "string"
    || typeof value.releaseVersion !== "string" || typeof value.channel !== "string"
    || typeof value.owner !== "string" || !Number.isInteger(value.sequence)
    || typeof value.artifactSha256 !== "string" || typeof value.transcriberSha256 !== "string"
    || typeof value.bundleFile !== "string" || typeof value.transcriberFile !== "string"
    || !validRanges(value.compatibility)) {
    throw new Error("Mobile access gateway artifact manifest is invalid.");
  }
}

function validRanges(value) {
  return [value?.mobileTransport, value?.mobileApi, value?.configSchema].every((range) =>
    Number.isInteger(range?.min) && Number.isInteger(range?.max) && range.min <= range.max);
}

async function waitForGatewayBuild(port, buildId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/termloop-mobile-access`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.ok && (await response.json()).buildId === buildId) return true;
    } catch { /* KeepAlive may still be replacing the old process. */ }
    await delay(100);
  }
  return false;
}

async function withInstallLock(stateDirectory, action) {
  const lockFile = path.join(stateDirectory, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle;
  while (handle === undefined) {
    try {
      handle = await open(lockFile, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await stat(lockFile).catch(() => undefined);
      if (info !== undefined && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockFile).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for gateway install lock at ${stateDirectory}.`);
      await delay(50);
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockFile).catch(() => {});
  }
}

async function atomicWrite(file, content, mode) {
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, content, { mode, flag: "wx" });
  await chmod(temporary, mode);
  await rename(temporary, file);
}

function launchAgentPlist({ label, nodeExecutable, electronRunAsNode, gatewayScript, configFile, logFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodeExecutable)}</string><string>${xml(gatewayScript)}</string><string>${xml(configFile)}</string>
  </array>
  ${electronRunAsNode ? "<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>" : ""}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>
`;
}

function systemdUserUnit({
  label,
  nodeExecutable,
  electronRunAsNode,
  gatewayScript,
  configFile,
  stateDirectory,
}) {
  return `[Unit]
Description=TermLoop Mobile Access (${label})
After=network-online.target

[Service]
Type=simple
${electronRunAsNode ? "Environment=ELECTRON_RUN_AS_NODE=1\n" : ""}ExecStart=${systemdQuote(nodeExecutable)} ${systemdQuote(gatewayScript)} ${systemdQuote(configFile)}
WorkingDirectory=${systemdQuote(stateDirectory)}
Restart=always
RestartSec=2
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

async function launchAgentLoaded(command, target) {
  try {
    await execFile(command, ["print", target]);
    return true;
  } catch {
    return false;
  }
}

async function bootoutLaunchAgent(command, target) {
  try { await execFile(command, ["bootout", target]); } catch { /* Already unloaded. */ }
}

async function bootstrapLaunchAgent(command, domain, file, target, testPlatform) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await execFile(command, ["bootstrap", domain, file]);
      return;
    } catch (error) {
      if (await launchAgentLoaded(command, target)) return;
      lastError = error;
      if (attempt < 2 && !testPlatform) await delay(300);
    }
  }
  throw lastError;
}

function requiredConnectionId(config, stateDirectory) {
  if (typeof config.connectionId === "string" && /^mac-[a-f0-9]{16}$/.test(config.connectionId)) {
    return config.connectionId;
  }
  const directoryName = path.basename(stateDirectory);
  if (/^mac-[a-f0-9]{16}$/.test(directoryName)) return directoryName;
  throw new Error("Enrolled gateway is missing its connection id; pair again to repair it.");
}

function defaultInstallerOwner(channel) {
  if (channel !== "development") return "ai.termloop.desktop";
  const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
  return `termloop.dev.${hash(Buffer.from(sourceRoot)).slice(0, 16)}`;
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonLine(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function systemdQuote(value) {
  if (/[\r\n]/.test(value)) throw new Error("systemd service paths cannot contain newlines.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

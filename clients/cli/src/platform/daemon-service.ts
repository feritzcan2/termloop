import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const SERVICE_LABEL = "dev.termloop.next.server";
const SYSTEMD_UNIT = "termloop-next.service";
const WINDOWS_TASK = "TermLoop Next Server";
const MAX_COMMAND_OUTPUT = 32 * 1024;

export type DaemonServiceAction = "install" | "start" | "stop" | "status" | "uninstall";

export type DaemonServiceResult = {
  manager: "launchd" | "systemd-user" | "task-scheduler";
  installed: boolean;
  running: boolean;
  serverBinary?: string;
  configuration?: string;
  lingerEnabled?: boolean;
  warnings?: string[];
};

export async function runDaemonService(
  action: DaemonServiceAction,
  serverBinaryInput: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DaemonServiceResult> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(`daemon service management is unsupported on ${platform}`);
  }
  const paths = daemonServicePaths(platform, os.homedir(), env);
  if (action === "install") {
    const serverBinary = await resolveServerBinary(serverBinaryInput, env, platform);
    const installWarnings = await installService(platform, paths, serverBinary, env);
    const status = await serviceStatus(platform, paths);
    const warnings = [...new Set([...(status.warnings ?? []), ...installWarnings])];
    return {
      ...status,
      serverBinary,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } else if (action === "start") {
    await startService(platform, paths);
  } else if (action === "stop") {
    await stopService(platform, paths);
  } else if (action === "uninstall") {
    await uninstallService(platform, paths);
  }
  return serviceStatus(platform, paths);
}

export function daemonServicePaths(
  platform: NodeJS.Platform,
  homeDirectory: string,
  env: NodeJS.ProcessEnv,
): { configuration?: string; logDirectory: string } {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin") {
    return {
      configuration: platformPath.join(homeDirectory, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
      logDirectory: platformPath.join(homeDirectory, "Library", "Application Support", "termloop-next", "logs"),
    };
  }
  if (platform === "linux") {
    const configRoot = env.XDG_CONFIG_HOME || platformPath.join(homeDirectory, ".config");
    const stateRoot = env.XDG_STATE_HOME || platformPath.join(homeDirectory, ".local", "state");
    return {
      configuration: platformPath.join(configRoot, "systemd", "user", SYSTEMD_UNIT),
      logDirectory: platformPath.join(stateRoot, "termloop-next", "logs"),
    };
  }
  const localAppData = env.LOCALAPPDATA || platformPath.join(homeDirectory, "AppData", "Local");
  return { logDirectory: platformPath.join(localAppData, "termloop-next", "logs") };
}

export function launchAgentDefinition(serverBinary: string, logDirectory: string, pathValue: string): string {
  const program = xmlEscape(singleLine(serverBinary));
  const stdout = xmlEscape(path.join(logDirectory, "server.log"));
  const stderr = xmlEscape(path.join(logDirectory, "server.error.log"));
  const servicePath = xmlEscape(singleLine(pathValue));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${program}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${servicePath}</string></dict>
  <key>StandardOutPath</key><string>${stdout}</string>
  <key>StandardErrorPath</key><string>${stderr}</string>
  <key>ExitTimeOut</key><integer>60</integer>
</dict>
</plist>
`;
}

export function systemdUserDefinition(serverBinary: string, pathValue: string): string {
  return `[Unit]
Description=TermLoop Next daemon
After=default.target

[Service]
Type=simple
ExecStart=${systemdQuote(singleLine(serverBinary))}
Environment="PATH=${systemdEnvironment(singleLine(pathValue))}"
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=180

[Install]
WantedBy=default.target
`;
}

export function windowsInstallScript(serverBinary: string): string {
  const executable = powershellLiteral(singleLine(serverBinary));
  const task = powershellLiteral(WINDOWS_TASK);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${executable}`,
    "$trigger = New-ScheduledTaskTrigger -AtLogOn",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    `Register-ScheduledTask -TaskName ${task} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${task}`,
  ].join("; ");
}

async function installService(
  platform: "darwin" | "linux" | "win32",
  paths: ReturnType<typeof daemonServicePaths>,
  serverBinary: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const warnings: string[] = [];
  await mkdir(paths.logDirectory, { recursive: true, mode: 0o700 });
  if (platform === "darwin") {
    const configuration = requireConfiguration(paths);
    await writePrivateFile(configuration, launchAgentDefinition(serverBinary, paths.logDirectory, env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
    const domain = launchdDomain();
    await runIgnoringFailure("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
    await runCommand("launchctl", ["bootstrap", domain, configuration]);
    await runCommand("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`]);
    return warnings;
  }
  if (platform === "linux") {
    const configuration = requireConfiguration(paths);
    await writePrivateFile(configuration, systemdUserDefinition(serverBinary, env.PATH ?? "/usr/local/bin:/usr/bin:/bin"));
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    await runCommand("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    const username = singleLine(os.userInfo().username);
    const linger = await commandResult("loginctl", ["enable-linger", username]);
    if (!linger.ok) {
      warnings.push(`Could not enable systemd user linger automatically; run \`loginctl enable-linger ${username}\` so TermLoop remains available after logout.`);
    }
    return warnings;
  }
  await runPowerShell(windowsInstallScript(serverBinary));
  return warnings;
}

async function startService(platform: "darwin" | "linux" | "win32", paths: ReturnType<typeof daemonServicePaths>): Promise<void> {
  if (platform === "darwin") {
    const configuration = requireConfiguration(paths);
    await ensureInstalled(paths);
    const domain = launchdDomain();
    const target = `${domain}/${SERVICE_LABEL}`;
    const loaded = await commandResult("launchctl", ["print", target]);
    if (!loaded.ok) await runCommand("launchctl", ["bootstrap", domain, configuration]);
    await runCommand("launchctl", ["kickstart", "-k", target]);
  } else if (platform === "linux") {
    await ensureInstalled(paths);
    await runCommand("systemctl", ["--user", "start", SYSTEMD_UNIT]);
  } else {
    await runPowerShell(`Start-ScheduledTask -TaskName ${powershellLiteral(WINDOWS_TASK)}`);
  }
}

async function stopService(platform: "darwin" | "linux" | "win32", paths: ReturnType<typeof daemonServicePaths>): Promise<void> {
  if (platform === "darwin") {
    await ensureInstalled(paths);
    const domain = launchdDomain();
    // Unload the job so KeepAlive cannot immediately replace the process that
    // an explicit stop just terminated. `start` bootstraps the retained plist.
    await runIgnoringFailure("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
  } else if (platform === "linux") {
    await ensureInstalled(paths);
    await runCommand("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
  } else {
    await runPowerShell(`Stop-ScheduledTask -TaskName ${powershellLiteral(WINDOWS_TASK)}`);
  }
}

async function uninstallService(platform: "darwin" | "linux" | "win32", paths: ReturnType<typeof daemonServicePaths>): Promise<void> {
  if (platform === "darwin") {
    const configuration = requireConfiguration(paths);
    await runIgnoringFailure("launchctl", ["bootout", `${launchdDomain()}/${SERVICE_LABEL}`]);
    await unlink(configuration).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  if (platform === "linux") {
    const configuration = requireConfiguration(paths);
    await runIgnoringFailure("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    await unlink(configuration).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  await runPowerShell([
    `$task = Get-ScheduledTask -TaskName ${powershellLiteral(WINDOWS_TASK)} -ErrorAction SilentlyContinue`,
    `if ($null -ne $task) { Unregister-ScheduledTask -TaskName ${powershellLiteral(WINDOWS_TASK)} -Confirm:$false }`,
  ].join("; "));
}

async function serviceStatus(
  platform: "darwin" | "linux" | "win32",
  paths: ReturnType<typeof daemonServicePaths>,
): Promise<DaemonServiceResult> {
  if (platform === "darwin") {
    const configuration = requireConfiguration(paths);
    const installed = await exists(configuration);
    const target = `gui/${process.getuid?.() ?? -1}/${SERVICE_LABEL}`;
    const output = installed ? await commandResult("launchctl", ["print", target]) : undefined;
    return {
      manager: "launchd",
      installed,
      running: output?.ok === true && /\bstate = running\b/.test(output.stdout),
      configuration,
    };
  }
  if (platform === "linux") {
    const configuration = requireConfiguration(paths);
    const installed = await exists(configuration);
    const output = installed ? await commandResult("systemctl", ["--user", "is-active", SYSTEMD_UNIT]) : undefined;
    const username = singleLine(os.userInfo().username);
    const linger = installed
      ? await commandResult("loginctl", ["show-user", username, "--property=Linger", "--value"])
      : undefined;
    const lingerEnabled = linger?.ok === true ? linger.stdout.trim() === "yes" : undefined;
    const warnings = installed && lingerEnabled !== true
      ? [`Systemd user linger is not confirmed; run \`loginctl enable-linger ${username}\` so TermLoop remains available after logout.`]
      : [];
    return {
      manager: "systemd-user",
      installed,
      running: output?.ok === true && output.stdout.trim() === "active",
      configuration,
      ...(lingerEnabled === undefined ? {} : { lingerEnabled }),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  const output = await commandResult("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$task = Get-ScheduledTask -TaskName ${powershellLiteral(WINDOWS_TASK)} -ErrorAction SilentlyContinue; if ($null -eq $task) { 'missing' } else { $task.State.ToString() }`,
  ]);
  const state = output?.stdout.trim().toLowerCase();
  return { manager: "task-scheduler", installed: state !== undefined && state !== "missing" && output.ok, running: state === "running" };
}

async function resolveServerBinary(input: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string> {
  const executableName = platform === "win32" ? "termloop-server.exe" : "termloop-server";
  const invokedPath = process.argv[1];
  const cliEntry = invokedPath
    ? await realpath(invokedPath).catch(() => invokedPath)
    : process.execPath;
  const candidate = input
    ?? env.TERMLOOP_SERVER_BINARY
    ?? path.join(path.dirname(cliEntry), executableName);
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(candidate));
    const metadata = await stat(resolved);
    if (!metadata.isFile()) throw new Error("not a regular file");
    if (platform !== "win32") await access(resolved, fsConstants.X_OK);
  } catch (error) {
    throw new Error(`TermLoop server binary is unavailable at ${path.resolve(candidate)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return resolved;
}

async function writePrivateFile(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, target);
    if (process.platform !== "win32") await chmod(target, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function ensureInstalled(paths: ReturnType<typeof daemonServicePaths>): Promise<void> {
  const configuration = requireConfiguration(paths);
  if (!await exists(configuration)) throw new Error("TermLoop daemon service is not installed; run `termloopctl service install` first");
}

function launchdDomain(): string {
  const userId = process.getuid?.();
  if (userId === undefined) throw new Error("cannot resolve launchd user id");
  return `gui/${userId}`;
}

function requireConfiguration(paths: ReturnType<typeof daemonServicePaths>): string {
  if (!paths.configuration) throw new Error("service configuration path is unavailable");
  return paths.configuration;
}

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch { return false; }
}

async function runPowerShell(script: string): Promise<void> {
  await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
}

async function runCommand(program: string, args: string[]): Promise<void> {
  const result = await commandResult(program, args);
  if (!result.ok) throw new Error(`${path.basename(program)} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
}

async function runIgnoringFailure(program: string, args: string[]): Promise<void> {
  await commandResult(program, args);
}

async function commandResult(program: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await executeFile(program, args, { encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT, windowsHide: true });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: String(output.stdout ?? "").slice(-MAX_COMMAND_OUTPUT), stderr: String(output.stderr ?? "").slice(-MAX_COMMAND_OUTPUT) };
  }
}

function singleLine(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new Error("service paths must be non-empty single-line values");
  return value;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function systemdEnvironment(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

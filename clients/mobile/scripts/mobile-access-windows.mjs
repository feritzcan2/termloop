import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// Pass data over stdin as JSON, never as interpolated PowerShell source. Paths can
// contain spaces, apostrophes, dollar signs, and non-ASCII account names.
export async function runWindowsPowerShell(source, input, executable = windowsPowerShell()) {
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
try {
${source}
exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  try {
    const pending = execFile(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 });
    pending.child.stdin.end(JSON.stringify(input));
    const { stdout } = await pending;
    return stdout.trim();
  } catch (error) {
    throw new Error(`Mobile Access Windows service: ${error.stderr?.trim() || `PowerShell could not complete the operation (${error.code ?? "unknown"}).`}`);
  }
}

function windowsPowerShell() {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function secureWindowsGatewayDirectory(directory, powershellBin) {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Mobile Access state cannot be a symbolic link.");
  await runWindowsPowerShell(`
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($inputData.directory, $acl)
`, { directory }, powershellBin);
}

export async function windowsTaskPlan(input) {
  const launcher = windowsGatewayLauncher(input);
  const fingerprint = createHash("sha256").update(launcher).digest("hex");
  const description = `TermLoop Mobile Access ${fingerprint}`;
  const taskInput = {
    label: input.label,
    description,
    executable: windowsPowerShell(),
    arguments: `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(launcher, "utf16le").toString("base64")}`,
    directory: input.stateDirectory,
  };
  const run = (operation) => runWindowsPowerShell(taskManager, { ...taskInput, operation }, input.powershellBin);
  const current = JSON.parse(await run("query"));
  const changed = !current.matches || !current.running;
  const restart = async () => {
    await run("stop");
    // Scheduler state can change before the job's descendants have exited.
    // Do not accept the old process's same-build health response as recovery.
    const deadline = Date.now() + 10_000;
    while (await gatewayResponds(input.port)) {
      if (Date.now() >= deadline) throw new Error("Mobile Access gateway did not stop with its background task.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await run("start");
  };
  return {
    changed,
    async apply({ restartRequired }) {
      if (!current.matches) await run("install");
      if (restartRequired || changed) await restart();
    },
    forceRestart: restart,
  };
}

async function gatewayResponds(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/.well-known/termloop-mobile-access`, { signal: AbortSignal.timeout(250) });
    return true;
  } catch { return false; }
}

function windowsGatewayLauncher({ nodeExecutable, electronRunAsNode, gatewayScript, configFile, logFile }) {
  const data = Buffer.from(JSON.stringify({ nodeExecutable, gatewayScript, configFile, logFile }), "utf8").toString("base64");
  return `$ErrorActionPreference = 'Continue'
${gatewayJob}
$gateway = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
${electronRunAsNode ? "$env:ELECTRON_RUN_AS_NODE = '1'" : "Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue"}
$stream = [System.IO.FileStream]::new($gateway.logFile, 'OpenOrCreate', 'Write', 'ReadWrite,Delete')
$writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
try {
  & $gateway.nodeExecutable $gateway.gatewayScript $gateway.configFile 2>&1 | ForEach-Object {
    $null = $stream.Seek(0, 'End')
    $writer.WriteLine($_.ToString())
  }
  $result = $LASTEXITCODE
} finally { $writer.Dispose() }
if ($null -eq $result) { exit 1 }
exit $result
`;
}

// Task Scheduler stops its action process; PowerShell's native children can
// otherwise survive it. A private, non-inherited job handle makes closing or
// killing the launcher also terminate exactly its gateway descendants.
const gatewayJob = `
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class TermLoopMobileJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  static IntPtr handle;
  public static void Attach() {
    handle = CreateJobObject(IntPtr.Zero, null);
    var limits = new Limits();
    limits.Basic.Flags = 0x2000;
    if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits)))
        || !AssignProcessToJobObject(handle, Process.GetCurrentProcess().Handle))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@ -ErrorAction Stop
try { [TermLoopMobileJob]::Attach() } catch { exit 1 }
`;

// The scheduler owns the process tree, restart policy and logon lifetime. No
// password, elevation, shell association, or detached unmanaged process is used.
const taskManager = `
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = $inputData.label + '.' + $sid
$existing = $null
try { $existing = $folder.GetTask($name) } catch {
  if ($_.Exception.HResult -ne -2147024894) { throw }
}
if ($inputData.operation -eq 'query') {
  $matches = $null -ne $existing -and $existing.Definition.RegistrationInfo.Description -eq $inputData.description
  if ($matches) {
    $action = $existing.Definition.Actions.Item(1)
    $matches = $action.Path -eq $inputData.executable -and $action.Arguments -eq $inputData.arguments -and $existing.Enabled
  }
  @{ matches = [bool]$matches; running = ($null -ne $existing -and $existing.State -eq 4) } | ConvertTo-Json -Compress
} elseif ($inputData.operation -eq 'install') {
  if ($null -ne $existing) { $existing.Stop(0) }
  $task = $scheduler.NewTask(0)
  $task.RegistrationInfo.Description = $inputData.description
  $task.Principal.UserId = $sid
  $task.Principal.LogonType = 3
  $task.Principal.RunLevel = 0
  $task.Settings.Enabled = $true
  $task.Settings.Hidden = $true
  $task.Settings.AllowDemandStart = $true
  $task.Settings.StartWhenAvailable = $true
  $task.Settings.DisallowStartIfOnBatteries = $false
  $task.Settings.StopIfGoingOnBatteries = $false
  $task.Settings.ExecutionTimeLimit = 'PT0S'
  $task.Settings.MultipleInstances = 2
  $task.Settings.RestartInterval = 'PT1M'
  $task.Settings.RestartCount = 999
  $trigger = $task.Triggers.Create(9)
  $trigger.UserId = $sid
  $action = $task.Actions.Create(0)
  $action.Path = $inputData.executable
  $action.Arguments = $inputData.arguments
  $action.WorkingDirectory = $inputData.directory
  $security = 'D:P(A;;FA;;;SY)(A;;FA;;;' + $sid + ')'
  $null = $folder.RegisterTaskDefinition($name, $task, 6, $sid, $null, 3, $security)
} elseif ($inputData.operation -eq 'stop') {
  if ($null -eq $existing) { throw 'Mobile Access background task is missing.' }
  $existing.Stop(0)
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ($folder.GetTask($name).State -eq 4) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Mobile Access background task did not stop.' }
    Start-Sleep -Milliseconds 100
  }
} elseif ($inputData.operation -eq 'start') {
  if ($null -eq $existing) { throw 'Mobile Access background task is missing.' }
  $null = $existing.Run($null)
} else { throw 'Unknown Mobile Access task operation.' }
`;

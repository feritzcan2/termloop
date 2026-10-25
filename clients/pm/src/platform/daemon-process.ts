// Privileged process and filesystem primitives for the PM daemon child. The
// supervision logic lives in `src/main/daemon-lifecycle.ts`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { PmDaemonChild, PmDaemonDeps } from "../main/daemon-lifecycle.js";

const executableName = process.platform === "win32" ? "termloop-pm-daemon.exe" : "termloop-pm-daemon";

/**
 * Finds the daemon binary: `TERMLOOP_PM_DAEMON` first, then the packaged
 * `<resources>/daemon` copy, then this checkout's Cargo debug output.
 */
export function resolveDaemonBinary(input: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  const override = process.env["TERMLOOP_PM_DAEMON"];
  if (override) return override;
  if (input.isPackaged) return path.join(input.resourcesPath, "daemon", executableName);
  const checkout = path.resolve(input.appPath, "../..");
  const targetDirectory = path.resolve(checkout, process.env["CARGO_TARGET_DIR"] ?? "target");
  return path.join(targetDirectory, "debug", executableName);
}

export function daemonBinaryExists(binary: string): boolean {
  return existsSync(binary);
}

export function createDaemonDeps(binary: string, extraEnv: Record<string, string> = {}): PmDaemonDeps {
  return {
    spawnDaemon: () => spawnDaemon(binary, extraEnv),
    readDiscovery: async (file) => JSON.parse(await readFile(file, "utf8")) as unknown,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function spawnDaemon(binary: string, extraEnv: Record<string, string>): PmDaemonChild {
  const child = spawn(binary, [], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exitListeners: ((code: number | null) => void)[] = [];
  let exited = false;
  let exitCode: number | null = null;
  const notifyExit = (code: number | null) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    for (const listener of exitListeners) listener(code);
  };
  child.once("exit", (code) => notifyExit(code));
  child.once("error", (error) => {
    console.error(`[pm-daemon] ${error.message}`);
    notifyExit(null);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[pm-daemon] ${String(chunk)}`));
  const lines = createInterface({ input: child.stdout });
  const firstLine = new Promise<string | undefined>((resolve) => {
    lines.once("line", (line) => resolve(line));
    lines.once("close", () => resolve(undefined));
    child.once("error", () => resolve(undefined));
  });
  return {
    pid: child.pid,
    firstLine,
    onExit(listener) {
      if (exited) listener(exitCode);
      else exitListeners.push(listener);
    },
    terminate: () => { if (!exited) child.kill("SIGTERM"); },
    kill: () => { if (!exited) child.kill("SIGKILL"); },
  };
}

/** Private, throwaway runtime and state directories for a smoke run. */
export async function createSmokeDirectories(): Promise<{ env: Record<string, string>; dispose(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "termloop-pm-app-smoke-"));
  return {
    env: { TERMLOOP_RUNTIME_DIR: path.join(root, "runtime"), TERMLOOP_STATE_DIR: path.join(root, "state") },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export type SpawnedDaemon = {
  pid: number | undefined;
  onExit(listener: (code: number | null) => void): void;
  terminate(): void;
};

/**
 * Resolves the bundled daemon server executable inside the packaged
 * application resources. electron-builder copies `termloop-server` and its
 * sibling `termloop-companion` into `<resources>/daemon`; the server resolves
 * the companion as a sibling executable, so both always share this directory.
 */
export function bundledDaemonServerPath(
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const binary = platform === "win32" ? "termloop-server.exe" : "termloop-server";
  return path.join(resourcesPath, "daemon", binary);
}

export async function bundledDaemonServerExists(serverPath: string): Promise<boolean> {
  try {
    await access(serverPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawns the bundled daemon as a plain child process. stdio is discarded so
 * daemon output never flows through desktop logging, and the desktop never
 * observes discovery tokens; clients keep reading runtime.json themselves.
 */
export function spawnBundledDaemon(
  serverPath: string,
  platform: NodeJS.Platform = process.platform,
): SpawnedDaemon {
  const child = spawn(serverPath, [], {
    cwd: path.dirname(serverPath),
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const listeners: Array<(code: number | null) => void> = [];
  let exited = false;
  let exitCode: number | null = null;
  const notify = (code: number | null) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    for (const listener of listeners.splice(0)) listener(code);
  };
  child.once("exit", (code) => notify(code));
  child.once("error", () => notify(null));
  return {
    pid: child.pid,
    onExit(listener) {
      if (exited) listener(exitCode);
      else listeners.push(listener);
    },
    terminate() {
      // Fallback kill for a daemon that ignored the control-plane
      // `system.shutdown` request (see BundledDaemonSupervisor.stop). SIGTERM
      // still lets a unix daemon release its instance lease and discovery
      // file; on Windows, child.kill() remains a hard TerminateProcess.
      if (platform === "win32") child.kill();
      else child.kill("SIGTERM");
    },
  };
}

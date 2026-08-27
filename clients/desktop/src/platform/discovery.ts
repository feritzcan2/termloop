import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type RuntimeDiscovery = { controlUrl: string; terminalUrl: string; token: string; terminalToken: string };

export function defaultRuntimeFile(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  home = os.homedir(),
  temporary = os.tmpdir(),
  uid = typeof process.getuid === "function" ? String(process.getuid()) : "user"
): string {
  if (env.TERMLOOP_RUNTIME_FILE) return env.TERMLOOP_RUNTIME_FILE;
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData/Local"), "termloop-next", "runtime.json");
  if (platform === "darwin") return path.join(home, "Library/Application Support/termloop-next/runtime.json");
  const base = env.XDG_RUNTIME_DIR ?? path.join(temporary, `termloop-next-${uid}`);
  return path.join(base, "termloop-next", "runtime.json");
}

export async function readDiscovery(file = defaultRuntimeFile(process.env)): Promise<RuntimeDiscovery> {
  return JSON.parse(await readFile(file, "utf8")) as RuntimeDiscovery;
}

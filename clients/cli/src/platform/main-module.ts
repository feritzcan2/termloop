import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function isMainModule(moduleUrl: string, argvEntry: string | undefined): Promise<boolean> {
  if (!argvEntry) return false;
  try {
    const [modulePath, entryPath] = await Promise.all([
      realpath(fileURLToPath(moduleUrl)),
      realpath(argvEntry),
    ]);
    return modulePath === entryPath;
  } catch {
    return moduleUrl === pathToFileURL(argvEntry).href;
  }
}

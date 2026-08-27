import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function publishDevelopmentReadyMarker(
  configuredPath: string | undefined,
  processId: number,
): Promise<void> {
  if (!configuredPath) return;
  const directory = path.dirname(configuredPath);
  const temporaryPath = `${configuredPath}.tmp.${processId}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify({ version: 1, pid: processId })}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, configuredPath);
}

export async function removeDevelopmentReadyMarker(
  configuredPath: string | undefined,
): Promise<void> {
  if (!configuredPath) return;
  await rm(configuredPath, { force: true });
}

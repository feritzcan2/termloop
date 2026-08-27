import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_CONNECTION_PROFILE_BYTES = 1024 * 1024;

export async function readConnectionProfileFile(filePath: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CONNECTION_PROFILE_BYTES) {
      throw new Error("connection profile store is not a bounded regular file");
    }
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeConnectionProfileFile(filePath: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_CONNECTION_PROFILE_BYTES) {
    throw new Error("connection profile store exceeds its durable size limit");
  }
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  if (process.platform !== "win32") await chmod(filePath, 0o600);
}

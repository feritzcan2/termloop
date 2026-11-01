import { access, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * electron-builder writes resources/app-update.yml only for installer targets
 * (nsis, dmg, zip). A `--dir` build, such as the checkout build the Windows
 * Raycast launcher opens, would otherwise ship without an update feed, and
 * every check would fail as an unreachable server. Writing the same feed lets
 * that copy offer, download, and install releases too.
 */
export default async function writeAppUpdateConfig(context) {
  const { packager, electronPlatformName, appOutDir } = context;
  // Linux updates only the AppImage, whose target writes its own config.
  if (electronPlatformName !== "win32" && electronPlatformName !== "darwin") return;
  const configPath = path.join(packager.getResourcesDir(appOutDir), "app-update.yml");
  if (await exists(configPath)) return;
  const [publish] = [packager.config.publish].flat();
  if (!publish || typeof publish !== "object") return;
  // JSON is valid YAML, so electron-updater reads this without a YAML writer.
  const config = { ...publish, updaterCacheDirName: packager.appInfo.updaterCacheDirName };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import writeAppUpdateConfig, { type AppUpdateConfigContext } from "../build/write-app-update-config.mjs";

const publish = { provider: "generic", url: "https://updates.termloop.ai/stable", channel: "latest" };
let resourcesDir: string | undefined;

async function contextFor(platform: string, publishConfig: unknown = publish): Promise<AppUpdateConfigContext> {
  resourcesDir = await mkdtemp(path.join(os.tmpdir(), "termloop-app-update-"));
  const dir = resourcesDir;
  return {
    electronPlatformName: platform,
    appOutDir: "unused",
    packager: {
      getResourcesDir: () => dir,
      config: { publish: publishConfig },
      appInfo: { updaterCacheDirName: "@termloopdesktop-updater" },
    },
  };
}

function configPath(): string {
  if (!resourcesDir) throw new Error("resources directory was not created");
  return path.join(resourcesDir, "app-update.yml");
}

afterEach(async () => {
  if (resourcesDir) await rm(resourcesDir, { recursive: true, force: true });
  resourcesDir = undefined;
});

describe("packaged app update config", () => {
  it.each(["win32", "darwin"])("gives a %s directory build the release feed", async (platform) => {
    await writeAppUpdateConfig(await contextFor(platform, [publish]));
    expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({
      ...publish,
      updaterCacheDirName: "@termloopdesktop-updater",
    });
  });

  it("keeps the config an installer target already wrote", async () => {
    const context = await contextFor("win32");
    await writeFile(configPath(), "provider: generic\npublisherName: TermLoop\n");
    await writeAppUpdateConfig(context);
    expect(await readFile(configPath(), "utf8")).toBe("provider: generic\npublisherName: TermLoop\n");
  });

  it("leaves Linux and unpublished builds without a feed", async () => {
    await writeAppUpdateConfig(await contextFor("linux"));
    await expect(readFile(configPath())).rejects.toThrow();
    await rm(resourcesDir!, { recursive: true, force: true });
    await writeAppUpdateConfig(await contextFor("win32", null));
    await expect(readFile(configPath())).rejects.toThrow();
  });

  it("runs after every electron-builder pack", async () => {
    const builderConfig = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
    expect(builderConfig).toMatch(/^afterPack: build\/write-app-update-config\.mjs$/mu);
  });
});

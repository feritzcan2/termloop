import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectLayout } from "../src/layout/model.js";
import { LayoutFileStore } from "../src/platform/layout-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("layout file store", () => {
  it("persists a versioned document and restores it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-layout-"));
    directories.push(directory);
    const file = path.join(directory, "nested", "layout.v2.json");
    const store = new LayoutFileStore(file);
    const document = {
      version: 2 as const,
      profiles: { local: {
        projects: { project: createProjectLayout("session", () => "pane") },
        sessionOrderByProject: { project: ["session", "peer"] },
        agentGroupsByProject: { project: [{ sessionIds: ["session", "peer"], name: "Review crew" }] },
      } },
    };

    await store.save(document);

    expect(await store.load()).toEqual(document);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(document);
  });

  it("fails closed to an empty document for missing or corrupt state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-layout-"));
    directories.push(directory);
    const file = path.join(directory, "layout.v2.json");
    const store = new LayoutFileStore(file);
    expect(await store.load()).toEqual({ version: 2, profiles: {} });
    await writeFile(file, "not json");
    expect(await store.load()).toEqual({ version: 2, profiles: {} });
    await expect(store.save({ version: 1, projects: { broken: {} } })).rejects.toThrow("invalidLayoutDocument");
  });

  it("migrates a v1 layout into the previously active connection without deleting the legacy file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-layout-"));
    directories.push(directory);
    const current = path.join(directory, "layout.v2.json");
    const legacy = path.join(directory, "layout.v1.json");
    const profileId = "123e4567-e89b-42d3-a456-426614174000";
    const v1 = {
      version: 1,
      projects: { project: createProjectLayout("session", () => "pane") },
      sessionOrderByProject: { project: ["session"] },
    };
    await writeFile(legacy, JSON.stringify(v1));
    const store = new LayoutFileStore(current, legacy, async () => profileId);

    const migrated = await store.load();

    expect(migrated.profiles[profileId]?.projects.project).toBeDefined();
    expect(migrated.profiles[profileId]?.sessionOrderByProject.project).toEqual(["session"]);
    expect(JSON.parse(await readFile(legacy, "utf8"))).toEqual(v1);
    expect(JSON.parse(await readFile(current, "utf8"))).toEqual(migrated);
  });
});

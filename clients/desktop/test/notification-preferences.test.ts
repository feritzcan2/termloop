import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultNotificationPreferences,
  shouldShowAgentAttentionNotification,
} from "../src/notification-preferences.js";
import { NotificationPreferencesFileStore } from "../src/platform/notification-preferences-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop notification preferences", () => {
  it("suppresses foreground notifications by default while keeping background attention visible", () => {
    expect(shouldShowAgentAttentionNotification(
      { ...defaultNotificationPreferences },
      { supported: true, appFocused: true },
    )).toBe(false);
    expect(shouldShowAgentAttentionNotification(
      { ...defaultNotificationPreferences },
      { supported: true, appFocused: false },
    )).toBe(true);
  });

  it("honors the master and foreground switches", () => {
    expect(shouldShowAgentAttentionNotification(
      { enabled: false, notifyWhenFocused: true, playSound: true },
      { supported: true, appFocused: false },
    )).toBe(false);
    expect(shouldShowAgentAttentionNotification(
      { enabled: true, notifyWhenFocused: true, playSound: false },
      { supported: true, appFocused: true },
    )).toBe(true);
  });

  it("persists a bounded versioned document and falls back safely when missing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-notification-preferences-"));
    directories.push(directory);
    const file = path.join(directory, "preferences.json");
    const store = new NotificationPreferencesFileStore(file);
    expect(await store.load()).toEqual(defaultNotificationPreferences);

    const saved = { enabled: true, notifyWhenFocused: true, playSound: false };
    expect(await store.save(saved)).toEqual(saved);
    expect(await store.load()).toEqual(saved);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, notifications: saved });
    await expect(store.save({ enabled: "yes" })).rejects.toThrow("invalidNotificationPreferences");
  });
});

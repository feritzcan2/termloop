import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultNotificationPreferences,
  notificationPreferencesOf,
  type NotificationPreferences,
} from "../notification-preferences.js";

const MAX_PREFERENCES_BYTES = 8 * 1024;

type NotificationPreferencesDocument = {
  version: 1;
  notifications: NotificationPreferences;
};

export class NotificationPreferencesFileStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<NotificationPreferences> {
    try {
      const source = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(source) > MAX_PREFERENCES_BYTES) return { ...defaultNotificationPreferences };
      const document = JSON.parse(source) as Partial<NotificationPreferencesDocument>;
      if (document.version !== 1) return { ...defaultNotificationPreferences };
      return notificationPreferencesOf(document.notifications) ?? { ...defaultNotificationPreferences };
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return { ...defaultNotificationPreferences };
      throw error;
    }
  }

  async save(value: unknown): Promise<NotificationPreferences> {
    const notifications = notificationPreferencesOf(value);
    if (!notifications) throw new Error("invalidNotificationPreferences");
    const source = `${JSON.stringify({ version: 1, notifications }, null, 2)}\n`;
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, source, { mode: 0o600 });
    if (process.platform === "win32") await rm(this.filePath, { force: true });
    await rename(temporary, this.filePath);
    return notifications;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

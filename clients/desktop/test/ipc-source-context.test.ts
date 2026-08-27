import { describe, expect, it, vi } from "vitest";

import { connectionEntityIdentity } from "../src/connection-scope.js";
import {
  currentConnectionProfileId,
  sourceAwareIpcHandle,
} from "../src/main/ipc-source-context.js";
import { connectionProfileEnvelope } from "../src/source-operations.js";

const REMOTE_PROFILE = "123e4567-e89b-42d3-a456-426614174000";

describe("source-aware IPC", () => {
  it("requires an explicit source, keeps main-process ids raw, and scopes the result", async () => {
    let invoke: ((event: unknown, ...args: unknown[]) => unknown) | undefined;
    const handle = sourceAwareIpcHandle({
      handle: vi.fn((_channel, listener) => { invoke = listener as typeof invoke; }),
    } as never);
    handle("termloop:project-delete", async (_event, projectId: string) => {
      expect(projectId).toBe("raw-project");
      expect(currentConnectionProfileId()).toBe(REMOTE_PROFILE);
      return { id: projectId, name: "Remote", folder_path: "/srv/remote" };
    });

    const result = await invoke?.({}, "raw-project", connectionProfileEnvelope(REMOTE_PROFILE)) as {
      id: string;
      connectionProfileId: string;
    };
    expect(connectionEntityIdentity(result.id)).toEqual({
      profileId: REMOTE_PROFILE,
      entityId: "raw-project",
    });
    expect(result.connectionProfileId).toBe(REMOTE_PROFILE);
  });

  it("fails closed when a source-targeted channel omits its envelope", async () => {
    let invoke: ((event: unknown, ...args: unknown[]) => unknown) | undefined;
    const handle = sourceAwareIpcHandle({
      handle: vi.fn((_channel, listener) => { invoke = listener as typeof invoke; }),
    } as never);
    handle("termloop:project-delete", async () => ({ deleted: true }));

    expect(() => invoke?.({}, "raw-project")).toThrow("connectionProfileRequired");
  });
});

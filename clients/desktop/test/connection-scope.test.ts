import { describe, expect, it } from "vitest";

import {
  connectionAttachmentIdentity,
  connectionAttachmentKey,
  connectionEntityIdentity,
  connectionEntityKey,
  decorateConnectionEntities,
  unwrapConnectionEntities,
} from "../src/connection-scope.js";

const REMOTE_PROFILE = "123e4567-e89b-42d3-a456-426614174000";

describe("connection-scoped desktop identities", () => {
  it("keeps equal daemon ids distinct and reverses positional IPC arguments", () => {
    const local = connectionEntityKey("local", "same-project");
    const remote = connectionEntityKey(REMOTE_PROFILE, "same-project");

    expect(local).not.toBe(remote);
    expect(connectionEntityIdentity(remote)).toEqual({
      profileId: REMOTE_PROFILE,
      entityId: "same-project",
    });
    expect(unwrapConnectionEntities([remote], REMOTE_PROFILE)).toEqual(["same-project"]);
  });

  it("rejects an entity from a different source before privileged IPC", () => {
    const local = connectionEntityKey("local", "project-a");
    expect(() => unwrapConnectionEntities({ projectId: local }, REMOTE_PROFILE))
      .toThrow("crossConnectionEntityDenied");
  });

  it("unwraps the Project and Routine owner used by proposal inspection", () => {
    const projectId = connectionEntityKey("local", "project-a");
    const ownerId = connectionEntityKey("local", "routine-a");
    expect(unwrapConnectionEntities({
      projectId,
      surface: "routineInstructions",
      ownerId,
    }, "local")).toEqual({
      projectId: "project-a",
      surface: "routineInstructions",
      ownerId: "routine-a",
    });
  });

  it("decorates project relations without touching provider ids", () => {
    const [project] = decorateConnectionEntities([{
      id: "project-a",
      name: "Project",
      folder_path: "/srv/project",
      providerModelId: "model-a",
    }], { connectionProfileId: REMOTE_PROFILE });

    expect(connectionEntityIdentity(project?.id ?? "")).toEqual({
      profileId: REMOTE_PROFILE,
      entityId: "project-a",
    });
    expect(project?.providerModelId).toBe("model-a");
  });

  it("keeps agent profile catalog identities provider-neutral", () => {
    const profile = {
      id: "builtin.agent-profile.test-gap-finder",
      name: "Test Gap Finder",
      description: "Find missing tests.",
      category: "Quality",
      version: 1,
      permission: "plan",
      read_only: true,
      user_invocable: true,
      agent_ids: ["claude", "codex"],
    };

    expect(decorateConnectionEntities(profile, { connectionProfileId: REMOTE_PROFILE }))
      .toEqual(profile);
  });

  it("scopes narrow invalidation id lists for source-local patch refreshes", () => {
    const payload = decorateConnectionEntities({
      topics: ["task"],
      entityScopes: [{ topic: "task", ids: ["task-a"] }],
    }, { connectionProfileId: REMOTE_PROFILE });

    const scopedTaskId = payload.entityScopes[0]?.ids[0] ?? "";
    expect(connectionEntityIdentity(scopedTaskId)).toEqual({
      profileId: REMOTE_PROFILE,
      entityId: "task-a",
    });
    expect(unwrapConnectionEntities([scopedTaskId], REMOTE_PROFILE)).toEqual(["task-a"]);
  });

  it("keeps image draft handles opaque while binding them to one source", () => {
    const handle = connectionAttachmentKey(REMOTE_PROFILE, "a72ed9e2-6914-4d83-831a-000000000001");
    expect(connectionAttachmentIdentity(handle)?.profileId).toBe(REMOTE_PROFILE);
    expect(unwrapConnectionEntities([handle], REMOTE_PROFILE)).toEqual([handle]);
  });
});

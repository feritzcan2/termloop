import { describe, expect, it } from "vitest";

import { connectionEntityKey } from "../src/connection-scope.js";
import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";
import type { Project } from "../src/renderer/model.js";
import {
  layoutPreservationProfileIds,
  ProjectionStore,
} from "../src/renderer/state/projection-store.js";

const REMOTE_PROFILE = "123e4567-e89b-42d3-a456-426614174000";

function project(profileId: string, name: string): Project {
  return {
    id: connectionEntityKey(profileId, "same-project-id"),
    name,
    folder_path: `/srv/${name}`,
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
    connectionProfileId: profileId,
  } as Project;
}

describe("multi-source projection store", () => {
  it("preserves layouts for disabled or unavailable sources but prunes connected sources", () => {
    const states = new Map([
      ["local", "connected" as const],
      [REMOTE_PROFILE, "offline" as const],
    ]);
    const disabledProfile = "123e4567-e89b-42d3-a456-426614174001";
    const profiles: ConnectionProfileSummary[] = [
      {
        id: "local",
        name: "This computer",
        transport: "local",
        scope: "local",
        endpoint: "local",
        enabled: true,
        persistence: "local",
      },
      ...[
        { id: REMOTE_PROFILE, name: "Home server", enabled: true },
        { id: disabledProfile, name: "Disabled server", enabled: false },
      ].map(({ id, name, enabled }) => ({
        id,
        name,
        transport: "tailscale" as const,
        scope: "full" as const,
        endpoint: "wss://example.ts.net",
        enabled,
        persistence: "encrypted" as const,
      })),
    ];

    expect(layoutPreservationProfileIds(profiles, (profileId) => states.get(profileId)))
      .toEqual(new Set([REMOTE_PROFILE, disabledProfile]));
  });

  it("retains an offline source's last snapshot without disturbing connected sources", () => {
    const store = new ProjectionStore();
    store.applySourceSnapshot("local", "This computer", [project("local", "Local")], [], []);
    store.applySourceSnapshot(REMOTE_PROFILE, "Home server", [project(REMOTE_PROFILE, "Remote")], [], []);

    store.setSourceConnection(REMOTE_PROFILE, "Home server", "offline", "reconnecting");

    const snapshot = store.getSnapshot();
    expect(snapshot.projects.map((value) => value.name)).toEqual(["Local", "Remote"]);
    expect(snapshot.projects.find((value) => value.name === "Remote")?.connectionState).toBe("offline");
    expect(snapshot.projects.find((value) => value.name === "Local")?.connectionState).toBe("connected");
    expect(snapshot.connection).toBe("connected");
  });

  it("keeps the desktop connected while a remote source reconnects", () => {
    const store = new ProjectionStore();
    store.applySourceSnapshot("local", "This computer", [project("local", "Local")], [], []);
    store.setSourceConnection(REMOTE_PROFILE, "Home server", "connecting");

    expect(store.getSnapshot().connection).toBe("connected");

    store.setSourceConnection(REMOTE_PROFILE, "Home server", "offline", "reconnecting");

    expect(store.getSnapshot().connection).toBe("connected");
  });

  it("removes only the disabled source", () => {
    const store = new ProjectionStore();
    store.applySourceSnapshot("local", "This computer", [project("local", "Local")], [], []);
    store.applySourceSnapshot(REMOTE_PROFILE, "Home server", [project(REMOTE_PROFILE, "Remote")], [], []);

    store.retainSources(new Set(["local"]));

    expect(store.getSnapshot().projects.map((value) => value.name)).toEqual(["Local"]);
  });
});

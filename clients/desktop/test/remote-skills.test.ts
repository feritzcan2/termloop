import { describe, expect, it } from "vitest";

import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";
import {
  portableSkillDirectoryName,
  remoteSkillComputers,
} from "../src/renderer/composition/remote-skills.js";

const profiles: ConnectionProfileSummary[] = [
  {
    id: "local",
    name: "This computer",
    transport: "local",
    scope: "local",
    endpoint: "local",
    enabled: true,
    persistence: "local",
    state: "connected",
  },
  {
    id: "studio",
    name: "Studio Mac",
    transport: "tailscale",
    scope: "full",
    endpoint: "https://studio.example",
    enabled: true,
    persistence: "encrypted",
    state: "connected",
  },
  {
    id: "build",
    name: "Build PC",
    transport: "ssh",
    scope: "readOnly",
    endpoint: "build.example:43717",
    enabled: true,
    persistence: "encrypted",
    state: "connected",
  },
  {
    id: "offline",
    name: "Offline PC",
    transport: "ssh",
    scope: "full",
    endpoint: "offline.example:43717",
    enabled: true,
    persistence: "encrypted",
    state: "offline",
  },
];

describe("remote skill computer selection", () => {
  it("offers connected remote computers while the local catalog is selected", () => {
    expect(remoteSkillComputers(profiles, "local")).toEqual([
      { profileId: "studio", name: "Studio Mac", writable: true },
      { profileId: "build", name: "Build PC", writable: false },
    ]);
  });

  it("offers this computer while a remote catalog is selected", () => {
    expect(remoteSkillComputers(profiles, "studio")).toEqual([
      { profileId: "local", name: "This computer", writable: true },
      { profileId: "build", name: "Build PC", writable: false },
    ]);
  });

  it("creates a bounded portable directory leaf", () => {
    expect(portableSkillDirectoryName(" İyi Review ", "a".repeat(64))).toBe("iyi-review");
    expect(portableSkillDirectoryName("---", "b".repeat(64))).toBe("skill-bbbbbbbb");
  });
});

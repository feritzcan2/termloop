import { describe, expect, it, vi } from "vitest";

import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";
import {
  copyRemoteSkill,
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

it("copies the complete skill package between the selected computers", async () => {
  const files = [
    { path: "SKILL.md", contentBase64: "c2tpbGw=", executable: false },
    { path: "scripts/run_local.py", contentBase64: "cnVu", executable: true },
    { path: "references/setup.md", contentBase64: "c2V0dXA=", executable: false },
    { path: "assets/config.json", contentBase64: "e30=", executable: false },
  ];
  const source = { skillPackageGet: vi.fn().mockResolvedValue({ name: "Aspire Testing", files }) };
  const result = { skills: [] };
  const target = { skillPackageCreate: vi.fn().mockResolvedValue(result) };
  expect(await copyRemoteSkill(source, target, "project", "a".repeat(64))).toBe(result);
  expect(source.skillPackageGet).toHaveBeenCalledWith({ projectId: "project", skillId: "a".repeat(64) });
  expect(target.skillPackageCreate).toHaveBeenCalledWith({ directoryName: "aspire-testing", files });
});

it("does not create an incomplete remote skill when reading its package fails", async () => {
  const source = { skillPackageGet: vi.fn().mockRejectedValue(new Error("Package too large")) };
  const target = { skillPackageCreate: vi.fn() };
  await expect(copyRemoteSkill(source, target, null, "a".repeat(64))).rejects.toThrow("Package too large");
  expect(target.skillPackageCreate).not.toHaveBeenCalled();
});

import type { ConnectionProfileSummary } from "../../connection-profile-types.js";

export function portableSkillDirectoryName(name: string, skillId: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 80)
    .replace(/[-_]+$/gu, "");
  return slug || `skill-${skillId.slice(0, 8)}`;
}

/** Every connected computer except the catalog's current source is a copy
 * target. When a remote Project is selected, this intentionally includes the
 * local computer; from that Project's perspective it is the other machine. */
export function remoteSkillComputers(
  profiles: readonly ConnectionProfileSummary[],
  selectedProfileId: string,
) {
  return profiles
    .filter((profile) => profile.id !== selectedProfileId
      && profile.enabled
      && profile.state === "connected")
    .map((profile) => ({
      profileId: profile.id,
      name: profile.name,
      writable: profile.scope !== "readOnly",
    }));
}

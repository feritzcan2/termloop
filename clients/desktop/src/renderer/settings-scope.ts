import type { ConnectionProfileSummary } from "../connection-profile-types.js";

export type SettingsScopeContext = {
  computerName: string;
  projectName?: string | undefined;
};

export function hasRemoteComputers(profiles: readonly ConnectionProfileSummary[]): boolean {
  return profiles.some((profile) => profile.transport !== "local" && profile.enabled);
}

export function computerScopeName(name: string, local: boolean): string {
  return local && name !== "This computer" ? `${name} · This computer` : name;
}

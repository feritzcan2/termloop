import type { ConnectionSourceState } from "./connection-profile-types.js";

export type ConnectionScope = {
  connectionProfileId?: string;
  connectionProfileName?: string;
  connectionState?: ConnectionSourceState;
};

export function connectionProfileIdOf(value: ConnectionScope | undefined): string {
  return value?.connectionProfileId ?? "local";
}

export function connectionEntityKey(profileId: string, entityId: string): string {
  return connectionScopedKey("tlc", profileId, entityId);
}

export function connectionEntityIdentity(value: string): { profileId: string; entityId: string } | undefined {
  return connectionScopedIdentity("tlc", value);
}

export function connectionAttachmentKey(profileId: string, attachmentId: string): string {
  return connectionScopedKey("tla", profileId, attachmentId);
}

export function connectionAttachmentIdentity(
  value: string,
): { profileId: string; entityId: string } | undefined {
  return connectionScopedIdentity("tla", value);
}

function connectionScopedKey(namespace: "tlc" | "tla", profileId: string, entityId: string): string {
  return `${namespace}:${profileId.length}:${profileId}${entityId}`;
}

function connectionScopedIdentity(
  namespace: "tlc" | "tla",
  value: string,
): { profileId: string; entityId: string } | undefined {
  if (!value.startsWith(`${namespace}:`)) return undefined;
  const lengthEnd = value.indexOf(":", 4);
  if (lengthEnd < 5) return undefined;
  const profileLength = Number(value.slice(4, lengthEnd));
  if (!Number.isSafeInteger(profileLength) || profileLength < 1 || profileLength > 64) return undefined;
  const profileStart = lengthEnd + 1;
  const profileEnd = profileStart + profileLength;
  const profileId = value.slice(profileStart, profileEnd);
  const entityId = value.slice(profileEnd);
  return profileId && entityId ? { profileId, entityId } : undefined;
}

/** Adds client-local routing metadata only to durable top-level entity DTOs. */
export function decorateConnectionEntities<T>(value: T, scope: ConnectionScope): T {
  return decorate(value, scope, undefined) as T;
}

export function unwrapConnectionEntities<T>(value: T, expectedProfileId: string): T {
  return mapIdentifiers(value, (identifier) => {
    const identity = connectionEntityIdentity(identifier);
    if (!identity) return identifier;
    if (identity.profileId !== expectedProfileId) throw new Error("crossConnectionEntityDenied");
    return identity.entityId;
  }) as T;
}

function decorate(value: unknown, scope: ConnectionScope, key: string | undefined): unknown {
  if (typeof value === "string" && key && identifierKey(key)) {
    return connectionEntityIdentity(value) || connectionAttachmentIdentity(value)
      ? value
      : connectionEntityKey(scope.connectionProfileId ?? "local", value);
  }
  if (Array.isArray(value)) return value.map((entry) => decorate(entry, scope, key));
  if (!isRecord(value)) return value;
  const nested = Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [entryKey, decorate(entry, scope, entryKey)]),
  );
  return isProject(nested) || isTask(nested) || isSession(nested) || isAgentStatus(nested)
    ? { ...nested, ...scope }
    : nested;
}

function mapIdentifiers(value: unknown, transform: (identifier: string) => string, key?: string): unknown {
  if (typeof value === "string") {
    return connectionEntityIdentity(value) || (key && identifierKey(key))
      ? transform(value)
      : value;
  }
  if (Array.isArray(value)) return value.map((entry) => mapIdentifiers(entry, transform, key));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [entryKey, mapIdentifiers(entry, transform, entryKey)]),
  );
}

const UNRELATED_IDENTIFIER_KEYS = new Set([
  "agent_id",
  "agentId",
  "targetAgentId",
  "preferredWorkerAgentId",
  "providerModelId",
  "deviceId",
  "clientLaunchId",
  "nativeSessionId",
  "connectionProfileId",
  "attachmentId",
  "attachmentIds",
]);

function identifierKey(key: string): boolean {
  if (UNRELATED_IDENTIFIER_KEYS.has(key)) return false;
  return key === "id" || key === "ids" || /(?:Id|Ids|_id|_ids)$/u.test(key);
}

function isProject(value: Record<string, unknown>): boolean {
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.folder_path === "string"
    && !("project_id" in value);
}

function isTask(value: Record<string, unknown>): boolean {
  return typeof value.id === "string"
    && typeof value.project_id === "string"
    && typeof value.title === "string"
    && (value.status === "open" || value.status === "closed");
}

function isSession(value: Record<string, unknown>): boolean {
  return typeof value.id === "string"
    && typeof value.project_id === "string"
    && (value.kind === "Terminal" || value.kind === "Agent")
    && typeof value.runtime_epoch === "number";
}

function isAgentStatus(value: Record<string, unknown>): boolean {
  return typeof value.sessionId === "string"
    && typeof value.status === "string"
    && typeof value.source === "string"
    && typeof value.observedAtEpochMs === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

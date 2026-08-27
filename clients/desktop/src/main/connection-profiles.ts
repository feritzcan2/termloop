import { app, safeStorage } from "electron";
import { createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import WebSocket from "ws";
import {
  ACCESS_PROTOCOL_IDENTITY,
  type AccessEnrolled,
  type AccessPairChallenge,
  type AccessProtocolError,
} from "@termloop/contract/current";
import type {
  ConnectionProfileConnectInput,
  ConnectionProfileConnectResult,
  ConnectionProfileSummary,
  ConnectionTransportInput,
} from "../connection-profile-types.js";
import type { AccessCredential } from "../access-auth.js";
import {
  readConnectionProfileFile,
  writeConnectionProfileFile,
} from "../platform/connection-profile-storage.js";
import { localDeviceName } from "../platform/device-name.js";
import { secureCredentialStorageAvailable } from "../platform/secure-storage.js";
import { accessEndpoint, tailscaleAccessBaseUrl } from "./transports/tailscale.js";
import { SshTransportManager } from "./transports/ssh.js";

const PROFILE_FILE = "connection-profiles.v1.json";
const MAX_CONNECTION_PROFILES = 100;
export const MAX_ENABLED_CONNECTION_SOURCES = 8;
const MAX_ENROLLMENT_MESSAGE_BYTES = 16 * 1024;
const SESSION_ONLY_WARNING = "Secure credential storage is unavailable; this profile exists only until TermLoop closes.";
const ENCRYPTED_PROFILE_UNAVAILABLE_WARNING = "Secure credential storage is unavailable; this saved profile cannot connect in the current session.";

type StoredProfile = {
  id: string;
  name: string;
  transport: ConnectionTransportInput;
  deviceId: string;
  scope: "full" | "readOnly";
  serverFingerprint: string;
  encryptedPrivateKey: string;
};

type StoredProfileFile = {
  version: 2;
  enabledProfileIds: string[];
  profiles: StoredProfile[];
};

type LegacyStoredProfileFile = {
  version: 1;
  activeProfileId: string | null;
  profiles: StoredProfile[];
};

type SessionProfile = Omit<StoredProfile, "encryptedPrivateKey"> & {
  privateKey: JsonWebKey;
};

export type LocalConnectionConfig = {
  kind: "local";
  controlUrl: string;
  token: string;
  terminalUrl: string;
  terminalToken: string;
};

export type RemoteConnectionConfig = {
  kind: "remote";
  profileId: string;
  controlUrl: string;
  terminalUrl: string;
  token: string;
  terminalToken: string;
  credential: AccessCredential;
};

export type DesktopConnectionConfig = LocalConnectionConfig | RemoteConnectionConfig;

export class ConnectionProfileStore {
  readonly #filePath: string;
  readonly #deviceName: string;
  readonly #ssh = new SshTransportManager();
  #loadPromise: Promise<void> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  #stored: StoredProfileFile = { version: 2, enabledProfileIds: [], profiles: [] };
  #sessionProfiles = new Map<string, SessionProfile>();
  #enabledSessionProfileIds = new Set<string>();
  #loadWarning: string | undefined;
  #layoutMigrationProfileId = "local";

  constructor(
    filePath = path.join(app.getPath("userData"), PROFILE_FILE),
    deviceName = localDeviceName(),
  ) {
    this.#filePath = filePath;
    this.#deviceName = deviceName;
  }

  async list(): Promise<ConnectionProfileSummary[]> {
    await this.#mutationTail;
    await this.#load();
    return this.#summaries();
  }

  #summaries(): ConnectionProfileSummary[] {
    const encryptedProfilesAvailable = secureStorageAvailable();
    return [
      {
        id: "local",
        name: "This computer",
        transport: "local",
        scope: "local",
        endpoint: "Bundled or locally discovered daemon",
        enabled: true,
        persistence: "local",
        ...(this.#loadWarning ? { warning: this.#loadWarning } : {}),
      },
      ...this.#stored.profiles.map((profile) => ({
        ...summary(profile, this.#stored.enabledProfileIds.includes(profile.id), "encrypted"),
        ...(!encryptedProfilesAvailable ? { warning: ENCRYPTED_PROFILE_UNAVAILABLE_WARNING } : {}),
      })),
      ...[...this.#sessionProfiles.values()].map((profile) => ({
        ...summary(profile, this.#enabledSessionProfileIds.has(profile.id), "sessionOnly"),
        warning: SESSION_ONLY_WARNING,
      })),
    ];
  }

  async connect(input: ConnectionProfileConnectInput): Promise<ConnectionProfileConnectResult> {
    return this.#serializeMutation(() => this.#connect(input));
  }

  async #connect(input: ConnectionProfileConnectInput): Promise<ConnectionProfileConnectResult> {
    await this.#load();
    validateConnectInput(input);
    if (this.#stored.profiles.length + this.#sessionProfiles.size >= MAX_CONNECTION_PROFILES) {
      throw new Error("connection profile limit reached");
    }
    this.#assertCanEnable("new-profile");
    const temporaryId = `connect-${randomUUID()}`;
    const baseUrl = await this.#transportBaseUrl(temporaryId, input.transport);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" });
    const privateKey = keys.privateKey.export({ format: "jwk" });
    if (!publicKey.x) throw new Error("generated device public key is unavailable");
    let enrolled: AccessEnrolled;
    try {
      enrolled = await enrollDevice(
        accessEndpoint(baseUrl, "enroll"),
        this.#deviceName,
        publicKey.x,
        input.expectedServerFingerprint,
      );
    } finally {
      this.#ssh.remove(temporaryId);
    }
    const id = randomUUID();
    const base = {
      id,
      name: input.name.trim(),
      transport: normalizedTransport(input.transport),
      deviceId: enrolled.deviceId,
      scope: enrolled.scope,
      serverFingerprint: enrolled.serverFingerprint,
    };
    let warning: string | undefined;
    if (secureStorageAvailable()) {
      const profile: StoredProfile = {
        ...base,
        encryptedPrivateKey: safeStorage.encryptString(JSON.stringify(privateKey)).toString("base64"),
      };
      const nextStored: StoredProfileFile = {
        ...this.#stored,
        enabledProfileIds: [...this.#stored.enabledProfileIds, id],
        profiles: [...this.#stored.profiles, profile],
      };
      await this.#persist(nextStored);
      this.#stored = nextStored;
    } else {
      this.#sessionProfiles.set(id, { ...base, privateKey });
      this.#enabledSessionProfileIds.add(id);
      warning = SESSION_ONLY_WARNING;
    }
    const profile = this.#summaries().find((candidate) => candidate.id === id);
    if (!profile) throw new Error("connected profile was not retained");
    return { profile, ...(warning ? { warning } : {}) };
  }

  async setEnabled(profileId: string, enabled: boolean): Promise<void> {
    return this.#serializeMutation(() => this.#setEnabled(profileId, enabled));
  }

  async #setEnabled(profileId: string, enabled: boolean): Promise<void> {
    await this.#load();
    if (profileId === "local") {
      if (!enabled) throw new Error("This computer cannot be disabled");
      return;
    }
    if (this.#sessionProfiles.has(profileId)) {
      if (enabled) {
        this.#assertCanEnable(profileId);
        this.#enabledSessionProfileIds.add(profileId);
      } else {
        this.#enabledSessionProfileIds.delete(profileId);
        this.#ssh.remove(profileId);
      }
      return;
    }
    if (!this.#stored.profiles.some((profile) => profile.id === profileId)) {
      throw new Error("connection profile was not found");
    }
    if (enabled) this.#assertCanEnable(profileId);
    const enabledProfileIds = enabled
      ? [...new Set([...this.#stored.enabledProfileIds, profileId])]
      : this.#stored.enabledProfileIds.filter((id) => id !== profileId);
    const nextStored = { ...this.#stored, enabledProfileIds };
    await this.#persist(nextStored);
    this.#stored = nextStored;
    if (!enabled) this.#ssh.remove(profileId);
  }

  async remove(profileId: string): Promise<void> {
    return this.#serializeMutation(() => this.#remove(profileId));
  }

  async #remove(profileId: string): Promise<void> {
    await this.#load();
    if (this.#sessionProfiles.delete(profileId)) {
      this.#ssh.remove(profileId);
      this.#enabledSessionProfileIds.delete(profileId);
      return;
    }
    const profiles = this.#stored.profiles.filter((profile) => profile.id !== profileId);
    if (profiles.length === this.#stored.profiles.length) throw new Error("connection profile was not found");
    const nextStored: StoredProfileFile = {
      ...this.#stored,
      profiles,
      enabledProfileIds: this.#stored.enabledProfileIds.filter((id) => id !== profileId),
    };
    await this.#persist(nextStored);
    this.#stored = nextStored;
    this.#ssh.remove(profileId);
  }

  async remoteConfig(profileId: string): Promise<RemoteConnectionConfig> {
    await this.#mutationTail;
    await this.#load();
    if (!this.#isEnabled(profileId)) throw new Error("connection profile is disabled");
    const session = this.#sessionProfiles.get(profileId);
    const stored = this.#stored.profiles.find((profile) => profile.id === profileId);
    if (!session && !stored) throw new Error("connection profile was not found");
    const profile = session ?? stored!;
    const privateKey = session?.privateKey ?? decryptPrivateKey(stored!.encryptedPrivateKey);
    const baseUrl = await this.#transportBaseUrl(profile.id, profile.transport);
    const placeholder = "0".repeat(64);
    return {
      kind: "remote",
      profileId: profile.id,
      controlUrl: accessEndpoint(baseUrl, "control"),
      terminalUrl: accessEndpoint(baseUrl, "terminal"),
      token: placeholder,
      terminalToken: placeholder,
      credential: {
        deviceId: profile.deviceId,
        privateKey,
        serverFingerprint: profile.serverFingerprint,
      },
    };
  }

  async enabledSourceIds(): Promise<string[]> {
    await this.#mutationTail;
    await this.#load();
    return ["local", ...this.#stored.enabledProfileIds, ...this.#enabledSessionProfileIds];
  }

  async layoutMigrationProfileId(): Promise<string> {
    await this.#mutationTail;
    await this.#load();
    return this.#layoutMigrationProfileId;
  }

  stop(): void {
    this.#ssh.stop();
  }

  #isEnabled(profileId: string): boolean {
    return this.#stored.enabledProfileIds.includes(profileId)
      || this.#enabledSessionProfileIds.has(profileId);
  }

  #assertCanEnable(profileId: string): void {
    if (profileId !== "new-profile" && this.#isEnabled(profileId)) return;
    const remoteCount = this.#stored.enabledProfileIds.length + this.#enabledSessionProfileIds.size;
    if (remoteCount >= MAX_ENABLED_CONNECTION_SOURCES - 1) {
      throw new Error(`At most ${MAX_ENABLED_CONNECTION_SOURCES} computers can be enabled at once`);
    }
  }

  async #transportBaseUrl(profileId: string, transport: ConnectionTransportInput): Promise<string> {
    if (transport.kind === "tailscale") return tailscaleAccessBaseUrl(transport.baseUrl);
    return this.#ssh.baseUrl(profileId, {
      host: transport.host,
      ...(transport.user ? { user: transport.user } : {}),
      remotePort: transport.remotePort,
    });
  }

  async #load(): Promise<void> {
    this.#loadPromise ??= this.#loadOnce();
    return this.#loadPromise;
  }

  async #loadOnce(): Promise<void> {
    let source: string | undefined;
    try {
      source = await readConnectionProfileFile(this.#filePath);
    } catch {
      this.#loadWarning = "Saved server profiles are unreadable and were ignored. Connecting a new server will replace them.";
      return;
    }
    if (!source) return;
    try {
      const parsed: unknown = JSON.parse(source);
      if (validLegacyStoredProfileFile(parsed)) {
        this.#layoutMigrationProfileId = parsed.activeProfileId ?? "local";
        const migrated: StoredProfileFile = {
          version: 2,
          enabledProfileIds: parsed.activeProfileId ? [parsed.activeProfileId] : [],
          profiles: parsed.profiles,
        };
        await this.#persist(migrated);
        this.#stored = migrated;
      } else {
        if (!validStoredProfileFile(parsed)) throw new Error("invalid shape");
        this.#stored = parsed;
        this.#layoutMigrationProfileId = parsed.enabledProfileIds.length === 1
          ? parsed.enabledProfileIds[0] ?? "local"
          : "local";
      }
    } catch {
      this.#loadWarning = "Saved server profiles are invalid and were ignored. Connecting a new server will replace them.";
    }
  }

  async #persist(next: StoredProfileFile): Promise<void> {
    await writeConnectionProfileFile(this.#filePath, JSON.stringify(next, null, 2));
    this.#loadWarning = undefined;
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

let sharedProfileStore: ConnectionProfileStore | undefined;

export function connectionProfiles(): ConnectionProfileStore {
  sharedProfileStore ??= new ConnectionProfileStore();
  return sharedProfileStore;
}

async function enrollDevice(
  url: string,
  deviceName: string,
  publicKey: string,
  expectedServerFingerprint: string | undefined,
): Promise<AccessEnrolled> {
  const socket = new WebSocket(url, { maxPayload: MAX_ENROLLMENT_MESSAGE_BYTES });
  try {
    // Attach the message listener before open so an eager server challenge
    // cannot be missed. Promise.all also observes both rejection paths when a
    // socket fails before opening, avoiding an orphaned response rejection.
    const [, challengeValue] = await Promise.all([
      socketEvent(socket, "open", 10_000),
      socketJson(socket, 10_000),
    ]);
    const challenge = challengeValue as AccessPairChallenge | AccessProtocolError;
    if (challenge.kind === "error") throw new Error(challenge.message);
    if (challenge.kind !== "pairChallenge"
      || challenge.protocolVersion !== ACCESS_PROTOCOL_IDENTITY
      || !/^sha256:[0-9a-f]{64}$/.test(challenge.serverFingerprint)) {
      throw new Error("TermLoop enrollment challenge is invalid");
    }
    if (expectedServerFingerprint && challenge.serverFingerprint !== expectedServerFingerprint) {
      throw new Error("Server fingerprint changed since discovery");
    }
    const exchange = JSON.stringify({
      kind: "enroll",
      protocolVersion: ACCESS_PROTOCOL_IDENTITY,
      deviceName,
      publicKey,
      serverFingerprint: challenge.serverFingerprint,
    });
    const responsePromise = socketJson(socket, 10_000);
    socket.send(exchange);
    const response = await responsePromise as AccessEnrolled | AccessProtocolError;
    if (response.kind === "error") throw new Error(response.message);
    if (response.kind !== "enrolled"
      || response.protocolVersion !== ACCESS_PROTOCOL_IDENTITY
      || response.serverFingerprint !== challenge.serverFingerprint) {
      throw new Error("device enrollment response is invalid");
    }
    return response;
  } finally {
    closeEnrollmentSocket(socket);
  }
}

function secureStorageAvailable(): boolean {
  return secureCredentialStorageAvailable(safeStorage);
}

function decryptPrivateKey(encrypted: string): JsonWebKey {
  if (!secureStorageAvailable()) throw new Error("secure credential storage is unavailable");
  const source = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || !("d" in parsed) || typeof parsed.d !== "string") {
    throw new Error("stored device credential is invalid");
  }
  // Prove Electron can reconstruct the key before returning it to the socket adapter.
  createPrivateKey({ key: parsed as JsonWebKey, format: "jwk" });
  return parsed as JsonWebKey;
}

function summary(
  profile: Omit<StoredProfile, "encryptedPrivateKey">,
  enabled: boolean,
  persistence: "encrypted" | "sessionOnly",
): ConnectionProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    transport: profile.transport.kind,
    scope: profile.scope,
    endpoint: profile.transport.kind === "tailscale"
      ? profile.transport.baseUrl
      : `${profile.transport.user ? `${profile.transport.user}@` : ""}${profile.transport.host}:${profile.transport.remotePort}`,
    enabled,
    persistence,
  };
}

function normalizedTransport(transport: ConnectionTransportInput): ConnectionTransportInput {
  if (transport.kind === "tailscale") {
    return { kind: "tailscale", baseUrl: tailscaleAccessBaseUrl(transport.baseUrl) };
  }
  const host = transport.host.trim();
  const user = transport.user?.trim();
  if (host.length > 255 || !/^(?:[A-Za-z0-9][A-Za-z0-9._:-]*|\[[0-9A-Fa-f:]+\])$/.test(host)) {
    throw new Error("SSH host contains unsupported characters");
  }
  if (user && (user.length > 255 || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(user))) {
    throw new Error("SSH user contains unsupported characters");
  }
  if (!Number.isSafeInteger(transport.remotePort) || transport.remotePort < 1024 || transport.remotePort > 65535) {
    throw new Error("SSH remote port must be between 1024 and 65535");
  }
  return { kind: "ssh", host, ...(user ? { user } : {}), remotePort: transport.remotePort };
}

function validateConnectInput(input: ConnectionProfileConnectInput): void {
  if (!input.name.trim() || input.name.trim().length > 80) throw new Error("Profile name must be between 1 and 80 characters");
  if (input.expectedServerFingerprint && !/^sha256:[0-9a-f]{64}$/.test(input.expectedServerFingerprint)) {
    throw new Error("Server fingerprint is invalid");
  }
  normalizedTransport(input.transport);
}

function validStoredProfileFile(value: unknown): value is StoredProfileFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredProfileFile>;
  if (candidate.version !== 2
    || !Array.isArray(candidate.enabledProfileIds)
    || candidate.enabledProfileIds.length > MAX_ENABLED_CONNECTION_SOURCES - 1
    || !candidate.enabledProfileIds.every(validProfileId)
    || new Set(candidate.enabledProfileIds).size !== candidate.enabledProfileIds.length
    || !Array.isArray(candidate.profiles)
    || candidate.profiles.length > MAX_CONNECTION_PROFILES) {
    return false;
  }
  const profileIds = new Set<string>();
  try {
    for (const profile of candidate.profiles) {
      if (!validStoredProfile(profile) || profileIds.has(profile.id)) {
        return false;
      }
      profileIds.add(profile.id);
    }
  } catch {
    return false;
  }
  return candidate.enabledProfileIds.every((profileId) => profileIds.has(profileId));
}

function validLegacyStoredProfileFile(value: unknown): value is LegacyStoredProfileFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyStoredProfileFile>;
  if (candidate.version !== 1
    || (candidate.activeProfileId !== null && !validProfileId(candidate.activeProfileId))
    || !Array.isArray(candidate.profiles)
    || candidate.profiles.length > MAX_CONNECTION_PROFILES) {
    return false;
  }
  const profileIds = new Set<string>();
  try {
    for (const profile of candidate.profiles) {
      if (!validStoredProfile(profile) || profileIds.has(profile.id)) return false;
      profileIds.add(profile.id);
    }
  } catch {
    return false;
  }
  return candidate.activeProfileId === null || profileIds.has(candidate.activeProfileId);
}

function validStoredProfile(value: unknown): value is StoredProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<StoredProfile>;
  if (!validProfileId(profile.id)
    || typeof profile.name !== "string"
    || profile.name !== profile.name.trim()
    || profile.name.length === 0
    || profile.name.length > 80
    || !/^[0-9a-f]{32}$/.test(profile.deviceId ?? "")
    || (profile.scope !== "full" && profile.scope !== "readOnly")
    || !/^sha256:[0-9a-f]{64}$/.test(profile.serverFingerprint ?? "")
    || typeof profile.encryptedPrivateKey !== "string"
    || profile.encryptedPrivateKey.length === 0
    || profile.encryptedPrivateKey.length > 16_384
    || !profile.transport) {
    return false;
  }
  normalizedTransport(profile.transport);
  return true;
}

function validProfileId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function socketEvent(socket: WebSocket, event: "open", timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Could not reach the TermLoop server before the connection timed out"));
    }, timeoutMs);
    const opened = () => { cleanup(); resolve(); };
    const failed = () => {
      cleanup();
      reject(new Error("Could not reach the TermLoop server. Check the server address and network connection."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, opened);
      socket.off("error", failed);
      socket.off("close", failed);
    };
    socket.once(event, opened);
    socket.once("error", failed);
    socket.once("close", failed);
  });
}

function socketJson(socket: WebSocket, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("server response timed out")); }, timeoutMs);
    const received = (raw: WebSocket.RawData, binary: boolean) => {
      cleanup();
      if (binary) { reject(new Error("server response is invalid")); return; }
      try { resolve(JSON.parse(String(raw))); } catch { reject(new Error("server response is invalid")); }
    };
    const failed = () => {
      cleanup();
      reject(new Error("The TermLoop server ended the enrollment connection"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", received);
      socket.off("error", failed);
      socket.off("close", failed);
    };
    socket.once("message", received);
    socket.once("error", failed);
    socket.once("close", failed);
  });
}

function closeEnrollmentSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) {
      // ws reports an abort as an `error`. Retain a listener while terminating
      // so cleanup itself can never become an uncaught EventEmitter error.
      socket.once("error", () => undefined);
      socket.terminate();
    }
  } catch {
    // Connection cleanup must never replace the actionable enrollment failure.
  }
}

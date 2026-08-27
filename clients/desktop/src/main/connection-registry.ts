import {
  TermLoopControlError,
  TermLoopControlClient,
  type CallArgs,
  type Method,
  type ProjectionInvalidatedPayload,
  type ResultFor,
} from "@termloop/contract/current";

import type {
  ConnectionProfileSummary,
  ConnectionSourceState,
  ConnectionSourceSummary,
} from "../connection-profile-types.js";
import { decorateConnectionEntities } from "../connection-scope.js";
import { readDiscovery } from "../platform/discovery.js";
import { createControlSocket } from "./access-websocket.js";
import {
  connectionProfiles,
  type DesktopConnectionConfig,
  type LocalConnectionConfig,
} from "./connection-profiles.js";
import { ControlSubscription } from "./control-subscription.js";

export const LOCAL_CONNECTION_PROFILE_ID = "local";

type RegistryEntry = {
  summary: ConnectionProfileSummary;
  state: ConnectionSourceState;
  message?: string;
  client?: RegistryControlClient;
  clientIdentity?: string;
  subscription: ControlSubscription;
};

type RegistryControlClient = Pick<TermLoopControlClient, "call" | "close">;
type RegistryControlClientFactory = (config: DesktopConnectionConfig) => RegistryControlClient;

export type ConnectionRegistryEvents = {
  invalidated(profileId: string, payload: ProjectionInvalidatedPayload): void;
  statusChanged(summary: ConnectionSourceSummary): void;
  localSubscriptionConnected?(): Promise<void>;
};

/**
 * Owns every simultaneously enabled desktop connection. Credentials and raw
 * connection tokens stay behind this main-process boundary; renderers receive
 * only profile ids and secret-free summaries.
 */
export class ConnectionRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  #syncTail: Promise<void> = Promise.resolve();
  #started = false;

  constructor(
    readonly events: ConnectionRegistryEvents,
    readonly profiles = connectionProfiles(),
    readonly createClient: RegistryControlClientFactory = defaultControlClient,
  ) {}

  async start(): Promise<void> {
    this.#started = true;
    await this.sync();
    for (const entry of this.#entries.values()) entry.subscription.start();
  }

  async sync(): Promise<void> {
    const operation = this.#syncTail.then(() => this.#syncOnce());
    this.#syncTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async summaries(): Promise<ConnectionProfileSummary[]> {
    await this.sync();
    return (await this.profiles.list()).map((summary) => {
      const entry = this.#entries.get(summary.id);
      return entry ? sourceSummary(entry) : summary;
    });
  }

  async enabledProfileIds(): Promise<string[]> {
    await this.sync();
    return [...this.#entries.keys()];
  }

  async connectionConfig(profileId: string): Promise<DesktopConnectionConfig | undefined> {
    await this.sync();
    if (!this.#entries.has(profileId)) throw new Error("unknownConnectionProfile");
    return this.#connectionConfig(profileId);
  }

  async call<M extends Method>(
    profileId: string,
    method: M,
    ...args: CallArgs<M>
  ): Promise<ResultFor<M>> {
    const entry = await this.#entry(profileId);
    let config: DesktopConnectionConfig | undefined;
    try {
      config = await this.#connectionConfig(profileId);
      if (!config) throw new Error("daemonUnavailable");
      const result = await this.#client(entry, config).call(method, ...args);
      this.#setState(profileId, "connected");
      return result;
    } catch (error) {
      if (error instanceof TermLoopControlError) this.#setState(profileId, "connected");
      else if (entry.state !== "connected") {
        this.#setState(profileId, "offline", error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  setSelectedProjectDemand(profileId: string, projectId: string): void {
    if (!this.#entries.has(profileId)) throw new Error("unknownConnectionProfile");
    for (const [candidateId, entry] of this.#entries) {
      entry.subscription.setProjectIds(candidateId === profileId ? [projectId] : []);
    }
  }

  async reconnect(profileId: string): Promise<void> {
    const entry = await this.#entry(profileId);
    entry.client?.close();
    delete entry.client;
    delete entry.clientIdentity;
    entry.subscription.reconnect();
  }

  stopProfile(profileId: string): void {
    const entry = this.#entries.get(profileId);
    if (!entry) return;
    entry.subscription.stop();
    entry.client?.close();
    this.#entries.delete(profileId);
  }

  stopAll(): void {
    this.#started = false;
    for (const profileId of [...this.#entries.keys()]) this.stopProfile(profileId);
  }

  async probeLocal(): Promise<boolean> {
    try {
      const config = await localConnectionConfig();
      if (!config) return false;
      const client = new TermLoopControlClient(
        config.controlUrl,
        config.token,
        () => createControlSocket(config) as never,
      );
      try {
        await client.ping();
        return true;
      } finally {
        client.close();
      }
    } catch {
      return false;
    }
  }

  async requestLocalShutdown(): Promise<boolean> {
    const config = await localConnectionConfig();
    if (!config) return false;
    const client = new TermLoopControlClient(
      config.controlUrl,
      config.token,
      () => createControlSocket(config) as never,
    );
    try {
      return (await client.call("system.shutdown")).accepted;
    } finally {
      client.close();
    }
  }

  async #syncOnce(): Promise<void> {
    const summaries = await this.profiles.list();
    const enabled = new Set(summaries.filter((summary) => summary.enabled).map((summary) => summary.id));
    for (const profileId of [...this.#entries.keys()]) {
      if (!enabled.has(profileId)) this.stopProfile(profileId);
    }
    for (const summary of summaries) {
      if (!summary.enabled) continue;
      const existing = this.#entries.get(summary.id);
      if (existing) {
        existing.summary = summary;
        continue;
      }
      const profileId = summary.id;
      const subscription = new ControlSubscription(
        (payload) => this.events.invalidated(profileId, decorateConnectionEntities(payload, {
          connectionProfileId: profileId,
          connectionProfileName: summary.name,
          connectionState: "connected",
        })),
        profileId === LOCAL_CONNECTION_PROFILE_ID
          ? this.events.localSubscriptionConnected
          : undefined,
        () => this.connectionConfig(profileId),
        (state, message) => this.#setState(profileId, state, message),
      );
      const entry: RegistryEntry = { summary, state: "connecting", subscription };
      this.#entries.set(profileId, entry);
      if (this.#started) subscription.start();
      this.events.statusChanged(sourceSummary(entry));
    }
  }

  async #entry(profileId: string): Promise<RegistryEntry> {
    await this.sync();
    const entry = this.#entries.get(profileId);
    if (!entry) throw new Error("unknownConnectionProfile");
    return entry;
  }

  async #connectionConfig(profileId: string): Promise<DesktopConnectionConfig | undefined> {
    if (profileId === LOCAL_CONNECTION_PROFILE_ID) return localConnectionConfig();
    return this.profiles.remoteConfig(profileId);
  }

  #client(entry: RegistryEntry, config: DesktopConnectionConfig): RegistryControlClient {
    const identity = config.kind === "remote"
      ? `remote:${config.profileId}:${config.controlUrl}`
      : `local:${config.controlUrl}:${config.token}`;
    if (entry.client && entry.clientIdentity === identity) return entry.client;
    entry.client?.close();
    entry.client = this.createClient(config);
    entry.clientIdentity = identity;
    return entry.client;
  }

  #setState(profileId: string, state: ConnectionSourceState, message?: string): void {
    const entry = this.#entries.get(profileId);
    if (!entry) return;
    const changed = entry.state !== state || entry.message !== message;
    entry.state = state;
    if (message === undefined) delete entry.message;
    else entry.message = message;
    if (changed) this.events.statusChanged(sourceSummary(entry));
  }
}

function defaultControlClient(config: DesktopConnectionConfig): TermLoopControlClient {
  return new TermLoopControlClient(
    config.controlUrl,
    config.token,
    () => createControlSocket(config) as never,
  );
}

export async function localConnectionConfig(): Promise<LocalConnectionConfig | undefined> {
  const controlUrl = process.env.TERMLOOP_CONTROL_URL;
  const token = process.env.TERMLOOP_TOKEN;
  const terminalUrl = process.env.TERMLOOP_TERMINAL_URL;
  const terminalToken = process.env.TERMLOOP_TERMINAL_TOKEN;
  if (controlUrl && token && terminalUrl && terminalToken) {
    return { kind: "local", controlUrl, token, terminalUrl, terminalToken };
  }
  try {
    return { kind: "local", ...await readDiscovery() };
  } catch {
    return undefined;
  }
}

function sourceSummary(entry: RegistryEntry): ConnectionSourceSummary {
  return {
    ...entry.summary,
    state: entry.state,
    ...(entry.message ? { message: entry.message } : {}),
  };
}

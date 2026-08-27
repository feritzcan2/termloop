import {
  TermLoopControlClient,
  type CallArgs,
  type Method,
  type ResultFor,
} from "@termloop/contract/current";

import { createControlSocket } from "./access-websocket.js";
import type { DesktopConnectionConfig } from "./connection-profiles.js";
import {
  ConnectionRegistry,
  LOCAL_CONNECTION_PROFILE_ID,
  localConnectionConfig,
} from "./connection-registry.js";
import { currentConnectionProfileId } from "./ipc-source-context.js";

let registry: ConnectionRegistry | undefined;

export function installConnectionRegistry(next: ConnectionRegistry): void {
  if (registry && registry !== next) registry.stopAll();
  registry = next;
}

export async function connectionConfig(
  profileId = currentConnectionProfileId(),
): Promise<DesktopConnectionConfig | undefined> {
  if (registry) return registry.connectionConfig(profileId);
  if (profileId !== LOCAL_CONNECTION_PROFILE_ID) throw new Error("unknownConnectionProfile");
  return localConnectionConfig();
}

/** Local-only compatibility wrapper for desktop-owned/global operations. */
export async function controlCall<M extends Method>(
  method: M,
  ...args: CallArgs<M>
): Promise<ResultFor<M>> {
  return controlCallFor(currentConnectionProfileId(), method, ...args);
}

export async function controlCallFor<M extends Method>(
  profileId: string,
  method: M,
  ...args: CallArgs<M>
): Promise<ResultFor<M>> {
  if (registry) return registry.call(profileId, method, ...args);
  const config = await connectionConfig(profileId);
  if (!config) throw new Error("daemonUnavailable");
  const client = new TermLoopControlClient(
    config.controlUrl,
    config.token,
    () => createControlSocket(config) as never,
  );
  try {
    return await client.call(method, ...args);
  } finally {
    client.close();
  }
}

export async function localControlCall<M extends Method>(
  method: M,
  ...args: CallArgs<M>
): Promise<ResultFor<M>> {
  return controlCallFor(LOCAL_CONNECTION_PROFILE_ID, method, ...args);
}

/** The bundled daemon supervisor is always pinned to this computer. */
export async function probeDaemonAlive(): Promise<boolean> {
  if (registry) return registry.probeLocal();
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
  } catch {
    return false;
  } finally {
    client.close();
  }
}

export async function requestDiscoveredDaemonShutdown(): Promise<boolean> {
  if (registry) return registry.requestLocalShutdown();
  return (await controlCallFor(LOCAL_CONNECTION_PROFILE_ID, "system.shutdown")).accepted;
}

export async function projectCwd(projectId: string): Promise<string>;
export async function projectCwd(profileId: string, projectId: string): Promise<string>;
export async function projectCwd(profileOrProjectId: string, maybeProjectId?: string): Promise<string> {
  const profileId = maybeProjectId === undefined ? currentConnectionProfileId() : profileOrProjectId;
  const projectId = maybeProjectId ?? profileOrProjectId;
  const projects = await controlCallFor(profileId, "project.list");
  const project = projects.find((value) => value.id === projectId);
  if (!project) throw new Error("projectNotFound");
  return project.folder_path;
}

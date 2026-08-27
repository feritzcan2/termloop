import {
  type SocketFactory,
  type TaskDto,
} from "@termloop/contract/current";

import type {
  AgentLaunchInspection,
  AgentLaunchSelection,
  ConnectionProfile,
  MobileRuntime,
  PlaybookProjection,
  SelectedImage,
  StewardMessage,
  TerminalAttachment,
  TerminalEvent,
} from "@/application/ports";
import type { WatchTargetSettings } from "@/platform/watch-target-settings";
import type { WatchCredentialTransfer } from "@/platform/watch-sync";
import type {
  SavedConnection,
  SecureConnectionRepository,
} from "@/platform/secure-connections";
import { parsePairingCode } from "../../platform/pairing-code";
import { MobileControlClient, MobileControlError } from "./mobile-control-client";
import {
  FRAME_MAGIC,
  KIND_ACK,
  KIND_ATTACH,
  KIND_EOF,
  KIND_ERROR,
  KIND_GAP,
  KIND_INPUT,
  KIND_OUTPUT,
  KIND_REPLAY_OUTPUT,
  decodeFrame,
  decodeGapCount,
  encodeFrame,
} from "./terminal-frame";

const AUTH_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;
const FORCE_RECONNECT_TIMEOUT_MS = 12_000;
const MIN_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 2_000;
const MAX_INPUT_FRAME_BYTES = 16 * 1024;
/// A replay is a frozen bounded snapshot, but the wire must split it into 16 KiB
/// frames. Publishing every transport frame separately makes React reconcile dozens
/// of incomplete Claude redraws before it ever sees the current screen. Fold one
/// replay burst back into its snapshot boundary before presentation sees it.
const REPLAY_BATCH_SETTLE_MS = 16;
const MAX_REPLAY_BATCH_BYTES = 1024 * 1024;
const STEWARD_TRANSCRIPT_LIMIT = 60;
const STEWARD_MESSAGE_LIMIT = 8_192;
const INITIAL_PROMPT_LIMIT = 4_096;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/// The daemon returns the newest messages first; a chat reads oldest first.
function orderedTranscript(messages: readonly StewardMessage[]): StewardMessage[] {
  return [...messages].sort((left, right) => left.sequence - right.sequence);
}

/// The phone shows what the Mac says it would run and nothing it derived itself:
/// every field here is copied straight off the inspected manifest, and a redacted
/// argument stays redacted.
function launchInspection(preview: {
  launch_ticket: string;
  manifest: {
    target: { executable: string; cwd: string; model: string; permission: string; reasoning: string };
    arguments: readonly { position: number; display: string }[];
  };
}): AgentLaunchInspection {
  const target = preview.manifest.target;
  return {
    launchTicket: preview.launch_ticket,
    program: target.executable,
    args: [...preview.manifest.arguments]
      .sort((left, right) => left.position - right.position)
      .map((argument) => argument.display),
    cwd: target.cwd,
    model: target.model.length === 0 ? null : target.model,
    permission: target.permission.length === 0 ? null : target.permission,
    reasoning: target.reasoning.length === 0 ? null : target.reasoning,
  };
}

function launchPrompt(content: string): string | undefined {
  const sanitized = content
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return sanitized.length === 0 ? undefined : sanitized.slice(0, INITIAL_PROMPT_LIMIT);
}

/// Matches Core's Quick Action naming rule: the first remaining prompt line,
/// bounded by Unicode characters rather than UTF-16 code units.
function promptSessionName(content: string): string | undefined {
  const firstLine = content.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const name = [...firstLine].slice(0, 80).join("");
  return name.length === 0 ? undefined : name;
}

async function namePromptedSession(
  control: MobileControlClient,
  session: { id: string; runtime_epoch: number },
  prompt: string | undefined,
): Promise<{ id: string; runtime_epoch: number }> {
  if (prompt === undefined) return session;
  const name = promptSessionName(prompt);
  if (name === undefined) return session;
  try {
    return await control.call("session.rename", { sessionId: session.id, name });
  } catch {
    // The launch ticket has already been spent. Naming must never make the UI
    // retry and accidentally start a second Agent.
    return session;
  }
}

export interface DataSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
}

export type DataSocketFactory = (url: string) => DataSocket;

export interface ProductionRuntimeOptions {
  readonly repository: SecureConnectionRepository;
  readonly controlSocketFactory?: SocketFactory;
  readonly terminalSocketFactory?: DataSocketFactory;
  readonly fetch?: typeof fetch;
  readonly watchBridge?: {
    syncCredentials(
      credentials: readonly WatchCredentialTransfer[],
      activeConnectionIds: readonly string[],
    ): Promise<boolean>;
  };
  readonly watchTargetSettings?: WatchTargetSettings;
}

export function createProductionRuntime(options: ProductionRuntimeOptions): MobileRuntime {
  const controlSocketFactory = options.controlSocketFactory
    ?? ((url: string) => new WebSocket(url) as never);
  const terminalSocketFactory = options.terminalSocketFactory
    ?? ((url: string) => new WebSocket(url) as unknown as DataSocket);
  const request = options.fetch ?? fetch;
  const watchTargetSettings = options.watchTargetSettings ?? noWatchTargetSettings;
  const controlClients = new Map<string, {
    readonly url: string;
    readonly token: string;
    readonly client: MobileControlClient;
  }>();

  const controlClient = (connection: SavedConnection): MobileControlClient => {
    const current = controlClients.get(connection.id);
    if (current?.url === connection.controlUrl && current.token === connection.controlToken) {
      return current.client;
    }
    current?.client.close();
    const next = new MobileControlClient(
      connection.controlUrl,
      connection.controlToken,
      controlSocketFactory,
    );
    controlClients.set(connection.id, {
      url: connection.controlUrl,
      token: connection.controlToken,
      client: next,
    });
    return next;
  };

  const resolve = async (connectionId: string): Promise<SavedConnection> => {
    const connection = await options.repository.get(connectionId);
    if (connection === undefined) throw new Error("Saved Mac was not found.");
    return connection;
  };

  const syncWatchCatalog = async (): Promise<boolean> => {
    if (options.watchBridge === undefined) return false;
    const saved = await options.repository.list();
    const refreshed = await Promise.all(saved.map(async (connection): Promise<WatchCredentialTransfer | null> => {
      try {
        const endpoint = new URL(connection.controlUrl);
        endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
        endpoint.pathname = "/watch/credential";
        const response = await request(endpoint.toString(), {
          headers: { authorization: `Bearer ${connection.controlToken}` },
        });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const token = (body as { token?: unknown } | null)?.token;
        if (typeof token !== "string" || token.length === 0) return null;
        return {
          connectionId: connection.id,
          name: connection.name,
          host: endpoint.host,
          token,
          targetProjectId: await watchTargetSettings.get(connection.id),
        };
      } catch {
        return null;
      }
    }));
    return options.watchBridge.syncCredentials(
      refreshed.filter((entry): entry is WatchCredentialTransfer => entry !== null),
      saved.map((connection) => connection.id),
    );
  };

  return {
    kind: "production",
    connections: {
      async list() {
        const saved = await options.repository.list();
        return Promise.all(saved.map(async (connection): Promise<ConnectionProfile> => {
          try {
            const version = await controlClient(connection).version();
            return profile(connection, "online", version.version, version.protocolVersion);
          } catch (cause: unknown) {
            if (cause instanceof MobileControlError && cause.code === "unsupportedMobileApi") {
              return profile(connection, "updateRequired");
            }
            if (cause instanceof MobileControlError && cause.code === "unauthenticated") {
              return profile(connection, "revoked");
            }
            return profile(connection, "offline");
          }
        }));
      },
      async pair(code) {
        const connection = parsePairingCode(code);
        await options.repository.save(connection);
        return connection.id;
      },
    },

    playbook: {
      async read(connectionId, projectId) {
        const control = controlClient(await resolve(connectionId));
        const [playbook, runtime, routines] = await Promise.all([
          control.call("playbook.get", { projectId }),
          control.call("playbook.runtime", { projectId }),
          control.call("routine.configurationList", { projectId }),
        ]);
        return {
          playbook: playbook.playbook,
          runtime,
          routines: routines.configurations.map((routine) => ({
            id: routine.id,
            name: routine.name,
            enabled: routine.enabled,
          })),
          // The three reads settle independently, so the newest revision any of
          // them saw is the one a later write has to match.
          stateRevision: Math.max(playbook.stateRevision, runtime.stateRevision, routines.stateRevision),
        } satisfies PlaybookProjection;
      },
      async setTaskPosition(connectionId, params) {
        const control = controlClient(await resolve(connectionId));
        await control.call("playbook.taskPositionSet", { ...params });
      },
      async runRoutineNow(connectionId, routineId) {
        const control = controlClient(await resolve(connectionId));
        await control.call("routine.runNow", { routineId });
      },
    },

    agentLaunch: {
      async capabilities(connectionId) {
        const control = controlClient(await resolve(connectionId));
        return await control.call("agent.capabilityList");
      },
      async preview(connectionId, taskId, selection) {
        const control = controlClient(await resolve(connectionId));
        const preview = await control.call("task.previewAgent", {
          taskId,
          agentId: selection.agentId,
          ...(selection.model === "default" ? {} : { model: selection.model }),
          ...(selection.permission === "default" ? {} : { permission: selection.permission }),
          ...(selection.reasoning === "default" ? {} : { reasoning: selection.reasoning }),
        });
        return launchInspection(preview);
      },
      async launch(connectionId, taskId, selection, launchTicket, prompt) {
        const connection = await resolve(connectionId);
        const control = controlClient(connection);
        const session = await control.call("task.launchAgent", {
          taskId,
          agentId: selection.agentId,
          launchTicket,
        });
        const namedSession = await namePromptedSession(control, session, prompt);
        return await launchResult(connection, namedSession, prompt, terminalSocketFactory);
      },
      async previewProject(connectionId, project, selection) {
        const control = controlClient(await resolve(connectionId));
        const preview = await control.call("session.previewAgent", {
          projectId: project.id,
          cwd: project.folder_path,
          agentId: selection.agentId,
          ...(selection.model === "default" ? {} : { model: selection.model }),
          ...(selection.permission === "default" ? {} : { permission: selection.permission }),
          ...(selection.reasoning === "default" ? {} : { reasoning: selection.reasoning }),
        });
        return launchInspection(preview);
      },
      async launchProject(connectionId, project, selection, launchTicket, prompt) {
        const connection = await resolve(connectionId);
        const control = controlClient(connection);
        const session = await control.call("session.launchAgent", {
          projectId: project.id,
          cwd: project.folder_path,
          agentId: selection.agentId,
          launchTicket,
        });
        const namedSession = await namePromptedSession(control, session, prompt);
        return await launchResult(connection, namedSession, prompt, terminalSocketFactory);
      },
    },

    steward: {
      async transcript(connectionId, projectId) {
        const control = controlClient(await resolve(connectionId));
        const result = await control.call("companion.transcriptList", { projectId, limit: STEWARD_TRANSCRIPT_LIMIT });
        return orderedTranscript(result.messages);
      },
      async send(connectionId, projectId, content) {
        const control = controlClient(await resolve(connectionId));
        const trimmed = content.trim();
        if (trimmed.length === 0 || trimmed.length > STEWARD_MESSAGE_LIMIT) {
          throw new Error("Write a message the Steward can read.");
        }
        await control.call("companion.transcriptAppend", { projectId, content: trimmed });
        const result = await control.call("companion.transcriptList", { projectId, limit: STEWARD_TRANSCRIPT_LIMIT });
        return orderedTranscript(result.messages);
      },
      async respond(connectionId, projectId, messageId, action) {
        const control = controlClient(await resolve(connectionId));
        if (action === "accept") {
          await control.call("companion.suggestionAccept", { projectId, suggestionMessageId: messageId });
        } else {
          await control.call("companion.proposalRespond", {
            projectId,
            proposalMessageId: messageId,
            decision: action,
          });
        }
        const result = await control.call("companion.transcriptList", { projectId, limit: STEWARD_TRANSCRIPT_LIMIT });
        return orderedTranscript(result.messages);
      },
    },

    control: {
      async loadOverview(connectionId) {
        const connection = await resolve(connectionId);
        const control = controlClient(connection);
        const [projects, sessions, agentStatuses] = await Promise.all([
          control.call("project.list"),
          control.call("session.list"),
          control.call("agent.statusList"),
        ]);
        const tasks = (await Promise.all(
          projects.map((project) => listActiveTasks(control, project.id)),
        )).flat();
        return { projects, tasks, sessions, agentStatuses };
      },
    },

    worktreeChanges: {
      async listTask(connectionId, taskId) {
        const control = controlClient(await resolve(connectionId));
        return await control.call("task.worktreeChangeList", { taskId });
      },
      async diffTask(connectionId, taskId, observationId, entryId) {
        const control = controlClient(await resolve(connectionId));
        return await control.call("task.worktreeDiff", { taskId, observationId, entryId });
      },
      async preImageTask(connectionId, taskId, observationId, entryId) {
        const control = controlClient(await resolve(connectionId));
        return await control.call("task.worktreePreImage", { taskId, observationId, entryId });
      },
    },

    terminal: {
      async attach(connectionId, session, onEvent) {
        const connection = await resolve(connectionId);
        return attachTerminal(connection, session, onEvent, terminalSocketFactory);
      },
    },
    images: {
      async upload(connectionId, sessionId, image) {
        const connection = await resolve(connectionId);
        if (!validSessionId(sessionId)) throw new Error("This Session cannot receive an image.");
        const source = await request(image.uri);
        if (!source.ok) throw new Error("The selected image could not be read.");
        const body = await source.arrayBuffer();
        if (body.byteLength === 0 || body.byteLength > MAX_IMAGE_BYTES) {
          throw new Error("Choose an image smaller than 10 MB.");
        }
        const mediaType = imageMediaType(image, source.headers.get("content-type"));
        if (mediaType === undefined) {
          throw new Error("Choose a PNG, JPEG, or WebP image.");
        }
        const endpoint = new URL(connection.controlUrl);
        endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
        endpoint.pathname = "/session/image";
        endpoint.search = new URLSearchParams({ sessionId }).toString();
        const response = await request(endpoint.toString(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.controlToken}`,
            "content-type": mediaType,
          },
          body,
        });
        if (!response.ok) throw new Error(imageUploadFailure(response.status));
        const result: unknown = await response.json();
        const attachmentPath = (result as { attachmentPath?: unknown } | null)?.attachmentPath;
        if (typeof attachmentPath !== "string" || attachmentPath.length === 0) {
          throw new Error("Your Mac returned an invalid image attachment.");
        }
        return attachmentPath;
      },
    },
    notifications: {
      async registerDevice(connectionId, registration) {
        const connection = await resolve(connectionId);
        const endpoint = new URL(connection.controlUrl);
        endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
        endpoint.pathname = "/push/register";
        const response = await request(endpoint.toString(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.controlToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(registration),
        });
        if (!response.ok) throw new Error("Push registration failed.");
      },
    },
    // The phone holds the full mobile credential, so it fetches the gateway's
    // watch-scoped token and forwards it over WatchConnectivity. The watch
    // itself never sees the phone credential.
    watch: {
      async sync() {
        return syncWatchCatalog();
      },
      async targetProject(connectionId) {
        return await watchTargetSettings.get(connectionId);
      },
      async setTargetProject(connectionId, projectId) {
        await watchTargetSettings.set(connectionId, projectId);
        return { synced: await syncWatchCatalog() };
      },
    },
  };
}

const noWatchTargetSettings: WatchTargetSettings = {
  async get() { return null; },
  async set() {},
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function validSessionId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(value);
}

function imageMediaType(image: SelectedImage, responseMediaType: string | null): string | undefined {
  const extensionMediaType = image.uri.toLowerCase().match(/\.(png|jpe?g|webp)(?:[?#]|$)/)?.[1];
  const candidate = (image.mediaType ?? responseMediaType ?? (
    extensionMediaType === "png" ? "image/png"
      : extensionMediaType === "webp" ? "image/webp"
        : extensionMediaType === "jpg" || extensionMediaType === "jpeg" ? "image/jpeg" : ""
  )).split(";", 1)[0]?.toLowerCase();
  return candidate !== undefined && IMAGE_MEDIA_TYPES.has(candidate) ? candidate : undefined;
}

async function listActiveTasks(
  control: MobileControlClient,
  projectId: string,
): Promise<TaskDto[]> {
  const tasks: TaskDto[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
    const page = await control.call("task.list", {
      projectId,
      archiveScope: "active",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    tasks.push(...page.items);
    if (page.next_cursor === null) return tasks;
    if (seenCursors.has(page.next_cursor)) throw new Error("Task pagination cursor repeated.");
    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
  throw new Error("Task pagination exceeded the mobile overview bound.");
}

function profile(
  connection: SavedConnection,
  availability: ConnectionProfile["availability"],
  productVersion = connection.productVersion,
  contractIdentity = connection.contractIdentity,
): ConnectionProfile {
  return {
    id: connection.id,
    name: connection.name,
    endpointLabel: new URL(connection.controlUrl).host,
    availability,
    lastConnectedAtEpochMs: connection.lastConnectedAtEpochMs,
    productVersion,
    contractIdentity,
  };
}

async function attachTerminal(
  connection: SavedConnection,
  session: { id: string; runtime_epoch: number },
  onEvent: (event: TerminalEvent) => void,
  socketFactory: DataSocketFactory,
): Promise<TerminalAttachment> {
  let socket: DataSocket | undefined;
  let sequence = 1n;
  let detached = false;
  let authenticated = false;
  let reconnectDelay = MIN_RECONNECT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  let replayChunks: Uint8Array[] = [];
  let replayBytes = 0;
  let inbound = Promise.resolve();
  let successfulConnections = 0;
  let resolveFirst: (() => void) | undefined;
  let rejectFirst: ((cause: Error) => void) | undefined;
  const reconnectWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (cause: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }>();

  const firstConnection = new Promise<void>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });

  const clearAuthenticationTimer = () => {
    if (authenticationTimer !== undefined) clearTimeout(authenticationTimer);
    authenticationTimer = undefined;
  };

  const clearConnectionTimer = () => {
    if (connectionTimer !== undefined) clearTimeout(connectionTimer);
    connectionTimer = undefined;
  };

  const clearReplayTimer = () => {
    if (replayTimer !== undefined) clearTimeout(replayTimer);
    replayTimer = undefined;
  };

  const discardReplay = () => {
    clearReplayTimer();
    replayChunks = [];
    replayBytes = 0;
  };

  const settleReconnectWaiters = (cause?: Error) => {
    const waiters = [...reconnectWaiters];
    reconnectWaiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      if (cause === undefined) waiter.resolve();
      else waiter.reject(cause);
    }
  };

  const flushReplay = () => {
    clearReplayTimer();
    if (detached || replayBytes === 0) return;
    const bytes = new Uint8Array(replayBytes);
    let offset = 0;
    for (const chunk of replayChunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    replayChunks = [];
    replayBytes = 0;
    onEvent({ type: "replay", bytes });
  };

  const queueReplay = (bytes: Uint8Array) => {
    if (replayBytes > 0
      && replayBytes + bytes.byteLength > MAX_REPLAY_BATCH_BYTES) {
      flushReplay();
    }
    replayChunks.push(bytes);
    replayBytes += bytes.byteLength;
    clearReplayTimer();
    replayTimer = setTimeout(flushReplay, REPLAY_BATCH_SETTLE_MS);
  };

  const failFirst = (message: string) => {
    if (rejectFirst === undefined) return;
    const reject = rejectFirst;
    resolveFirst = undefined;
    rejectFirst = undefined;
    detached = true;
    clearConnectionTimer();
    clearAuthenticationTimer();
    socket?.close();
    reject(new Error(message));
  };

  const scheduleReconnect = () => {
    if (detached || reconnectTimer !== undefined) return;
    onEvent({ type: "state", state: "connectionLost" });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2);
      connect();
    }, reconnectDelay);
  };

  const handleClosed = (closed: DataSocket) => {
    if (socket !== closed) return;
    socket = undefined;
    authenticated = false;
    clearConnectionTimer();
    clearAuthenticationTimer();
    discardReplay();
    if (resolveFirst !== undefined) failFirst("Terminal connection failed.");
    else scheduleReconnect();
  };

  const connect = () => {
    if (detached) return;
    onEvent({ type: "state", state: "connecting" });
    let next: DataSocket;
    try {
      next = socketFactory(connection.terminalUrl);
    } catch {
      if (resolveFirst !== undefined) failFirst("Terminal connection failed.");
      else scheduleReconnect();
      return;
    }
    socket = next;
    next.binaryType = "arraybuffer";
    connectionTimer = setTimeout(() => {
      if (socket !== next || detached) return;
      /// iOS can leave a WebSocket in CONNECTING without ever emitting open,
      /// error, or close after foregrounding. Treat that silence as a failed
      /// transport so the bounded reconnect loop can create a new socket.
      handleClosed(next);
      next.close();
    }, CONNECT_TIMEOUT_MS);
    next.onopen = () => {
      if (socket !== next || detached) return;
      clearConnectionTimer();
      next.send(authenticationBytes(connection.terminalToken));
      authenticationTimer = setTimeout(() => {
        if (resolveFirst !== undefined) failFirst("Terminal authentication timed out.");
        else next.close();
      }, AUTH_TIMEOUT_MS);
    };
    next.onmessage = (event) => {
      inbound = inbound
        .then(() => handleMessage(next, event.data))
        .catch(() => next.close());
    };
    next.onerror = () => handleClosed(next);
    next.onclose = () => handleClosed(next);
  };

  const handleMessage = async (source: DataSocket, data: unknown) => {
    if (socket !== source || detached) return;
    const bytes = await messageBytes(data);
    if (!authenticated) {
      const response = new TextDecoder().decode(bytes);
      if (response === "TLAUTH") {
        failFirst("Terminal credential was refused.");
        return;
      }
      if (response !== "TLOK") return;
      clearAuthenticationTimer();
      authenticated = true;
      reconnectDelay = MIN_RECONNECT_MS;
      if (successfulConnections > 0) onEvent({ type: "reset" });
      successfulConnections += 1;
      onEvent({ type: "state", state: "connected" });
      source.send(encodeFrame(session.id, session.runtime_epoch, sequence++, KIND_ATTACH));
      settleReconnectWaiters();
      resolveFirst?.();
      resolveFirst = undefined;
      rejectFirst = undefined;
      return;
    }

    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return;
    }
    if (frame.sessionId !== session.id || frame.epoch !== session.runtime_epoch) return;
    if (frame.kind === KIND_REPLAY_OUTPUT) {
      queueReplay(frame.payload);
      return;
    }
    /// Any non-replay frame is an ordering boundary. The frozen replay must be
    /// visible before a following gap, live byte, or exit state.
    flushReplay();
    if (frame.kind === KIND_OUTPUT) onEvent({ type: "live", bytes: frame.payload });
    else if (frame.kind === KIND_GAP) onEvent({ type: "gap", droppedFrames: decodeGapCount(frame.payload) });
    else if (frame.kind === KIND_EOF) onEvent({ type: "eof" });
    else if (frame.kind === KIND_ERROR) source.close();
    else if (frame.kind === KIND_ACK) return;
  };

  connect();
  await firstConnection;

  return {
    async input(bytes) {
      if (detached || !authenticated || socket === undefined || socket.readyState !== 1) {
        throw new Error("Terminal is not connected.");
      }
      const target = socket;
      try {
        for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_FRAME_BYTES) {
          target.send(encodeFrame(
            session.id,
            session.runtime_epoch,
            sequence++,
            KIND_INPUT,
            bytes.slice(offset, offset + MAX_INPUT_FRAME_BYTES),
          ));
        }
      } catch (cause: unknown) {
        /// Browser WebSocket implementations can throw before delivering `close`.
        /// Enter the same bounded reconnect path immediately so presentation cannot
        /// remain permanently disconnected behind a socket that is already unusable.
        handleClosed(target);
        target.close();
        throw cause;
      }
    },
    reconnect() {
      if (detached) return Promise.reject(new Error("Terminal is detached."));
      const waiting = new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timeout: setTimeout(() => {
            reconnectWaiters.delete(waiter);
            reject(new Error("Terminal did not reconnect."));
          }, FORCE_RECONNECT_TIMEOUT_MS),
        };
        reconnectWaiters.add(waiter);
      });
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const stale = socket;
      socket = undefined;
      authenticated = false;
      clearConnectionTimer();
      clearAuthenticationTimer();
      discardReplay();
      onEvent({ type: "state", state: "connectionLost" });
      stale?.close();
      connect();
      return waiting;
    },
    async detach() {
      if (detached) return;
      detached = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      clearConnectionTimer();
      clearAuthenticationTimer();
      discardReplay();
      settleReconnectWaiters(new Error("Terminal is detached."));
      socket?.close();
      socket = undefined;
    },
  };
}

async function launchResult(
  connection: SavedConnection,
  session: { id: string; runtime_epoch: number },
  prompt: string | undefined,
  socketFactory: DataSocketFactory,
): Promise<{ sessionId: string; runtimeEpoch: number; promptSubmitted: boolean | null }> {
  const content = prompt === undefined ? undefined : launchPrompt(prompt);
  if (content === undefined) {
    return { sessionId: session.id, runtimeEpoch: session.runtime_epoch, promptSubmitted: null };
  }

  let attachment: TerminalAttachment | undefined;
  try {
    attachment = await attachTerminal(connection, session, () => {}, socketFactory);
    const encoder = new TextEncoder();
    await attachment.input(encoder.encode(`${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`));
    await attachment.input(new Uint8Array([13]));
    return { sessionId: session.id, runtimeEpoch: session.runtime_epoch, promptSubmitted: true };
  } catch {
    return { sessionId: session.id, runtimeEpoch: session.runtime_epoch, promptSubmitted: false };
  } finally {
    await attachment?.detach();
  }
}

function imageUploadFailure(status: number): string {
  if (status === 404) return "Your Mac's mobile access gateway needs an update.";
  if (status === 401) return "Your Mac rejected this photo upload. Pair this phone again.";
  if (status === 409) return "This agent session is no longer running.";
  if (status === 413) return "Choose an image smaller than 10 MB.";
  if (status === 415) return "Choose a PNG, JPEG, or WebP image.";
  return "The image could not be delivered to your Mac.";
}

function authenticationBytes(token: string): Uint8Array {
  const magic = new TextEncoder().encode(FRAME_MAGIC);
  const credential = new TextEncoder().encode(token);
  const bytes = new Uint8Array(magic.byteLength + credential.byteLength);
  bytes.set(magic, 0);
  bytes.set(credential, magic.byteLength);
  return bytes;
}

async function messageBytes(data: unknown): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new Error("Terminal message type is unsupported.");
}

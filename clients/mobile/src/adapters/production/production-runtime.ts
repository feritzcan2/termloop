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
  StewardVoiceClip,
  StewardVoiceReceiptStore,
  TerminalAttachment,
  TerminalEvent,
} from "@/application/ports";
import type { WatchTargetSettings } from "@/platform/watch-target-settings";
import type { WatchCredentialTransfer } from "@/platform/watch-sync";
import type {
  SavedConnection,
  SecureConnectionRepository,
} from "@/platform/secure-connections";
import {
  mobileDiagnostics,
  websocketEndpointLabel,
  type MobileDiagnosticReporter,
  type MobileDiagnosticValue,
} from "../../platform/mobile-diagnostics";
import { parsePairingCode } from "../../platform/pairing-code";
import { MobileControlClient, MobileControlError } from "./mobile-control-client";
import {
  dataSocketMessageBytes,
  type DataSocket,
  type DataSocketFactory,
} from "./data-socket";
import { MobileConnectionCoordinator } from "./mobile-connection-coordinator";
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
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;
const MAX_INPUT_FRAME_BYTES = 16 * 1024;
/// A replay is a frozen bounded snapshot, but the wire must split it into 16 KiB
/// frames. Publishing every transport frame separately makes React reconcile dozens
/// of incomplete Claude redraws before it ever sees the current screen. Fold one
/// replay burst back into its snapshot boundary before presentation sees it.
const REPLAY_BATCH_SETTLE_MS = 16;
const MAX_REPLAY_BATCH_BYTES = 1024 * 1024;
const STEWARD_TRANSCRIPT_LIMIT = 60;
const STEWARD_MESSAGE_LIMIT = 8_192;
const STEWARD_VOICE_LIMIT_BYTES = 2 * 1024 * 1024;
const STEWARD_SPEECH_LIMIT_BYTES = 10 * 1024 * 1024;
const INITIAL_PROMPT_LIMIT = 4_096;
/// A closed Mac must never hold the saved-computer catalog behind two 5s
/// request attempts. Healthy local/Tailscale paths usually settle inside this
/// window; slower profiles remain visible as reconnecting and finish in the
/// background.
const PROFILE_DISCOVERY_SETTLE_MS = 250;
const ONLINE_PROFILE_FRESH_MS = 30_000;
const UNAVAILABLE_PROFILE_FRESH_MS = 2_000;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
let terminalDiagnosticSequence = 0;

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

export type { DataSocket } from "./data-socket";

export interface ProductionRuntimeOptions {
  readonly repository: SecureConnectionRepository;
  readonly diagnostics?: MobileDiagnosticReporter;
  readonly controlSocketFactory?: SocketFactory;
  readonly terminalSocketFactory?: DataSocketFactory;
  /// Enables the v2 route-independent `/mobile` transport. Kept injectable so
  /// legacy adapter tests can exercise the v1 control/terminal fallbacks.
  readonly multiplexSocketFactory?: DataSocketFactory;
  readonly fetch?: typeof fetch;
  readonly watchBridge?: {
    syncCredentials(
      credentials: readonly WatchCredentialTransfer[],
      activeConnectionIds: readonly string[],
    ): Promise<boolean>;
  };
  readonly watchTargetSettings?: WatchTargetSettings;
  readonly voiceReceipts?: StewardVoiceReceiptStore;
}

export function createProductionRuntime(options: ProductionRuntimeOptions): MobileRuntime {
  const diagnostics = options.diagnostics ?? mobileDiagnostics;
  const controlSocketFactory = options.controlSocketFactory
    ?? ((url: string) => new WebSocket(url) as never);
  const terminalSocketFactory = options.terminalSocketFactory
    ?? ((url: string) => new WebSocket(url) as unknown as DataSocket);
  const request = options.fetch ?? fetch;
  const watchTargetSettings = options.watchTargetSettings ?? noWatchTargetSettings;
  const voiceReceipts = options.voiceReceipts ?? noVoiceReceipts;
  const connectionChangeListeners = new Set<() => void>();
  const profileCache = new Map<string, {
    readonly connection: SavedConnection;
    readonly checkedAtEpochMs: number;
    readonly value: ConnectionProfile;
  }>();
  const profileProbes = new Map<string, {
    readonly connection: SavedConnection;
    readonly promise: Promise<void>;
  }>();
  const authenticatedActivityAtEpochMs = new Map<string, number>();
  let profileGeneration = 0;
  const coordinators = new Map<string, {
    readonly coordinator: MobileConnectionCoordinator;
    readonly unsubscribeStatus: () => void;
  }>();
  const controlClients = new Map<string, {
    readonly url: string;
    readonly token: string;
    readonly client: MobileControlClient;
  }>();

  const controlClient = (connection: SavedConnection): MobileControlClient => {
    const multiplex = connectionCoordinator(connection);
    if (multiplex !== undefined) return multiplex.control;
    const current = controlClients.get(connection.id);
    if (current?.url === connection.controlUrl && current.token === connection.controlToken) {
      return current.client;
    }
    current?.client.close();
    const next = new MobileControlClient(
      connection.controlUrl,
      connection.controlToken,
      controlSocketFactory,
      diagnostics,
      connection.id,
    );
    controlClients.set(connection.id, {
      url: connection.controlUrl,
      token: connection.controlToken,
      client: next,
    });
    return next;
  };

  const connectionCoordinator = (connection: SavedConnection): MobileConnectionCoordinator | undefined => {
    if (options.multiplexSocketFactory === undefined) return undefined;
    const current = coordinators.get(connection.id);
    if (current?.coordinator.matches(connection)) return current.coordinator;
    current?.unsubscribeStatus();
    current?.coordinator.close();
    const coordinator = new MobileConnectionCoordinator(
      connection,
      options.multiplexSocketFactory,
      diagnostics,
    );
    const unsubscribeStatus = coordinator.subscribeStatus((status) => {
      const cached = profileCache.get(connection.id);
      if (status === "online") {
        const now = Date.now();
        authenticatedActivityAtEpochMs.set(connection.id, now);
        const cachedMatches = cached !== undefined
          && sameConnectionIdentity(cached.connection, connection);
        const recovered = !cachedMatches || cached.value.availability !== "online";
        profileCache.set(connection.id, {
          connection,
          checkedAtEpochMs: now,
          value: profile(
            connection,
            "online",
            cachedMatches ? cached.value.productVersion : connection.productVersion,
            cachedMatches ? cached.value.contractIdentity : connection.contractIdentity,
          ),
        });
        if (recovered) {
          for (const listener of connectionChangeListeners) listener();
        }
        return;
      }
      if (status === "offline") {
        /// Transport loss expires the reachability lease immediately. The next
        /// catalog read starts a fresh version proof instead of reusing success.
        authenticatedActivityAtEpochMs.delete(connection.id);
        profileCache.delete(connection.id);
        for (const listener of connectionChangeListeners) listener();
      }
    });
    coordinators.set(connection.id, { coordinator, unsubscribeStatus });
    return coordinator;
  };

  const probeProfile = (connection: SavedConnection): Promise<void> | undefined => {
    const cached = profileCache.get(connection.id);
    const freshnessMs = cached?.value.availability === "online"
      ? ONLINE_PROFILE_FRESH_MS
      : UNAVAILABLE_PROFILE_FRESH_MS;
    if (cached !== undefined && sameConnectionIdentity(cached.connection, connection)
      && Date.now() - cached.checkedAtEpochMs < freshnessMs) return undefined;
    const current = profileProbes.get(connection.id);
    if (current !== undefined && sameConnectionIdentity(current.connection, connection)) return current.promise;

    const generation = profileGeneration;
    const startedAtEpochMs = Date.now();
    const promise = controlClient(connection).version(true).then(
      (version) => ({
        transientFailure: false,
        value: profile(connection, "online", version.version, version.protocolVersion),
      }),
      (cause: unknown) => {
        if (cause instanceof MobileControlError && cause.code === "unsupportedMobileApi") {
          return { transientFailure: false, value: profile(connection, "updateRequired") };
        }
        if (cause instanceof MobileControlError && cause.code === "unauthenticated") {
          return { transientFailure: false, value: profile(connection, "revoked") };
        }
        return { transientFailure: true, value: profile(connection, "offline") };
      },
    ).then(({ transientFailure, value }) => {
      if (generation !== profileGeneration) return;
      const active = profileProbes.get(connection.id);
      if (active === undefined || !sameConnectionIdentity(active.connection, connection)) return;
      if (transientFailure
        && (authenticatedActivityAtEpochMs.get(connection.id) ?? -1) >= startedAtEpochMs) {
        return;
      }
      const previous = profileCache.get(connection.id);
      profileCache.set(connection.id, {
        connection,
        checkedAtEpochMs: Date.now(),
        value,
      });
      if (previous === undefined || !sameProfile(previous.value, value)) {
        for (const listener of connectionChangeListeners) listener();
      }
    }).finally(() => {
      const active = profileProbes.get(connection.id);
      if (active?.promise === promise) profileProbes.delete(connection.id);
    });
    profileProbes.set(connection.id, { connection, promise });
    return promise;
  };

  const resolve = async (connectionId: string): Promise<SavedConnection> => {
    const connection = await options.repository.get(connectionId);
    if (connection === undefined) throw new Error("Saved Mac was not found.");
    return connection;
  };

  const attachConnectionTerminal = (
    connection: SavedConnection,
    session: { id: string; runtime_epoch: number },
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalAttachment> => {
    const coordinator = connectionCoordinator(connection);
    return coordinator === undefined
      ? attachTerminal(connection, session, onEvent, terminalSocketFactory, diagnostics)
      : coordinator.attachTerminal(session, onEvent);
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
    voiceReceipts,
    connections: {
      subscribeChanges(listener) {
        let active = true;
        connectionChangeListeners.add(listener);
        void options.repository.list().then((saved) => {
          if (!active) return;
          for (const connection of saved) connectionCoordinator(connection);
        }, () => {});
        return () => {
          active = false;
          connectionChangeListeners.delete(listener);
        };
      },
      async list() {
        const saved = await options.repository.list();
        const knownIds = new Set(saved.map(({ id }) => id));
        for (const connectionId of profileCache.keys()) {
          if (!knownIds.has(connectionId)) profileCache.delete(connectionId);
        }
        const probes = saved.flatMap((connection) => {
          const pending = probeProfile(connection);
          return pending === undefined ? [] : [pending];
        });
        if (saved.some((connection) => profileCache.get(connection.id) === undefined)) {
          await settleWithin(probes, PROFILE_DISCOVERY_SETTLE_MS);
        }
        return saved.map((connection) => {
          const cached = profileCache.get(connection.id);
          return cached !== undefined && sameConnectionIdentity(cached.connection, connection)
            ? profile(
              connection,
              cached.value.availability,
              cached.value.productVersion,
              cached.value.contractIdentity,
            )
            : profile(connection, "reconnecting");
        });
      },
      resetTransports() {
        profileGeneration += 1;
        profileCache.clear();
        profileProbes.clear();
        authenticatedActivityAtEpochMs.clear();
        for (const connection of controlClients.values()) connection.client.close();
        controlClients.clear();
        for (const connection of coordinators.values()) {
          connection.unsubscribeStatus();
          connection.coordinator.close();
        }
        coordinators.clear();
      },
      async pair(code) {
        const connection = parsePairingCode(code);
        await options.repository.save(connection);
        authenticatedActivityAtEpochMs.delete(connection.id);
        profileCache.delete(connection.id);
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
        return await launchResult(
          namedSession,
          prompt,
          (launched, onEvent) => attachConnectionTerminal(connection, launched, onEvent),
        );
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
        return await launchResult(
          namedSession,
          prompt,
          (launched, onEvent) => attachConnectionTerminal(connection, launched, onEvent),
        );
      },
    },

    sessionActions: {
      async fork(connectionId, sessionId) {
        return await controlClient(await resolve(connectionId)).call("session.forkAgent", { sessionId });
      },
      async repairProviderHistory(connectionId, sessionId) {
        await controlClient(await resolve(connectionId)).call("session.repairProviderHistory", {
          sessionId,
          acknowledgeHistoryRewrite: true,
        });
      },
      async restart(connectionId, sessionId) {
        return await controlClient(await resolve(connectionId)).call("session.restartAgent", { sessionId });
      },
      async askTo(connectionId, sessionId, targetAgentId) {
        await controlClient(await resolve(connectionId)).call("session.requestAskTo", {
          sessionId,
          targetAgentId,
        });
      },
      async handoverTo(connectionId, sessionId, targetSessionId) {
        await controlClient(await resolve(connectionId)).call("session.requestHandoverTo", {
          sessionId,
          targetSessionId,
        });
      },
      async rename(connectionId, sessionId, name) {
        return await controlClient(await resolve(connectionId)).call("session.rename", { sessionId, name });
      },
      async previewRelocateToTask(connectionId, sessionId, taskId, mode) {
        return await controlClient(await resolve(connectionId)).call("session.previewRelocateAgentToTask", {
          sessionId,
          taskId,
          mode,
        });
      },
      async relocateToTask(connectionId, sessionId, taskId, operationId, relocationTicket) {
        return await controlClient(await resolve(connectionId)).call("session.relocateAgentToTask", {
          sessionId,
          taskId,
          operationId,
          relocationTicket,
        });
      },
      async previewRelocateToProject(connectionId, sessionId, projectId) {
        return await controlClient(await resolve(connectionId)).call("session.previewRelocateAgentToProject", {
          sessionId,
          projectId,
        });
      },
      async relocateToProject(connectionId, sessionId, projectId, operationId, relocationTicket) {
        return await controlClient(await resolve(connectionId)).call("session.relocateAgentToProject", {
          sessionId,
          projectId,
          operationId,
          relocationTicket,
        });
      },
      async terminate(connectionId, sessionId) {
        await controlClient(await resolve(connectionId)).call("session.terminate", { sessionId });
      },
      async close(connectionId, sessionId) {
        await controlClient(await resolve(connectionId)).call("session.close", { sessionId });
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
      async transcribeVoice(connectionId, clip) {
        const connection = await resolve(connectionId);
        if (!validStewardVoiceClip(clip)) {
          throw new Error("This recording cannot be transcribed.");
        }
        const endpoint = gatewayHttpEndpoint(connection, "/steward/transcribe");
        const response = await request(endpoint.toString(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.controlToken}`,
            "content-type": clip.mediaType,
          },
          body: clip.bytes,
        });
        if (!response.ok) throw new Error(stewardVoiceFailure(response.status));
        const value: unknown = await response.json();
        const transcript = (value as { transcript?: unknown } | null)?.transcript;
        if (typeof transcript !== "string" || transcript.trim().length === 0) {
          throw new Error("Your Mac returned an invalid voice transcript.");
        }
        return transcript.trim();
      },
      async commitVoice(connectionId, projectId, transcript) {
        const control = controlClient(await resolve(connectionId));
        const trimmed = transcript.trim();
        if (!validProjectId(projectId) || trimmed.length === 0 || trimmed.length > STEWARD_MESSAGE_LIMIT) {
          throw new Error("Correct the transcript before sending it to the Steward.");
        }
        const result = await control.call("companion.transcriptAppend", {
          projectId,
          inputMode: "voice",
          content: trimmed,
        });
        return { transcript: trimmed, userSequence: result.message.sequence };
      },
      async speech(connectionId, projectId, sequence) {
        const connection = await resolve(connectionId);
        if (!validProjectId(projectId) || !Number.isSafeInteger(sequence) || sequence < 1) {
          throw new Error("This Steward reply cannot be spoken.");
        }
        const endpoint = gatewayHttpEndpoint(connection, "/steward/speech");
        const response = await request(endpoint.toString(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.controlToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectId, sequence }),
        });
        if (!response.ok) throw new Error(stewardSpeechFailure(response.status));
        const body = await response.arrayBuffer();
        if (body.byteLength === 0 || body.byteLength > STEWARD_SPEECH_LIMIT_BYTES) {
          throw new Error("Your Mac returned invalid Steward speech.");
        }
        return new Uint8Array(body);
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
        const [taskPages, stewardConfigurations] = await Promise.all([
          Promise.all(projects.map((project) => listActiveTasks(control, project.id))),
          Promise.all(projects.map(async (project) => {
            try {
              const result = await control.call("steward.configurationGet", { projectId: project.id });
              return result.configuration?.enabled === true ? result.configuration : undefined;
            } catch (cause: unknown) {
              // Steward voice is an optional projection. A server-side read
              // error must not erase otherwise-successful Projects, Tasks,
              // Sessions, and Agent statuses from Home. Transport and
              // authentication failures remain fatal so the connection is
              // never presented as healthy without delivery evidence.
              if (cause instanceof MobileControlError
                && cause.code !== "unauthenticated"
                && cause.code !== "unsupportedMobileApi") {
                diagnostics.report("control", "optional_steward_read_failed", {
                  connectionId,
                  errorCode: cause.code,
                });
                return undefined;
              }
              throw cause;
            }
          })),
        ]);
        const tasks = taskPages.flat();
        const enabledStewards = stewardConfigurations
          .filter((configuration): configuration is NonNullable<typeof configuration> => configuration !== undefined);
        const stewardEnabledProjectIds = enabledStewards.map((configuration) => configuration.projectId);
        const stewardExecutorSessionIds = Object.fromEntries(enabledStewards.flatMap((configuration) => (
          configuration.executorSessionId === null
            ? []
            : [[configuration.projectId, configuration.executorSessionId]]
        )));
        return {
          projects,
          stewardEnabledProjectIds,
          stewardExecutorSessionIds,
          tasks,
          sessions,
          agentStatuses,
        };
      },
      subscribeInvalidations(connectionId, listener) {
        let disposed = false;
        let unsubscribe: (() => void) | undefined;
        void resolve(connectionId).then((connection) => {
          if (disposed) return;
          unsubscribe = connectionCoordinator(connection)?.subscribeInvalidations(listener);
        });
        return () => {
          disposed = true;
          unsubscribe?.();
        };
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
        return attachConnectionTerminal(connection, session, onEvent);
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

const noVoiceReceipts: StewardVoiceReceiptStore = {
  async read() {
    return { initialized: false, acknowledgedSequence: 0, pendingUserSequence: null };
  },
  async write() {},
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function validSessionId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(value);
}

function validProjectId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(value);
}

function validStewardVoiceClip(clip: StewardVoiceClip): boolean {
  return clip.bytes.byteLength > 0 && clip.bytes.byteLength <= STEWARD_VOICE_LIMIT_BYTES
    && ["audio/m4a", "audio/mp4", "audio/wav", "audio/webm"].includes(clip.mediaType);
}

function gatewayHttpEndpoint(connection: SavedConnection, pathname: string): URL {
  const endpoint = new URL(connection.controlUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = pathname;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function stewardVoiceFailure(status: number): string {
  if (status === 401) return "This Mac no longer accepts the saved mobile credential.";
  if (status === 413) return "Keep each voice turn under 2 MB.";
  if (status === 422) return "I could not hear speech in that recording.";
  if (status === 404) return "Your Mac's mobile access gateway needs an update.";
  return "Steward voice is unavailable. Try again shortly.";
}

function stewardSpeechFailure(status: number): string {
  if (status === 401) return "This Mac no longer accepts the saved mobile credential.";
  if (status === 404) return "That Steward reply is no longer available for speech.";
  return "Steward speech is unavailable. Check the OpenAI voice key on your Mac.";
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

function sameConnectionIdentity(left: SavedConnection, right: SavedConnection): boolean {
  return left.id === right.id
    && left.controlUrl === right.controlUrl
    && left.controlToken === right.controlToken
    && left.terminalUrl === right.terminalUrl
    && left.terminalToken === right.terminalToken;
}

function sameProfile(left: ConnectionProfile, right: ConnectionProfile): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.endpointLabel === right.endpointLabel
    && left.availability === right.availability
    && left.lastConnectedAtEpochMs === right.lastConnectedAtEpochMs
    && left.productVersion === right.productVersion
    && left.contractIdentity === right.contractIdentity;
}

async function settleWithin(promises: readonly Promise<void>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

async function attachTerminal(
  connection: SavedConnection,
  session: { id: string; runtime_epoch: number },
  onEvent: (event: TerminalEvent) => void,
  socketFactory: DataSocketFactory,
  diagnostics: MobileDiagnosticReporter,
): Promise<TerminalAttachment> {
  const attachmentId = `terminal-${++terminalDiagnosticSequence}`;
  const report = (
    event: string,
    details: Readonly<Record<string, MobileDiagnosticValue | undefined>> = {},
  ) => diagnostics.report("terminal", event, {
    connectionId: connection.id,
    ...diagnostics.correlation(),
    sessionId: session.id,
    runtimeEpoch: session.runtime_epoch,
    attachmentId,
    ...details,
  });
  let socket: DataSocket | undefined;
  let sequence = 1n;
  let detached = false;
  let authenticated = false;
  let reconnectDelay = MIN_RECONNECT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  let stabilityTimer: ReturnType<typeof setTimeout> | undefined;
  let replayChunks: Uint8Array[] = [];
  let replayBytes = 0;
  let inbound = Promise.resolve();
  let successfulConnections = 0;
  let connectionAttempt = 0;
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
  report("attachment_started", {
    endpoint: websocketEndpointLabel(connection.terminalUrl),
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

  const clearStabilityTimer = () => {
    if (stabilityTimer !== undefined) clearTimeout(stabilityTimer);
    stabilityTimer = undefined;
  };

  const discardReplay = () => {
    clearReplayTimer();
    replayChunks = [];
    replayBytes = 0;
  };

  const settleReconnectWaiters = (cause?: Error) => {
    const waiters = [...reconnectWaiters];
    reconnectWaiters.clear();
    if (waiters.length > 0) {
      report("reconnect_waiters_settled", {
        waiterCount: waiters.length,
        ok: cause === undefined,
        reason: cause?.message,
      });
    }
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      if (cause === undefined) waiter.resolve();
      else waiter.reject(cause);
    }
  };

  const flushReplay = () => {
    clearReplayTimer();
    if (detached || replayBytes === 0) return;
    const chunkCount = replayChunks.length;
    const bytes = new Uint8Array(replayBytes);
    let offset = 0;
    for (const chunk of replayChunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    replayChunks = [];
    replayBytes = 0;
    report("replay_received", {
      bytes: bytes.byteLength,
      chunks: chunkCount,
    });
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

  const failFirst = (message: string, reason = "initialConnectionFailed") => {
    if (rejectFirst === undefined) return;
    const reject = rejectFirst;
    resolveFirst = undefined;
    rejectFirst = undefined;
    detached = true;
    clearConnectionTimer();
    clearAuthenticationTimer();
    clearStabilityTimer();
    const failed = socket;
    socket = undefined;
    report("attachment_failed", {
      reason,
      connectionAttempt,
      successfulConnections,
    });
    failed?.close();
    reject(new Error(message));
  };

  const scheduleReconnect = (reason: string) => {
    if (detached || reconnectTimer !== undefined) return;
    report("reconnect_scheduled", {
      reason,
      delayMs: reconnectDelay,
      successfulConnections,
    });
    onEvent({ type: "state", state: "connectionLost" });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2);
      connect();
    }, reconnectDelay);
  };

  const handleClosed = (
    closed: DataSocket,
    reason: string,
    close?: { code?: number; reason?: string; wasClean?: boolean },
  ) => {
    if (socket !== closed) return;
    report("connection_closed", {
      reason,
      connectionAttempt,
      authenticated,
      successfulConnections,
      closeCode: close?.code,
      closeReasonLength: close?.reason?.length,
      wasClean: close?.wasClean,
    });
    socket = undefined;
    authenticated = false;
    clearConnectionTimer();
    clearAuthenticationTimer();
    clearStabilityTimer();
    discardReplay();
    if (resolveFirst !== undefined) failFirst("Terminal connection failed.", reason);
    else scheduleReconnect(reason);
  };

  const connect = () => {
    if (detached) return;
    connectionAttempt += 1;
    const attempt = connectionAttempt;
    const startedAtEpochMs = Date.now();
    report("connection_started", {
      connectionAttempt: attempt,
      reconnectDelayMs: reconnectDelay,
    });
    onEvent({ type: "state", state: "connecting" });
    let next: DataSocket;
    try {
      next = socketFactory(connection.terminalUrl);
    } catch (cause: unknown) {
      report("connection_factory_failed", {
        connectionAttempt: attempt,
        causeType: cause instanceof Error ? cause.name : typeof cause,
      });
      if (resolveFirst !== undefined) failFirst("Terminal connection failed.", "socketFactoryFailed");
      else scheduleReconnect("socketFactoryFailed");
      return;
    }
    socket = next;
    next.binaryType = "arraybuffer";
    connectionTimer = setTimeout(() => {
      if (socket !== next || detached) return;
      /// iOS can leave a WebSocket in CONNECTING without ever emitting open,
      /// error, or close after foregrounding. Treat that silence as a failed
      /// transport so the bounded reconnect loop can create a new socket.
      report("connection_timeout", {
        connectionAttempt: attempt,
        durationMs: Date.now() - startedAtEpochMs,
      });
      handleClosed(next, "connectTimeout");
      next.close();
    }, CONNECT_TIMEOUT_MS);
    next.onopen = () => {
      if (socket !== next || detached) return;
      clearConnectionTimer();
      report("connection_opened", {
        connectionAttempt: attempt,
        durationMs: Date.now() - startedAtEpochMs,
      });
      try {
        next.send(authenticationBytes(connection.terminalToken));
      } catch (cause: unknown) {
        report("authentication_send_failed", {
          connectionAttempt: attempt,
          causeType: cause instanceof Error ? cause.name : typeof cause,
        });
        handleClosed(next, "authenticationSendFailed");
        next.close();
        return;
      }
      authenticationTimer = setTimeout(() => {
        report("authentication_timeout", {
          connectionAttempt: attempt,
          durationMs: Date.now() - startedAtEpochMs,
        });
        if (resolveFirst !== undefined) failFirst("Terminal authentication timed out.", "authenticationTimeout");
        else {
          handleClosed(next, "authenticationTimeout");
          next.close();
        }
      }, AUTH_TIMEOUT_MS);
    };
    next.onmessage = (event) => {
      inbound = inbound
        .then(() => handleMessage(next, event.data))
        .catch((cause: unknown) => {
          report("message_handling_failed", {
            connectionAttempt: attempt,
            causeType: cause instanceof Error ? cause.name : typeof cause,
          });
          handleClosed(next, "messageHandlingFailed");
          next.close();
        });
    };
    next.onerror = (event) => {
      report("socket_error", {
        connectionAttempt: attempt,
        eventType: event?.type,
      });
      handleClosed(next, "socketError");
    };
    next.onclose = (event) => handleClosed(next, "socketClose", event);
  };

  const handleMessage = async (source: DataSocket, data: unknown) => {
    if (socket !== source || detached) return;
    const bytes = await dataSocketMessageBytes(data);
    if (!authenticated) {
      const response = new TextDecoder().decode(bytes);
      if (response === "TLAUTH") {
        report("authentication_refused", { connectionAttempt });
        failFirst("Terminal credential was refused.", "credentialRefused");
        return;
      }
      if (response !== "TLOK") {
        report("authentication_response_ignored", {
          connectionAttempt,
          responseBytes: bytes.byteLength,
        });
        return;
      }
      clearAuthenticationTimer();
      authenticated = true;
      clearStabilityTimer();
      stabilityTimer = setTimeout(() => {
        if (socket !== source || !authenticated || detached) return;
        reconnectDelay = MIN_RECONNECT_MS;
        report("connection_stabilized", { connectionAttempt, stableForMs: STABLE_CONNECTION_MS });
      }, STABLE_CONNECTION_MS);
      if (successfulConnections > 0) onEvent({ type: "reset" });
      successfulConnections += 1;
      report("authenticated", {
        connectionAttempt,
        successfulConnections,
        reconnected: successfulConnections > 1,
      });
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
      report("invalid_frame_ignored", {
        connectionAttempt,
        bytes: bytes.byteLength,
      });
      return;
    }
    if (frame.sessionId !== session.id || frame.epoch !== session.runtime_epoch) {
      report("stale_frame_ignored", {
        connectionAttempt,
        sessionMatched: frame.sessionId === session.id,
        epochMatched: frame.epoch === session.runtime_epoch,
        frameKind: frame.kind,
      });
      return;
    }
    if (frame.kind === KIND_REPLAY_OUTPUT) {
      queueReplay(frame.payload);
      return;
    }
    /// Any non-replay frame is an ordering boundary. The frozen replay must be
    /// visible before a following gap, live byte, or exit state.
    flushReplay();
    if (frame.kind === KIND_OUTPUT) onEvent({ type: "live", bytes: frame.payload });
    else if (frame.kind === KIND_GAP) {
      const droppedFrames = decodeGapCount(frame.payload);
      report("output_gap", { connectionAttempt, droppedFrames });
      onEvent({ type: "gap", droppedFrames });
    } else if (frame.kind === KIND_EOF) {
      report("terminal_eof", { connectionAttempt });
      onEvent({ type: "eof" });
    } else if (frame.kind === KIND_ERROR) {
      report("server_frame_error", {
        connectionAttempt,
        errorBytes: frame.payload.byteLength,
      });
      source.close();
    } else if (frame.kind === KIND_ACK) return;
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
        report("input_send_failed", {
          connectionAttempt,
          inputBytes: bytes.byteLength,
          causeType: cause instanceof Error ? cause.name : typeof cause,
        });
        handleClosed(target, "inputSendFailed");
        target.close();
        throw cause;
      }
    },
    reconnect() {
      if (detached) return Promise.reject(new Error("Terminal is detached."));
      report("forced_reconnect_started", {
        connectionAttempt,
        authenticated,
        successfulConnections,
        reconnectWaiters: reconnectWaiters.size + 1,
      });
      const waiting = new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timeout: setTimeout(() => {
            reconnectWaiters.delete(waiter);
            report("forced_reconnect_timeout", {
              connectionAttempt,
              reconnectWaiters: reconnectWaiters.size,
            });
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
      clearStabilityTimer();
      discardReplay();
      onEvent({ type: "state", state: "connectionLost" });
      stale?.close();
      connect();
      return waiting;
    },
    async detach() {
      if (detached) return;
      report("attachment_detached", {
        connectionAttempt,
        authenticated,
        successfulConnections,
        reconnectWaiters: reconnectWaiters.size,
      });
      detached = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      clearConnectionTimer();
      clearAuthenticationTimer();
      clearStabilityTimer();
      discardReplay();
      settleReconnectWaiters(new Error("Terminal is detached."));
      socket?.close();
      socket = undefined;
    },
  };
}

async function launchResult(
  session: { id: string; runtime_epoch: number },
  prompt: string | undefined,
  attach: (
    session: { id: string; runtime_epoch: number },
    onEvent: (event: TerminalEvent) => void,
  ) => Promise<TerminalAttachment>,
): Promise<{ sessionId: string; runtimeEpoch: number; promptSubmitted: boolean | null }> {
  const content = prompt === undefined ? undefined : launchPrompt(prompt);
  if (content === undefined) {
    return { sessionId: session.id, runtimeEpoch: session.runtime_epoch, promptSubmitted: null };
  }

  let attachment: TerminalAttachment | undefined;
  try {
    attachment = await attach(session, () => {});
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

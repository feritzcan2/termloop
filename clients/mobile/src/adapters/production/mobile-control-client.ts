import type {
  AgentCapabilityDto,
  AgentLaunchPreviewResult,
  AgentStatusDto,
  CompanionProposalRespondResult,
  CompanionSuggestionAcceptResult,
  CompanionTranscriptAppendResult,
  CompanionTranscriptListResult,
  PlaybookGetResult,
  PlaybookRuntimeResult,
  PlaybookTaskPositionSetResult,
  ProjectDto,
  RoutineConfigurationListResult,
  RoutineRunNowResult,
  SessionLaunchAgentResult,
  SessionRenameResult,
  SessionDto,
  SocketFactory,
  TaskDto,
  TaskLaunchAgentResult,
  TaskPageDto,
  TaskWorktreeChangeListResult,
  TaskWorktreeDiffResult,
  TaskWorktreePreImageResult,
} from "@termloop/contract/current";
import { validateMethodResult } from "@termloop/contract/current";

export const MOBILE_API_VERSION = 1 as const;

type MobileControlMethod =
  | "system.version"
  | "project.list"
  | "session.list"
  | "agent.statusList"
  | "agent.capabilityList"
  | "task.list"
  | "task.worktreeChangeList"
  | "task.worktreeDiff"
  | "task.worktreePreImage"
  | "playbook.get"
  | "playbook.runtime"
  | "playbook.taskPositionSet"
  | "routine.configurationList"
  | "routine.runNow"
  | "task.previewAgent"
  | "task.launchAgent"
  | "session.previewAgent"
  | "session.launchAgent"
  | "session.rename"
  | "companion.transcriptList"
  | "companion.transcriptAppend"
  | "companion.suggestionAccept"
  | "companion.proposalRespond";

interface MobileControlResults {
  "system.version": { product: string; version: string; protocolVersion: string };
  "project.list": ProjectDto[];
  "session.list": SessionDto[];
  "agent.statusList": AgentStatusDto[];
  "agent.capabilityList": AgentCapabilityDto[];
  "task.list": TaskPageDto;
  "task.worktreeChangeList": TaskWorktreeChangeListResult;
  "task.worktreeDiff": TaskWorktreeDiffResult;
  "task.worktreePreImage": TaskWorktreePreImageResult;
  "playbook.get": PlaybookGetResult;
  "playbook.runtime": PlaybookRuntimeResult;
  "playbook.taskPositionSet": PlaybookTaskPositionSetResult;
  "routine.configurationList": RoutineConfigurationListResult;
  "routine.runNow": RoutineRunNowResult;
  "task.previewAgent": AgentLaunchPreviewResult;
  "task.launchAgent": TaskLaunchAgentResult;
  "session.previewAgent": AgentLaunchPreviewResult;
  "session.launchAgent": SessionLaunchAgentResult;
  "session.rename": SessionRenameResult;
  "companion.transcriptList": CompanionTranscriptListResult;
  "companion.transcriptAppend": CompanionTranscriptAppendResult;
  "companion.suggestionAccept": CompanionSuggestionAcceptResult;
  "companion.proposalRespond": CompanionProposalRespondResult;
}

const REQUEST_TIMEOUT_MS = 5_000;
/// Starting an Agent provisions a checkout and waits for the provider to come up,
/// so it cannot answer inside the read budget every other call lives in. The
/// longer window is per method rather than global: a slow read still fails fast.
const SLOW_METHOD_TIMEOUT_MS: Partial<Record<MobileControlMethod, number>> = {
  "task.previewAgent": 30_000,
  "task.launchAgent": 120_000,
  "session.previewAgent": 30_000,
  "session.launchAgent": 120_000,
  "routine.runNow": 120_000,
  "companion.transcriptAppend": 20_000,
  "companion.suggestionAccept": 20_000,
  "companion.proposalRespond": 20_000,
  "playbook.taskPositionSet": 20_000,
};
const MAX_REQUESTS_IN_FLIGHT = 32;

interface PendingMobileCall {
  readonly method: MobileControlMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class MobileControlError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message);
    this.name = "MobileControlError";
  }
}

/// A deliberately small, stable protocol terminated by the Mac-side mobile gateway.
/// It does not send the app's generated contract identity: the gateway reads the
/// daemon's current identity and performs only its exact allowlisted method set.
export class MobileControlClient {
  private counter = 0;
  private generation = 0;
  private socket: ReturnType<SocketFactory> | undefined;
  private connecting: Promise<ReturnType<SocketFactory>> | undefined;
  private readonly pending = new Map<string, PendingMobileCall>();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly socketFactory: SocketFactory,
  ) {}

  version() {
    return this.call("system.version");
  }

  async call<M extends MobileControlMethod>(
    method: M,
    params: Record<string, unknown> = {},
  ): Promise<MobileControlResults[M]> {
    if (this.pending.size >= MAX_REQUESTS_IN_FLIGHT) {
      throw new MobileControlError("Too many mobile control requests are in flight.", "serviceBusy");
    }
    const id = String(++this.counter);
    return await new Promise<MobileControlResults[M]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error("request timeout"));
      }, SLOW_METHOD_TIMEOUT_MS[method] ?? REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      void Promise.resolve().then(() => this.connected()).then((socket) => {
        if (!this.pending.has(id)) return;
        try {
          socket.send(JSON.stringify({
            id,
            mobileApiVersion: MOBILE_API_VERSION,
            token: this.token,
            method,
            params,
          }));
        } catch {
          socket.close();
          this.disconnect(this.generation, new Error("connection failed"));
        }
      }).catch(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(new Error("connection failed"));
      });
    });
  }

  close(): void {
    const socket = this.socket;
    this.generation += 1;
    this.socket = undefined;
    this.connecting = undefined;
    this.rejectPending(new Error("connection closed"));
    socket?.close();
  }

  private connected(): Promise<ReturnType<SocketFactory>> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    const socket = this.socketFactory(this.url);
    const connecting = new Promise<ReturnType<SocketFactory>>((resolve, reject) => {
      let opened = false;
      socket.addEventListener("open", () => {
        if (generation !== this.generation) {
          socket.close();
          reject(new Error("connection superseded"));
          return;
        }
        opened = true;
        this.socket = socket;
        this.connecting = undefined;
        resolve(socket);
      }, { once: true });
      socket.addEventListener("message", (event) => this.receive(generation, event));
      socket.addEventListener("error", () => {
        if (!opened) reject(new Error("connection failed"));
        this.disconnect(generation, new Error("connection failed"));
        socket.close();
      }, { once: true });
      socket.addEventListener("close", () => {
        if (!opened) reject(new Error("connection closed"));
        this.disconnect(generation, new Error("connection closed"));
      }, { once: true });
    });
    this.connecting = connecting;
    return connecting;
  }

  private receive(generation: number, event: { data: unknown }): void {
    if (generation !== this.generation) return;
    let response: unknown;
    try {
      response = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      const socket = this.socket;
      this.disconnect(generation, new Error("invalid mobile gateway response"));
      socket?.close();
      return;
    }
    if (!isRecord(response)) {
      const socket = this.socket;
      this.disconnect(generation, new Error("invalid mobile gateway response"));
      socket?.close();
      return;
    }
    if (typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.ok !== true) {
      const error = isRecord(response.error) ? response.error : undefined;
      const message = typeof error?.message === "string" ? error.message : "request failed";
      const code = typeof error?.code === "string" ? error.code : undefined;
      pending.reject(new MobileControlError(message, code));
      return;
    }
    try {
      pending.resolve(decodeResult(pending.method, response.result));
    } catch (cause) {
      pending.reject(cause instanceof Error ? cause : new Error("invalid mobile gateway response"));
    }
  }

  private disconnect(generation: number, error: Error): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.socket = undefined;
    this.connecting = undefined;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
  }
}

function decodeResult<M extends MobileControlMethod>(
  method: M,
  value: unknown,
): MobileControlResults[M] {
  switch (method) {
    case "system.version": {
      if (!isRecord(value) || typeof value.product !== "string"
        || typeof value.version !== "string" || typeof value.protocolVersion !== "string") {
        throw incompatible(method);
      }
      return value as MobileControlResults[M];
    }
    case "project.list":
      return readRows<ProjectDto>(value, method, (row) =>
        typeof row.id === "string" && typeof row.name === "string") as MobileControlResults[M];
    case "session.list":
      return readRows<SessionDto>(value, method, (row) =>
        typeof row.id === "string" && typeof row.project_id === "string"
        && typeof row.kind === "string" && typeof row.lifecycle_state === "string"
        && typeof row.runtime_epoch === "number") as MobileControlResults[M];
    case "agent.statusList":
      return readRows<AgentStatusDto>(value, method, (row) =>
        typeof row.sessionId === "string" && typeof row.status === "string") as MobileControlResults[M];
    case "task.list": {
      if (!isRecord(value) || !Array.isArray(value.items)
        || !(value.next_cursor === null || typeof value.next_cursor === "string")) {
        throw incompatible(method);
      }
      const items = readRows<TaskDto>(value.items, method, (row) =>
        typeof row.id === "string" && typeof row.project_id === "string"
        && typeof row.title === "string" && typeof row.status === "string");
      return { items, next_cursor: value.next_cursor } as MobileControlResults[M];
    }
    case "task.worktreeChangeList": {
      if (!isRecord(value) || typeof value.task_id !== "string"
        || typeof value.observation_id !== "string" || typeof value.worktree_generation !== "number"
        || typeof value.truncated !== "boolean"
        || !Array.isArray(value.entries) || !value.entries.every(validWorktreeChangeEntry)) {
        throw incompatible(method);
      }
      return value as MobileControlResults[M];
    }
    case "task.worktreeDiff": {
      if (!isRecord(value) || typeof value.task_id !== "string"
        || typeof value.observation_id !== "string" || typeof value.entry_id !== "string"
        || !isWorktreeDiffState(value.state)
        || !(value.patch === null || typeof value.patch === "string")) {
        throw incompatible(method);
      }
      return value as MobileControlResults[M];
    }
    case "task.worktreePreImage": {
      if (!isRecord(value) || typeof value.task_id !== "string"
        || typeof value.observation_id !== "string" || typeof value.entry_id !== "string"
        || !isWorktreePreImageState(value.state)
        || !(value.revision === "index" || value.revision === "head")
        || !(value.content === null || typeof value.content === "string")) {
        throw incompatible(method);
      }
      return value as MobileControlResults[M];
    }
    case "agent.capabilityList":
      if (!validateMethodResult(method, value)) throw incompatible(method);
      return value as MobileControlResults[M];
    case "playbook.get": {
      // A Project with no pipeline answers `playbook: null`, which is a fact
      // rather than a malformed projection.
      if (!isRecord(value) || typeof value.stateRevision !== "number"
        || !(value.playbook === null || validPlaybook(value.playbook))) {
        throw incompatible(method);
      }
      return value as MobileControlResults[M];
    }
    case "playbook.runtime": {
      if (!isRecord(value) || typeof value.activePipelineName !== "string"
        || !(value.processingTaskId === null || typeof value.processingTaskId === "string")
        || typeof value.stateRevision !== "number"
        || !Array.isArray(value.doneTaskIds) || !value.doneTaskIds.every((id) => typeof id === "string")
        || !Array.isArray(value.steps) || !value.steps.every(validRuntimeStep)) {
        throw incompatible(method);
      }
      return value as MobileControlResults[M];
    }
    case "playbook.taskPositionSet": {
      if (!isRecord(value) || typeof value.stateRevision !== "number") throw incompatible(method);
      return value as MobileControlResults[M];
    }
    case "routine.configurationList": {
      if (!isRecord(value) || typeof value.stateRevision !== "number") throw incompatible(method);
      readRows(value.configurations, method, (row) =>
        typeof row.id === "string" && typeof row.name === "string" && typeof row.enabled === "boolean");
      return value as MobileControlResults[M];
    }
    case "routine.runNow":
      // An observation result carries no field this client reads, so anything
      // well-formed is accepted rather than pinned to a shape it never uses.
      return value as MobileControlResults[M];
    case "task.previewAgent":
    case "session.previewAgent": {
      if (!isRecord(value) || typeof value.launch_ticket !== "string"
        || !isRecord(value.manifest) || !isRecord(value.manifest.target)
        || typeof value.manifest.target.executable !== "string"
        || typeof value.manifest.target.cwd !== "string"
        || !Array.isArray(value.manifest.arguments)) {
        throw incompatible(method);
      }
      return value as MobileControlResults[M];
    }
    case "task.launchAgent":
    case "session.launchAgent":
    case "session.rename": {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.project_id !== "string") {
        throw incompatible(method);
      }
      return value as MobileControlResults[M];
    }
    case "companion.transcriptList": {
      if (!isRecord(value) || typeof value.stateRevision !== "number") throw incompatible(method);
      readRows(value.messages, method, validCompanionMessage);
      return value as MobileControlResults[M];
    }
    case "companion.transcriptAppend":
    case "companion.suggestionAccept":
    case "companion.proposalRespond": {
      if (!isRecord(value) || !isRecord(value.message) || !validCompanionMessage(value.message)) {
        throw incompatible(method);
      }
      return value as MobileControlResults[M];
    }
  }
}

function validCompanionMessage(row: Record<string, unknown>): boolean {
  return typeof row.id === "string"
    && typeof row.projectId === "string"
    && typeof row.sequence === "number"
    && typeof row.author === "string"
    && typeof row.kind === "string"
    && typeof row.content === "string"
    && typeof row.createdAtEpochMs === "number";
}

function validWorktreeChangeEntry(row: unknown): boolean {
  return isRecord(row)
    && typeof row.entry_id === "string" && typeof row.display_path === "string"
    && (row.original_display_path === null || typeof row.original_display_path === "string")
    && (row.path_encoding === "utf8" || row.path_encoding === "lossy")
    && (row.side === "staged" || row.side === "unstaged" || row.side === "untracked")
    && (row.kind === "modified" || row.kind === "added" || row.kind === "deleted"
      || row.kind === "renamed" || row.kind === "copied" || row.kind === "unmerged" || row.kind === "untracked")
    && (row.render_state === "available" || row.render_state === "notShown");
}

function isWorktreeDiffState(value: unknown): boolean {
  return value === "patch" || value === "binary" || value === "notShown"
    || value === "truncated" || value === "nonUtf8";
}

function isWorktreePreImageState(value: unknown): boolean {
  return value === "content" || value === "absent" || value === "binary"
    || value === "notShown" || value === "truncated" || value === "nonUtf8";
}

function validPlaybook(value: unknown): boolean {
  return isRecord(value)
    && typeof value.projectId === "string"
    && typeof value.revision === "number"
    && typeof value.activePipelineName === "string"
    && Array.isArray(value.milestones)
    && value.milestones.every((milestone) => isRecord(milestone)
      && typeof milestone.id === "string"
      && typeof milestone.title === "string"
      && typeof milestone.gate === "string"
      && typeof milestone.routineId === "string");
}

function validRuntimeStep(value: unknown): boolean {
  return isRecord(value)
    && typeof value.milestoneId === "string"
    && Array.isArray(value.waitingTaskIds)
    && value.waitingTaskIds.every((id) => typeof id === "string")
    && Array.isArray(value.progress)
    && value.progress.every((entry) => isRecord(entry)
      && typeof entry.taskId === "string"
      && typeof entry.verdict === "string"
      && typeof entry.evidence === "string"
      && typeof entry.decidedAtEpochMs === "number");
}

function readRows<T>(
  value: unknown,
  method: MobileControlMethod,
  valid: (row: Record<string, unknown>) => boolean,
): T[] {
  if (!Array.isArray(value) || !value.every((row) => isRecord(row) && valid(row))) {
    throw incompatible(method);
  }
  return value as T[];
}

function incompatible(method: MobileControlMethod) {
  return new MobileControlError(
    `The ${method} projection changed in a way this mobile build cannot read.`,
    "incompatibleProjection",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

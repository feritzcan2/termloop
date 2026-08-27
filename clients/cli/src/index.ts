#!/usr/bin/env node
import {
  TermLoopControlClient,
  TermLoopControlError,
  type AccessDeviceRevokeParams,
  type AccessEnableParams,
  type AccessPairCreateParams,
  type EmptyParams,
  type Method,
  type GitHostPullRequestListParams,
  type GitHostTaskProjectionDto,
  type ProjectCreateParams,
  type ProjectDeleteParams,
  type ProjectUpdateDetailsParams,
  type ProjectIdParams,
  type SessionArchiveParams,
  type SessionLaunchAgentParams,
  type SessionLaunchTerminalParams,
  type SessionRenameParams,
  type SessionResumeAgentParams,
  type SessionCloseParams,
  type SessionForkAgentParams,
  type SessionTerminateParams,
  type TaskBindBranchParams,
  type TaskCleanupWorktreeParams,
  type TaskWorktreeCleanupBlocker,
  type TaskInspectWorktreeCleanupParams,
  type TaskProvisionWorktreeParams,
  type TaskListParams,
  type TaskIdParams,
  type TaskArchiveParams,
  type TaskArchiveAbandonParams,
} from "@termloop/contract/current";
import WebSocket from "ws";
import { defaultRuntimeFile, readDiscovery } from "./platform/discovery.js";
import { runDaemonService, type DaemonServiceAction } from "./platform/daemon-service.js";
import { isMainModule } from "./platform/main-module.js";

type ServiceCommand = `service-${DaemonServiceAction}`;
type CliCommand = "version" | "capabilities" | "ping" | "access-status" | "access-enable" | "access-disable" | "access-pair" | "access-list" | "access-revoke" | ServiceCommand | "project-create" | "project-list" | "project-update" | "project-delete" | "pr-list" | "task-list" | "task-inspect-archive" | "task-archive" | "task-abandon-archive" | "task-restore" | "task-archived-context" | "task-bind-branch" | "task-provision-worktree" | "task-inspect-cleanup" | "task-cleanup" | "terminal-launch" | "agent-launch" | "session-list" | "session-list-archived" | "session-inspect-archive" | "session-archive" | "session-restore-archived" | "session-delete-archived" | "session-rename" | "session-terminate" | "session-resume" | "session-fork" | "session-close";
type CliBase = {
  json: boolean;
  url: string | undefined;
  token: string | undefined;
  runtimeFile: string;
};
export type CliOptions =
  | (CliBase & { command: ServiceCommand; params: { serverBinary?: string } })
  | (CliBase & { command: "version" | "capabilities" | "ping" | "access-status" | "access-disable" | "access-list" | "project-list" | "session-list"; params: EmptyParams })
  | (CliBase & { command: "access-enable"; params: AccessEnableParams })
  | (CliBase & { command: "access-pair"; params: AccessPairCreateParams })
  | (CliBase & { command: "access-revoke"; params: AccessDeviceRevokeParams })
  | (CliBase & { command: "project-create"; params: ProjectCreateParams })
  | (CliBase & { command: "project-update"; params: ProjectUpdateDetailsParams })
  | (CliBase & { command: "project-delete"; params: ProjectDeleteParams })
  | (CliBase & { command: "pr-list"; params: Omit<GitHostPullRequestListParams, "taskIds"> & { taskIds?: string[] } })
  | (CliBase & { command: "task-list"; params: TaskListParams })
  | (CliBase & { command: "task-inspect-archive" | "task-restore" | "task-archived-context"; params: TaskIdParams })
  | (CliBase & { command: "task-archive"; params: TaskArchiveParams })
  | (CliBase & { command: "task-abandon-archive"; params: TaskArchiveAbandonParams })
  | (CliBase & { command: "task-bind-branch"; params: TaskBindBranchParams })
  | (CliBase & { command: "task-provision-worktree"; params: TaskProvisionWorktreeParams })
  | (CliBase & { command: "task-inspect-cleanup"; params: TaskInspectWorktreeCleanupParams })
  | (CliBase & { command: "task-cleanup"; params: TaskCleanupWorktreeParams })
  | (CliBase & { command: "terminal-launch"; params: SessionLaunchTerminalParams })
  | (CliBase & { command: "agent-launch"; params: SessionLaunchAgentParams })
  | (CliBase & { command: "session-list-archived"; params: ProjectIdParams })
  | (CliBase & { command: "session-inspect-archive" | "session-restore-archived" | "session-delete-archived"; params: SessionCloseParams })
  | (CliBase & { command: "session-archive"; params: SessionArchiveParams })
  | (CliBase & { command: "session-rename"; params: SessionRenameParams })
  | (CliBase & { command: "session-resume"; params: SessionResumeAgentParams })
  | (CliBase & { command: "session-fork"; params: SessionForkAgentParams })
  | (CliBase & { command: "session-close"; params: SessionCloseParams })
  | (CliBase & { command: "session-terminate"; params: SessionTerminateParams });

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const json = argv.includes("--json");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const command = ((positional[0] === "access" || positional[0] === "service") && positional[1]
    ? `${positional[0]}-${positional[1]}`
    : positional[0]) as CliCommand | undefined;
  const commands: CliCommand[] = ["version", "capabilities", "ping", "access-status", "access-enable", "access-disable", "access-pair", "access-list", "access-revoke", "service-install", "service-start", "service-stop", "service-status", "service-uninstall", "project-create", "project-list", "project-update", "project-delete", "pr-list", "task-list", "task-inspect-archive", "task-archive", "task-abandon-archive", "task-restore", "task-archived-context", "task-bind-branch", "task-provision-worktree", "task-inspect-cleanup", "task-cleanup", "terminal-launch", "agent-launch", "session-list", "session-list-archived", "session-inspect-archive", "session-archive", "session-restore-archived", "session-delete-archived", "session-rename", "session-terminate", "session-resume", "session-fork", "session-close"];
  if (!command || !commands.includes(command)) {
    throw new Error("usage: termloopctl <version|capabilities|ping|access <status|enable|disable|pair|list|revoke>|service <install|start|stop|status|uninstall>|project-create|project-list|project-update|project-delete|pr-list|task-list|task-inspect-archive|task-archive|task-abandon-archive|task-restore|task-archived-context|task-bind-branch|task-provision-worktree|task-inspect-cleanup|task-cleanup|terminal-launch|agent-launch|session-list|session-list-archived|session-inspect-archive|session-archive|session-restore-archived|session-delete-archived|session-rename|session-terminate|session-resume|session-fork|session-close> [options]");
  }
  const option = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const url = option("--url") ?? env.TERMLOOP_CONTROL_URL;
  const token = env.TERMLOOP_TOKEN;
  const runtimeFile = option("--runtime") ?? defaultRuntimeFile(env);
  const required = (name: string) => option(name) ?? (() => { throw new Error(`missing ${name}`); })();
  const base = { json, url, token, runtimeFile };
  if (command.startsWith("service-")) {
    const serverBinary = option("--server");
    if (command !== "service-install" && serverBinary) throw new Error("--server is valid only for service install");
    return { ...base, command: command as ServiceCommand, params: { ...(serverBinary ? { serverBinary } : {}) } };
  }
  if (command === "access-enable") {
    const rawPort = option("--port");
    const port = rawPort === undefined ? undefined : Number(rawPort);
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 1024 || port > 65535)) throw new Error("--port must be an integer between 1024 and 65535");
    return { ...base, command, params: { ...(port === undefined ? {} : { port }) } };
  }
  if (command === "access-pair") {
    const scope = option("--scope") ?? "full";
    if (scope !== "full" && scope !== "readOnly") throw new Error("--scope must be full or readOnly");
    return { ...base, command, params: { name: required("--name"), scope } };
  }
  if (command === "access-revoke") return { ...base, command, params: { deviceId: required("--device") } };
  if (command === "project-create") return { ...base, command, params: { name: required("--name"), folderPath: required("--folder") } };
  if (command === "project-update") return { ...base, command, params: { projectId: required("--project"), name: required("--name"), folderPath: required("--folder") } };
  if (command === "project-delete") return { ...base, command, params: { projectId: required("--project") } };
  if (command === "pr-list") {
    const repeatedTaskIds = argv.flatMap<string>((value, index) => {
      const taskId = argv[index + 1];
      return value === "--task" && taskId ? [taskId] : [];
    });
    const taskIds = [
      ...repeatedTaskIds,
      ...(option("--tasks")?.split(",") ?? []),
    ].map((value) => value.trim()).filter(Boolean);
    const explicitTaskIds = taskIds.length > 0 ? taskIds : undefined;
    if (explicitTaskIds && new Set(explicitTaskIds).size !== explicitTaskIds.length) {
      throw new Error("--task/--tasks require unique Task IDs");
    }
    return { ...base, command, params: { projectId: required("--project"), ...(explicitTaskIds ? { taskIds: explicitTaskIds } : {}) } };
  }
  if (command === "task-list") {
    const archiveScope = option("--archive-scope") ?? "active";
    if (!(["active", "archived", "all"] as const).includes(archiveScope as "active" | "archived" | "all")) throw new Error("--archive-scope must be active, archived, or all");
    return { ...base, command, params: { projectId: required("--project"), archiveScope: archiveScope as "active" | "archived" | "all" } };
  }
  if (command === "task-inspect-archive" || command === "task-restore" || command === "task-archived-context") return { ...base, command, params: { taskId: required("--task") } };
  if (command === "task-archive") return { ...base, command, params: { taskId: required("--task"), operationId: required("--operation"), archiveTicket: required("--ticket") } };
  if (command === "task-abandon-archive") return { ...base, command, params: { taskId: required("--task"), operationId: required("--operation") } };
  if (command === "task-bind-branch") return { ...base, command, params: { taskId: required("--task"), repositoryPath: required("--repository"), branchName: required("--branch") } };
  if (command === "task-provision-worktree") {
    const branchMode = required("--mode");
    if (branchMode !== "existing" && branchMode !== "create") throw new Error("--mode must be existing or create");
    const baseRef = option("--base-ref");
    return {
      ...base,
      command,
      params: {
        operationId: required("--operation"),
        taskId: required("--task"),
        repositoryPath: required("--repository"),
        destinationPath: required("--destination"),
        branchName: required("--branch"),
        branchMode,
        ...(baseRef ? { baseRef } : {}),
      },
    };
  }
  if (command === "task-inspect-cleanup") return { ...base, command, params: { taskId: required("--task") } };
  if (command === "task-cleanup") {
    const generation = Number(required("--generation"));
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("--generation must be a positive integer");
    const discard = argv.includes("--discard-content");
    const acknowledged = option("--acknowledge")?.split(",").filter(Boolean) ?? [];
    const eligible = new Set<TaskWorktreeCleanupBlocker>(["trackedChanges", "stagedChanges", "untrackedContent", "ignoredContent", "submodulePresent"]);
    if ((!discard && acknowledged.length > 0) || (discard && acknowledged.length === 0)) {
      throw new Error("--discard-content requires --acknowledge with the exact comma-separated content blockers");
    }
    if (new Set(acknowledged).size !== acknowledged.length || acknowledged.some((value) => !eligible.has(value as TaskWorktreeCleanupBlocker))) {
      throw new Error("--acknowledge accepts unique trackedChanges, stagedChanges, untrackedContent, ignoredContent, or submodulePresent values");
    }
    return {
      ...base,
      command,
      params: {
        operationId: required("--operation"),
        taskId: required("--task"),
        expectedManagedWorktreeOperationId: required("--proof"),
        expectedWorktreeGeneration: generation,
        cleanupMode: discard ? "discardCheckoutContent" : "safe",
        acknowledgedContentBlockers: acknowledged as TaskWorktreeCleanupBlocker[],
      },
    };
  }
  if (command === "terminal-launch") return { ...base, command, params: { projectId: required("--project"), cwd: required("--cwd") } };
  if (command === "agent-launch") return { ...base, command, params: { projectId: required("--project"), cwd: required("--cwd"), agentId: required("--agent"), launchTicket: required("--ticket") } };
  if (command === "session-list-archived") return { ...base, command, params: { projectId: required("--project") } };
  if (command === "session-inspect-archive" || command === "session-restore-archived" || command === "session-delete-archived") return { ...base, command, params: { sessionId: required("--session") } };
  if (command === "session-archive") return { ...base, command, params: { sessionId: required("--session"), operationId: required("--operation"), archiveTicket: required("--ticket") } };
  if (command === "session-rename") return { ...base, command, params: { sessionId: required("--session"), name: argv.includes("--clear") ? null : required("--name") } };
  if (command === "session-terminate") return { ...base, command, params: { sessionId: required("--session") } };
  if (command === "session-resume") return { ...base, command, params: { sessionId: required("--session"), launchTicket: required("--ticket") } };
  if (command === "session-fork") return { ...base, command, params: { sessionId: required("--session") } };
  if (command === "session-close") return { ...base, command, params: { sessionId: required("--session") } };
  return { ...base, command, params: {} };
}

export function methodFor(command: CliOptions["command"]): Method {
  const methods: Partial<Record<CliOptions["command"], Method>> = {
    version: "system.version", capabilities: "system.capabilities", ping: "system.ping",
    "access-status": "access.status", "access-enable": "access.enable", "access-disable": "access.disable", "access-pair": "access.pairCreate", "access-list": "access.deviceList", "access-revoke": "access.deviceRevoke",
    "project-create": "project.create", "project-list": "project.list", "project-update": "project.updateDetails", "project-delete": "project.delete", "terminal-launch": "session.launchTerminal",
    "pr-list": "gitHost.pullRequestList",
    "task-list": "task.list",
    "task-inspect-archive": "task.inspectArchive",
    "task-archive": "task.archive",
    "task-abandon-archive": "task.abandonArchive",
    "task-restore": "task.restore",
    "task-archived-context": "task.archivedContext",
    "task-bind-branch": "task.bindBranch",
    "task-provision-worktree": "task.provisionWorktree",
    "task-inspect-cleanup": "task.inspectWorktreeCleanup",
    "task-cleanup": "task.cleanupWorktree",
    "agent-launch": "session.launchAgent", "session-list": "session.list", "session-list-archived": "session.listArchived", "session-inspect-archive": "session.inspectArchive", "session-archive": "session.archive", "session-restore-archived": "session.restoreArchived", "session-delete-archived": "session.deleteArchived", "session-rename": "session.rename", "session-terminate": "session.terminate", "session-resume": "session.resumeAgent", "session-fork": "session.forkAgent", "session-close": "session.close"
  };
  const method = methods[command];
  if (!method) throw new Error(`${command} is a local service command`);
  return method;
}

export async function run(options: CliOptions): Promise<void> {
  if (isServiceOptions(options)) {
    const result = await runDaemonService(
      options.command.slice("service-".length) as DaemonServiceAction,
      options.params.serverBinary,
    );
    console.log(options.json ? JSON.stringify(result) : formatHumanOutput(options.command, result));
    return;
  }
  const discovery = options.url && options.token ? undefined : await readDiscovery(options.runtimeFile);
  const client = new TermLoopControlClient(options.url ?? discovery!.controlUrl, options.token ?? discovery!.token, (url) => new WebSocket(url) as never);
  try {
    const result = await callForOptions(client, options);
    if (options.json) console.log(JSON.stringify(result));
    else if (options.command === "ping") console.log("pong");
    else console.log(formatHumanOutput(options.command, result));
  } finally {
    client.close();
  }
}

function isServiceOptions(options: CliOptions): options is Extract<CliOptions, { command: ServiceCommand }> {
  return options.command.startsWith("service-");
}

export function formatHumanOutput(command: CliOptions["command"], result: unknown): string {
  if ((command === "access-status" || command === "access-enable") && isRecord(result)) {
    const enabled = result.enabled === true;
    const listening = result.listening === true;
    const port = typeof result.port === "number" ? result.port : undefined;
    const lines = [
      `Access plane: ${enabled ? (listening ? "enabled and listening" : "enabled but unavailable") : "disabled"}`,
    ];
    if (port) {
      lines.push(`Loopback endpoint: ws://127.0.0.1:${port}`);
      lines.push(`Tailscale: configure Serve to proxy http://127.0.0.1:${port}, then use its wss:// tailnet URL in the desktop profile.`);
      lines.push(`SSH: use a desktop SSH profile for this host with remote access port ${port}; TermLoop supervises the strict loopback tunnel.`);
    }
    if (typeof result.server_fingerprint === "string") lines.push(`Server fingerprint: ${result.server_fingerprint}`);
    if (typeof result.error === "string") lines.push(`Error: ${result.error}`);
    return lines.join("\n");
  }
  if (command === "access-pair" && isRecord(result)) {
    return [
      `Pairing code: ${String(result.pairing_code ?? "unavailable")}`,
      `Server fingerprint: ${String(result.server_fingerprint ?? "unavailable")}`,
      `Expires at (epoch ms): ${String(result.expires_at_epoch_ms ?? "unavailable")}`,
      `Listener: ${String(result.access_url ?? "unavailable")}`,
      "Verify the fingerprint in the desktop before the one-time code is sent.",
    ].join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function controlErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof TermLoopControlError) || !error.details) return message;
  switch (error.details.kind) {
    case "branchHeldByTask": return `${message} (held by Task ${error.details.taskId})`;
    case "taskBranchAlreadyBound": return `${message} (Task ${error.details.taskId})`;
    case "worktreePathHeldByTask": return `${message} (path held by Task ${error.details.taskId})`;
    case "provisioningAlreadyInProgress":
    case "operationIdReused":
    case "worktreeRecoveryAttention": return `${message} (operation ${error.details.operationId})`;
    case "branchCheckedOutElsewhere": return `${message} (checkout ${error.details.worktreePath})`;
    case "taskWorktreeCleanupRequired": return `${message} (Task ${error.details.taskId})`;
    case "cleanupInProgress": return `${message} (operation ${error.details.operationId})`;
    case "worktreeCleanupRefused": return `${message} (${error.details.blockers.join(", ")})`;
    case "managedWorktreeProofChanged": return `${message} (current generation ${error.details.currentWorktreeGeneration})`;
    case "worktreeCleanupRecoveryAttention": return `${message} (operation ${error.details.operationId})`;
  }
  return message;
}

async function callForOptions(client: TermLoopControlClient, options: CliOptions): Promise<unknown> {
  switch (options.command) {
    case "service-install":
    case "service-start":
    case "service-stop":
    case "service-status":
    case "service-uninstall": throw new Error("service commands do not use the control plane");
    case "version": return client.version();
    case "capabilities": return client.capabilities();
    case "ping": return client.ping();
    case "access-status": return client.call("access.status");
    case "access-enable": return client.call("access.enable", options.params);
    case "access-disable": return client.call("access.disable");
    case "access-pair": return client.call("access.pairCreate", options.params);
    case "access-list": return client.call("access.deviceList");
    case "access-revoke": return client.call("access.deviceRevoke", options.params);
    case "project-create": return client.call("project.create", options.params);
    case "project-list": return client.call("project.list");
    case "project-update": return client.call("project.updateDetails", options.params);
    case "project-delete": return client.call("project.delete", options.params);
    case "pr-list": {
      const taskIds = options.params.taskIds
        ?? (await client.call("task.list", {
          projectId: options.params.projectId,
          archiveScope: "active",
        })).items.map((task) => task.id);
      const projections: GitHostTaskProjectionDto[] = [];
      for (let offset = 0; offset < taskIds.length; offset += 40) {
        projections.push(...await client.call("gitHost.pullRequestList", {
          projectId: options.params.projectId,
          taskIds: taskIds.slice(offset, offset + 40),
        }));
      }
      return projections;
    }
    case "task-list": return client.call("task.list", options.params);
    case "task-inspect-archive": return client.call("task.inspectArchive", options.params);
    case "task-archive": return client.call("task.archive", options.params);
    case "task-abandon-archive": return client.call("task.abandonArchive", options.params);
    case "task-restore": return client.call("task.restore", options.params);
    case "task-archived-context": return client.call("task.archivedContext", options.params);
    case "task-bind-branch": return client.call("task.bindBranch", options.params);
    case "task-provision-worktree": return client.call("task.provisionWorktree", options.params);
    case "task-inspect-cleanup": return client.call("task.inspectWorktreeCleanup", options.params);
    case "task-cleanup": return client.call("task.cleanupWorktree", options.params);
    case "session-list-archived": return client.call("session.listArchived", options.params);
    case "session-inspect-archive": return client.call("session.inspectArchive", options.params);
    case "session-archive": return client.call("session.archive", options.params);
    case "session-restore-archived": return client.call("session.restoreArchived", options.params);
    case "session-delete-archived": return client.call("session.deleteArchived", options.params);
    case "terminal-launch": return client.call("session.launchTerminal", options.params);
    case "agent-launch": return client.call("session.launchAgent", options.params);
    case "session-list": return client.call("session.list");
    case "session-rename": return client.call("session.rename", options.params);
    case "session-terminate": return client.call("session.terminate", options.params);
    case "session-resume": return client.call("session.resumeAgent", options.params);
    case "session-fork": return client.call("session.forkAgent", options.params);
    case "session-close": return client.call("session.close", options.params);
  }
}

if (await isMainModule(import.meta.url, process.argv[1])) {
  try {
    await run(parseArgs(process.argv.slice(2), process.env));
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "clientError";
    console.error(`${code}: ${controlErrorMessage(error)}`);
    process.exitCode = code === "unsupportedVersion" ? 4 : code === "unauthenticated" ? 3 : 2;
  }
}

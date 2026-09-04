import {
  TermLoopControlClient,
  type ProjectDto,
  type McpToolSettingsResult,
  type ProjectDeleteResult,
  type ProjectTaskAutomationResult,
  type SessionDto,
  type SessionTerminateResult,
  type AgentCoordinationDeliveryResult,
  type TaskDeleteResult,
  type TaskDto,
  type TaskPageDto,
  type TaskArchivePreviewDto,
  type TaskArchiveResultDto,
  type TaskRestoreResultDto,
} from "../src/current.js";

declare const client: TermLoopControlClient;

const mcpSettings: Promise<McpToolSettingsResult> = client.call("mcp.toolSettingsGet");
const updatedMcpSettings: Promise<McpToolSettingsResult> = client.call("mcp.toolDescriptionUpdate", {
  tool: "ask_to",
  description: "Use the visible helper.",
  expectedRevision: 1,
});

const createdProject: Promise<ProjectDto> = client.call("project.create", {
  name: "Demo",
  folderPath: "/tmp/demo",
});
const updatedProject: Promise<ProjectDto> = client.call("project.updateDetails", {
  projectId: "project-1",
  name: "Renamed Demo",
  folderPath: "/tmp/renamed-demo",
});
const deletedProject: Promise<ProjectDeleteResult> = client.call("project.delete", {
  projectId: "project-1",
});
const taskAutomation: Promise<ProjectTaskAutomationResult> = client.call("project.taskAutomationGet", {
  projectId: "project-1",
});
const updatedTaskAutomation: Promise<ProjectTaskAutomationResult> = client.call("project.taskAutomationSet", {
  projectId: "project-1",
  createWorktree: true,
  worktreePrefix: "termloop",
  baseRef: "refs/remotes/origin/development",
  agentId: "codex",
  model: "gpt-5.6-sol",
  permission: "bypassPermissions",
  reasoning: "high",
  kickoffMessage: "Implement and verify.",
  expectedRevision: 1,
});
const sessions: Promise<SessionDto[]> = client.call("session.list");
const terminated: Promise<SessionTerminateResult> = client.call("session.terminate", {
  sessionId: "session-1",
});
const imagePasted: Promise<AgentCoordinationDeliveryResult> = client.call("session.pasteImage", {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  attachments: [{
    attachmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    mediaType: "image/png",
    byteLength: 128,
    sha256: `sha256:${"c".repeat(64)}`,
    width: 12,
    height: 8,
  }],
});
const renamed: Promise<SessionDto> = client.call("session.rename", {
  sessionId: "session-1",
  name: "API shell",
});
const createdTask: Promise<TaskDto> = client.call("task.create", {
  projectId: "project-1",
  title: "Build API",
  brief: null,
  worktreeIntent: "inherit",
  worktreePrefix: null,
  baseRef: null,
  agentId: null,
  model: null,
  permission: null,
  reasoning: null,
  kickoffMessage: null,
});
const tasks: Promise<TaskPageDto> = client.call("task.list", {
  projectId: "project-1",
  archiveScope: "active",
});
const archivePreview: Promise<TaskArchivePreviewDto> = client.call("task.inspectArchive", { taskId: "task-1" });
const archiveResult: Promise<TaskArchiveResultDto> = client.call("task.archive", {
  taskId: "task-1",
  operationId: "operation-1",
  archiveTicket: "ticket-1",
});
const restoreResult: Promise<TaskRestoreResultDto> = client.call("task.restore", { taskId: "task-1" });
const jiraUrls: Promise<(string | null)[]> = tasks.then((page) =>
  page.items.map((task) => task.jira_url),
);
const boundTask: Promise<TaskDto> = client.call("task.bindBranch", {
  taskId: "task-1",
  repositoryPath: "/tmp/repo",
  branchName: "feature/api",
});
const deletedTask: Promise<TaskDeleteResult> = client.call("task.delete", {
  taskId: "task-1",
});

void createdProject;
void mcpSettings;
void updatedMcpSettings;
void updatedProject;
void deletedProject;
void taskAutomation;
void updatedTaskAutomation;
void sessions;
void terminated;
void imagePasted;
void renamed;
void createdTask;
void tasks;
void archivePreview;
void archiveResult;
void restoreResult;
void jiraUrls;
void boundTask;
void deletedTask;

// @ts-expect-error project.create requires folderPath.
client.call("project.create", { name: "Demo" });
// @ts-expect-error project.updateDetails requires the complete atomic detail set.
client.call("project.updateDetails", { projectId: "project-1", name: "Demo" });
// @ts-expect-error project.delete accepts no extra fields.
client.call("project.delete", { projectId: "project-1", force: true });
// @ts-expect-error system.ping accepts no named params.
client.call("system.ping", { unexpected: true });
// @ts-expect-error MCP tool identity is a closed generated enum.
client.call("mcp.toolDescriptionReset", { tool: "unknown", expectedRevision: 1 });
// @ts-expect-error sessionId must be a string.
client.call("session.terminate", { sessionId: 42 });
// @ts-expect-error session.rename requires an explicit name or null.
client.call("session.rename", { sessionId: "session-1" });
// @ts-expect-error session.pasteImage requires exactly the generated attachment fields.
client.call("session.pasteImage", { sessionId: "session-1", attachments: [{ mediaType: "image/png" }] });
// @ts-expect-error worktree intent must be explicit in F2-00.
client.call("task.create", { projectId: "project-1", title: "Build API" });
client.call("task.create", {
  projectId: "project-1",
  title: "Build API",
  worktreeIntent: "provision",
  worktreePrefix: "termloop",
  baseRef: "refs/remotes/origin/development",
  agentId: null,
  model: null,
  permission: null,
  reasoning: null,
  kickoffMessage: null,
});
// @ts-expect-error branchName is required.
client.call("task.bindBranch", { taskId: "task-1", repositoryPath: "/tmp/repo" });

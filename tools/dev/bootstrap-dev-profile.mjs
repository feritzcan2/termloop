import { readFile } from "node:fs/promises";
import { TermLoopControlClient } from "../../contract/generated/typescript/dist/current.js";
import WebSocket from "ws";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const required = (name) => option(name) ?? (() => { throw new Error(`missing ${name}`); })();
const runtimeFile = required("--runtime");
const projectName = required("--project-name");
const projectDir = required("--project-dir");
const taskTitle = required("--task-title");
const inspectOnly = args.includes("--inspect");

const discovery = JSON.parse(await readFile(runtimeFile, "utf8"));
const client = new TermLoopControlClient(
  discovery.controlUrl,
  discovery.token,
  (url) => new WebSocket(url),
);

try {
  let project = (await client.call("project.list"))
    .find((candidate) => candidate.folder_path === projectDir);
  if (!project && !inspectOnly) {
    project = await client.call("project.create", { name: projectName, folderPath: projectDir });
  }
  if (!project) throw new Error(`development Project is missing: ${projectDir}`);

  let task = await findOpenTask(client, project.id, taskTitle);
  if (!task && !inspectOnly) {
    task = await client.call("task.create", {
      projectId: project.id,
      title: taskTitle,
      brief: null,
      worktreeIntent: "none",
      agentId: null,
      model: null,
      reasoning: null,
      kickoffMessage: null,
    });
  }
  if (!task) throw new Error(`development Task is missing: ${taskTitle}`);

  let stewardSnapshot = await client.call("steward.configurationGet", { projectId: project.id });
  if ((!stewardSnapshot.configuration || stewardSnapshot.configuration.enabled) && !inspectOnly) {
    let agentId = stewardSnapshot.configuration?.agentId;
    if (!agentId) {
      const capabilities = await client.call("agent.capabilityList");
      const availableAgents = new Set(
        capabilities.filter((capability) => capability.available).map((capability) => capability.agent_id),
      );
      agentId = availableAgents.has("codex") ? "codex" : availableAgents.has("claude") ? "claude" : "codex";
    }
    await client.call("steward.configurationSet", {
      projectId: project.id,
      agentId,
      model: stewardSnapshot.configuration?.model || "default",
      permission: stewardSnapshot.configuration?.permission || "bypassPermissions",
      reasoning: stewardSnapshot.configuration?.reasoning || "default",
      enabled: false,
      expectedRevision: stewardSnapshot.stateRevision,
      systemPrompt: stewardSnapshot.configuration?.systemPrompt || stewardSnapshot.defaultSystemPrompt,
    });
    stewardSnapshot = await client.call("steward.configurationGet", { projectId: project.id });
  }
  if (!stewardSnapshot.configuration || stewardSnapshot.configuration.enabled) {
    throw new Error("development Steward is not disabled");
  }

  console.log(JSON.stringify({
    project: { id: project.id, name: project.name, folder_path: project.folder_path },
    task: { id: task.id, title: task.title, status: task.status },
    steward: {
      projectId: stewardSnapshot.configuration.projectId,
      agentId: stewardSnapshot.configuration.agentId,
      enabled: stewardSnapshot.configuration.enabled,
      executorSessionId: stewardSnapshot.configuration.executorSessionId,
      generation: stewardSnapshot.configuration.generation,
    },
  }));
} finally {
  client.close();
}

async function findOpenTask(control, projectId, title) {
  let cursor;
  do {
    const page = await control.call("task.list", {
      projectId,
      archiveScope: "active",
      status: "open",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const match = page.items.find((candidate) => candidate.title === title);
    if (match) return match;
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return undefined;
}

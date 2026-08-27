import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f2-task-current-state-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectADirectory = path.join(temporary, "project-a");
const projectBDirectory = path.join(temporary, "project-b");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f2/task-current-state.local.json");
const reportPath = path.join(root, "artifacts/evidence/f2/TASK-CURRENT-STATE.md");
await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(projectADirectory, { recursive: true }),
  mkdir(projectBDirectory, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
]);
await writeFile(path.join(projectADirectory, "sentinel.txt"), "must survive Task operations\n");

const evidence = {
  schema: "f2-task-current-state-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    desktopCreatesWorktreeLessTask: false,
    invalidationUpdatesSelectedProject: false,
    projectScopesTaskProjection: false,
    editSurvivesClientRestart: false,
    closeChangesOnlyTaskState: false,
    taskSurvivesDaemonRestart: false,
    reopenAndDeleteAreExplicit: false,
    filesystemAndSessionsRemainUntouched: false,
    readOnlyScopeListsButCannotMutate: false,
  },
  measurements: {},
  failures: [],
};

let server;
let app;
try {
  server = await startServer();
  let record = await readRecord(server.pid);
  const projectA = await controlCall(record, "project.create", { name: "Project A", folderPath: projectADirectory });
  const projectB = await controlCall(record, "project.create", { name: "Project B", folderPath: projectBDirectory });
  const terminal = await controlCall(record, "session.launchTerminal", { projectId: projectA.id, cwd: projectADirectory });

  ({ app } = await launchDesktop());
  let page = await app.firstWindow();
  await page.getByRole("button", { name: "Create Task" }).click();
  await page.getByLabel("Title").fill("Implement task model");
  await page.getByLabel("Brief").fill("Keep the worktree optional.");
  await page.getByRole("dialog").getByRole("button", { name: "Create Task", exact: true }).click();
  await page.locator(".task-item", { hasText: "Implement task model" }).waitFor();
  let tasksA = await controlCall(record, "task.list", { projectId: projectA.id });
  assert.equal(tasksA.length, 1);
  assert.equal(tasksA[0].branch, null);
  assert.equal(tasksA[0].worktree, null);
  assert.equal(tasksA[0].status, "open");
  evidence.checks.desktopCreatesWorktreeLessTask = true;

  const readOnlyList = await rawControlCall(record, record.readOnlyToken, "task.list", { projectId: projectA.id });
  assert.equal(readOnlyList.ok, true);
  assert.equal(readOnlyList.result.length, 1);
  const readOnlyCreate = await rawControlCall(record, record.readOnlyToken, "task.create", {
    projectId: projectA.id,
    title: "Must be denied",
    brief: null,
    worktreeIntent: "none",
  });
  assert.equal(readOnlyCreate.ok, false);
  assert.equal(readOnlyCreate.error.code, "capabilityDenied");
  evidence.checks.readOnlyScopeListsButCannotMutate = true;

  const pushedTask = await controlCall(record, "task.create", {
    projectId: projectA.id,
    title: "Arrives over invalidation",
    brief: null,
    worktreeIntent: "none",
  });
  await page.locator(`[data-task-id="${pushedTask.id}"]`).waitFor();
  evidence.checks.invalidationUpdatesSelectedProject = true;

  const projectBTask = await controlCall(record, "task.create", {
    projectId: projectB.id,
    title: "Only in Project B",
    brief: null,
    worktreeIntent: "none",
  });
  await selectProject(page, projectB.id);
  await page.locator(`[data-task-id="${projectBTask.id}"]`).waitFor();
  assert.equal(await page.locator(`[data-task-id="${tasksA[0].id}"]`).count(), 0);
  await selectProject(page, projectA.id);
  const taskRow = page.locator(`[data-task-id="${tasksA[0].id}"]`);
  await taskRow.waitFor();
  assert.equal(await page.locator(`[data-task-id="${projectBTask.id}"]`).count(), 0);
  evidence.checks.projectScopesTaskProjection = true;

  await taskRow.click();
  await page.getByLabel("Title").fill("Implement durable task model");
  await page.getByLabel("Brief").fill("Current state only; worktree stays optional.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(`[data-task-id="${tasksA[0].id}"]`, { hasText: "Implement durable task model" }).waitFor();
  await app.close();
  app = undefined;

  ({ app } = await launchDesktop());
  page = await app.firstWindow();
  const editedRow = page.locator(`[data-task-id="${tasksA[0].id}"]`);
  await editedRow.waitFor();
  assert.match(await editedRow.innerText(), /Current state only; worktree stays optional/);
  evidence.checks.editSurvivesClientRestart = true;

  const paneCountBefore = await page.locator(".layout-pane").count();
  const sessionsBefore = await controlCall(record, "session.list");
  await editedRow.click({ button: "right" });
  await page.getByRole("menu", { name: "Implement durable task model actions" }).getByRole("menuitem", { name: /Close Task/ }).click();
  await waitUntil(async () => (await editedRow.getAttribute("class"))?.includes("closed"), 5_000, "Task did not close");
  const closedTasks = await controlCall(record, "task.list", { projectId: projectA.id });
  assert.equal(closedTasks.find((task) => task.id === tasksA[0].id)?.status, "closed");
  assert.equal((await controlCall(record, "session.list")).length, sessionsBefore.length);
  assert.equal(await page.locator(".layout-pane").count(), paneCountBefore);
  evidence.checks.closeChangesOnlyTaskState = true;

  await app.close();
  app = undefined;
  await stopServer(server);
  server = await startServer();
  record = await readRecord(server.pid);
  const afterRestart = await controlCall(record, "task.list", { projectId: projectA.id });
  const persisted = afterRestart.find((task) => task.id === tasksA[0].id);
  assert.equal(persisted?.title, "Implement durable task model");
  assert.equal(persisted?.brief, "Current state only; worktree stays optional.");
  assert.equal(persisted?.status, "closed");
  assert.equal(persisted?.branch, null);
  assert.equal(persisted?.worktree, null);
  evidence.checks.taskSurvivesDaemonRestart = true;

  ({ app } = await launchDesktop());
  page = await app.firstWindow();
  const restartedRow = page.locator(`[data-task-id="${tasksA[0].id}"]`);
  await restartedRow.waitFor();
  await restartedRow.click({ button: "right" });
  await page.getByRole("menu", { name: "Implement durable task model actions" }).getByRole("menuitem", { name: /Reopen Task/ }).click();
  await waitUntil(async () => !(await restartedRow.getAttribute("class"))?.includes("closed"), 5_000, "Task did not reopen");
  await restartedRow.click({ button: "right" });
  await page.getByRole("menu", { name: "Implement durable task model actions" }).getByRole("menuitem", { name: /Delete Task/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete Task", exact: true }).click();
  await waitUntil(async () => await page.locator(`[data-task-id="${tasksA[0].id}"]`).count() === 0, 5_000, "Task did not delete");
  assert.equal((await controlCall(record, "task.list", { projectId: projectA.id })).some((task) => task.id === tasksA[0].id), false);
  evidence.checks.reopenAndDeleteAreExplicit = true;

  const filesAfter = await readdir(projectADirectory);
  assert.deepEqual(filesAfter, ["sentinel.txt"]);
  assert.equal(await readFile(path.join(projectADirectory, "sentinel.txt"), "utf8"), "must survive Task operations\n");
  const restartedSessions = await controlCall(record, "session.list");
  assert.equal(restartedSessions.find((session) => session.id === terminal.id)?.lifecycle_state, "exited");
  evidence.measurements = {
    projectATaskCountAfterDelete: (await controlCall(record, "task.list", { projectId: projectA.id })).length,
    projectBTaskCount: (await controlCall(record, "task.list", { projectId: projectB.id })).length,
    projectAFiles: filesAfter,
  };
  evidence.checks.filesystemAndSessionsRemainUntouched = true;
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (app) await app.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  evidence.status = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0 ? "PASS" : "FAIL";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(reportPath, report(evidence));
  await rm(temporary, { recursive: true, force: true });
  if (evidence.status !== "PASS") process.exitCode = 1;
}

async function launchDesktop() {
  const launched = await electron.launch({
    args: [path.join(root, "clients/desktop")],
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_FILE: runtimeFile, TERMLOOP_DESKTOP_USER_DATA_DIR: electronUserDataDirectory },
  });
  const page = await launched.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  await page.getByRole("button", { name: "Create Task" }).waitFor();
  return { app: launched, page };
}

async function selectProject(page, projectId) {
  await page.getByRole("button", { name: "Current Project" }).click();
  await page.locator(`[data-project-option-id="${projectId}"]`).click();
}

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("exit", (code) => { if (code && !child.killed) evidence.failures.push(`server exited ${code}: ${stderr}`); });
  await readRecord(child.pid);
  return child;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function readRecord(pid) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(runtimeFile, "utf8"));
      if (record.pid === pid) return record;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime discovery did not appear for pid ${pid}`);
}

async function controlCall(record, method, params = {}) {
  const response = await rawControlCall(record, record.token, method, params);
  if (response.ok) return response.result;
  throw new Error(`${method}: ${response.error?.message ?? "failed"}`);
}

async function rawControlCall(record, token, method, params = {}) {
  const socket = new WebSocket(record.controlUrl);
  const id = crypto.randomUUID();
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 8_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token, method, params })));
    socket.once("message", (raw) => {
      clearTimeout(timeout); socket.close();
      resolve(JSON.parse(String(raw)));
    });
    socket.once("error", reject);
  });
}

async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function report(value) {
  const rows = Object.entries(value.checks).map(([name, passed]) => `| ${name} | ${passed ? "PASS" : "FAIL"} |`).join("\n");
  return `# F2-00 Task Current State Evidence\n\nCaptured: ${value.capturedAt}\n\nStatus: **${value.status}**\n\n| Check | Result |\n|---|---|\n${rows}\n\n## Measurements\n\n\`\`\`json\n${JSON.stringify(value.measurements, null, 2)}\n\`\`\`\n${value.failures.length ? `\n## Failures\n\n\`\`\`text\n${value.failures.join("\n\n")}\n\`\`\`\n` : ""}`;
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f1-project-management-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const originalDirectory = path.join(temporary, "project-original");
const editedDirectory = path.join(temporary, "project-edited");
const fallbackDirectory = path.join(temporary, "project-fallback");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const layoutFile = path.join(temporary, "desktop", "layout.v1.json");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f1/project-management.local.json");
const reportPath = path.join(root, "artifacts/evidence/f1/PROJECT-MANAGEMENT.md");
await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(originalDirectory, { recursive: true }),
  mkdir(editedDirectory, { recursive: true }),
  mkdir(fallbackDirectory, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
]);
await writeFile(path.join(originalDirectory, "original-sentinel.txt"), "original folder survives\n");
await writeFile(path.join(editedDirectory, "edited-sentinel.txt"), "edited folder survives\n");

const evidence = {
  schema: "f1-project-management-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    desktopEditsNameAndFolderAtomically: false,
    editSurvivesClientAndDaemonRestart: false,
    readOnlyScopeObservesButCannotMutate: false,
    worktreelessTaskDoesNotBlock: false,
    runningSessionsAreForceClosed: false,
    desktopDeletesEligibleProject: false,
    projectFoldersRemainUntouched: false,
    selectionAndLayoutArePruned: false,
  },
  measurements: {},
  failures: [],
};

let server;
let app;
try {
  server = await startServer();
  let record = await readRecord(server.pid);
  const target = await controlCall(record, "project.create", { name: "Before Edit", folderPath: originalDirectory });
  const fallback = await controlCall(record, "project.create", { name: "Fallback", folderPath: fallbackDirectory });
  await controlCall(record, "session.launchTerminal", { projectId: target.id, cwd: originalDirectory });

  app = await launchDesktop();
  let page = await app.firstWindow();
  await selectProject(page, target.id);
  await page.getByRole("button", { name: "Current Project" }).click();
  await page.getByRole("menuitem", { name: "Edit Project" }).click();
  await page.getByLabel("Name", { exact: true }).fill("After Edit");
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, editedDirectory);
  await page.locator("#edit-project-folder").click();
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  await page.locator("#project-title").getByText("After Edit", { exact: true }).waitFor();
  const updated = (await controlCall(record, "project.list")).find((project) => project.id === target.id);
  assert.equal(updated.name, "After Edit");
  assert.equal(updated.folder_path, await canonicalPath(editedDirectory));
  evidence.checks.desktopEditsNameAndFolderAtomically = true;

  await waitForLayoutProject(target.id);
  await app.close();
  app = undefined;
  await stopServer(server);
  server = await startServer();
  record = await readRecord(server.pid);
  const persisted = (await controlCall(record, "project.list")).find((project) => project.id === target.id);
  assert.equal(persisted.name, "After Edit");
  assert.equal(persisted.folder_path, await canonicalPath(editedDirectory));
  app = await launchDesktop();
  page = await app.firstWindow();
  await page.locator("#project-title").getByText("After Edit", { exact: true }).waitFor();
  evidence.checks.editSurvivesClientAndDaemonRestart = true;

  const readOnlyList = await rawControlCall(record, record.readOnlyToken, "project.list");
  assert.equal(readOnlyList.ok, true);
  assert.equal(readOnlyList.result.find((project) => project.id === target.id).name, "After Edit");
  for (const [method, params] of [
    ["project.updateDetails", { projectId: target.id, name: "Denied", folderPath: editedDirectory }],
    ["project.delete", { projectId: target.id }],
  ]) {
    const denied = await rawControlCall(record, record.readOnlyToken, method, params);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "capabilityDenied");
  }
  evidence.checks.readOnlyScopeObservesButCannotMutate = true;

  await controlCall(record, "task.create", {
    projectId: target.id,
    title: "Deleted with its Project",
    brief: null,
    worktreeIntent: "none",
  });
  const running = await controlCall(record, "session.launchTerminal", { projectId: target.id, cwd: editedDirectory });
  await page.getByRole("button", { name: "Current Project" }).click();
  await page.getByRole("menuitem", { name: "Delete Project" }).click();
  await page.locator("#confirm-delete-project").click();
  await page.locator("#project-title").getByText("Fallback", { exact: true }).waitFor();
  const projectsAfter = await controlCall(record, "project.list");
  assert.equal(projectsAfter.some((project) => project.id === target.id), false);
  assert.equal(projectsAfter.some((project) => project.id === fallback.id), true);
  const sessionsAfter = await controlCall(record, "session.list");
  assert.equal(sessionsAfter.some((session) => session.project_id === target.id), false);
  assert.equal(sessionsAfter.some((session) => session.id === running.id), false);
  evidence.checks.worktreelessTaskDoesNotBlock = true;
  evidence.checks.runningSessionsAreForceClosed = true;
  evidence.checks.desktopDeletesEligibleProject = true;

  assert.equal(await readFile(path.join(originalDirectory, "original-sentinel.txt"), "utf8"), "original folder survives\n");
  assert.equal(await readFile(path.join(editedDirectory, "edited-sentinel.txt"), "utf8"), "edited folder survives\n");
  evidence.checks.projectFoldersRemainUntouched = true;

  await waitUntil(async () => {
    try {
      const document = JSON.parse(await readFile(layoutFile, "utf8"));
      return !(target.id in document.projects) && !(target.id in document.sessionOrderByProject);
    } catch {
      return false;
    }
  }, 5_000, "deleted Project remained in client layout");
  const layout = JSON.parse(await readFile(layoutFile, "utf8"));
  assert.equal(await page.getByRole("button", { name: "Current Project" }).getAttribute("data-selected-project-id"), fallback.id);
  evidence.measurements = {
    projectsAfterDelete: projectsAfter.length,
    targetSessionsAfterDelete: (await controlCall(record, "session.list")).filter((session) => session.project_id === target.id).length,
    layoutProjectIds: Object.keys(layout.projects),
  };
  evidence.checks.selectionAndLayoutArePruned = true;
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
    env: {
      ...process.env,
      TERMLOOP_RUNTIME_FILE: runtimeFile,
      TERMLOOP_DESKTOP_USER_DATA_DIR: electronUserDataDirectory,
      TERMLOOP_LAYOUT_FILE: layoutFile,
    },
  });
  const page = await launched.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  await waitUntil(async () => /connected|live/.test(await page.locator(".connection-status").innerText().catch(() => "")), 10_000, "desktop did not connect");
  return launched;
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
    socket.once("message", (raw) => { clearTimeout(timeout); socket.close(); resolve(JSON.parse(String(raw))); });
    socket.once("error", reject);
  });
}

async function canonicalPath(value) {
  return process.platform === "win32" ? path.resolve(value) : await import("node:fs/promises").then(({ realpath }) => realpath(value));
}

async function waitForLayoutProject(projectId) {
  await waitUntil(async () => {
    try {
      const document = JSON.parse(await readFile(layoutFile, "utf8"));
      return projectId in document.projects;
    } catch {
      return false;
    }
  }, 5_000, "Project layout did not persist");
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
  return `# F1-06 Project Editing and Deletion Evidence\n\n- Status: **${value.status}**\n- Captured: ${value.capturedAt}\n- Host: ${value.host.platform}/${value.host.arch} ${value.host.release}\n- Scope: real daemon, shown Electron window, native folder-picker seam, client/daemon restart, worktree-only deletion blocking, forced Session closure, durable-state and filesystem/layout inspection\n\n| Check | Result |\n|---|---|\n${rows}\n\n## Measurements\n\n\`\`\`json\n${JSON.stringify(value.measurements, null, 2)}\n\`\`\`\n${value.failures.length ? `\n## Failures\n\n\`\`\`text\n${value.failures.join("\n\n")}\n\`\`\`\n` : ""}`;
}

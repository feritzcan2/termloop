import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f2-stale-disposal-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const userDataDirectory = path.join(temporary, "electron");
const repository = path.join(temporary, "repository");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const stateFile = path.join(stateDirectory, "state.v1.json");
const evidencePath = path.join(root, "artifacts/evidence/f2/stale-worktree-disposal.local.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");

const evidence = {
  schema: "f2-stale-worktree-disposal-v3",
  capturedAt: new Date().toISOString(),
  command: "pnpm acceptance:f2-stale-worktree-disposal",
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    orphanedProjectionIsTyped: false,
    prooflessRegisteredProjectionIsTyped: false,
    registeredCheckoutRemovedThroughGitThenTask: false,
    gitMetadataRefusesDisposal: false,
    shownExplicitStaleDeletion: false,
    disposalRemovesExactFolderThenTask: false,
    repositoryBranchAndSiblingPreserved: false,
  },
  skipped: {
    crossPlatformRuntime: "local host only; Windows/Linux mount, drive, UNC, reparse, and case behavior remains unmeasured",
    externalKill: "daemon kill at each durable disposal stage remains unmeasured",
    externalWriterAfterFinalGate: "an external writer can still race after final identity observation",
    networkFilesystem: "network filesystem and remote mount semantics remain unmeasured",
    partialRemovalInjection: "recovery-attention transitions have core/store coverage; OS partial-removal injection is unmeasured",
    attachedSessionUi: "bounded retirement sequencing has desktop composition coverage; this artifact exercises the no-Session shown disposal path",
  },
  failures: [],
};

let server;
let app;
try {
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
    mkdir(path.dirname(evidencePath), { recursive: true }),
  ]);
  git(temporary, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "TermLoop Fixture"]);
  git(repository, ["config", "user.email", "fixture@termloop.invalid"]);
  await writeFile(path.join(repository, "tracked.txt"), "base\n");
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "-m", "fixture"]);
  git(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  server = await startServer();
  let record = await readRecord(server.pid);
  const project = await call(record, "project.create", { name: "Stale disposal", folderPath: repository });
  const registered = await makeManaged(record, project.id, "Proofless registered worktree", "feature/proofless-registered", "registered.txt");
  const discard = await makeOrphan(record, project.id, "Discard stale folder", "feature/stale-discard", "discard.txt");
  const guarded = await makeOrphan(record, project.id, "Guard Git metadata", "feature/stale-guard", "guard.txt");

  await stopServer(server);
  server = undefined;
  await removeManagedProof(registered.task.id);
  server = await startServer();
  record = await readRecord(server.pid);

  const discardPreview = await call(record, "task.inspectWorktreeCleanup", { taskId: discard.task.id });
  assert.equal(discardPreview.decision, "refused");
  assert.equal(discardPreview.blockers.includes("pathRegistrationInconsistent"), true);
  assert.equal(discardPreview.blockers.includes("orphanedManagedDirectory"), true);
  assert.equal(discardPreview.blockers.includes("observationFailed"), false);
  assert.equal(discardPreview.stale_resolution.disposal_status, "available");
  evidence.checks.orphanedProjectionIsTyped = true;

  const registeredPreview = await call(record, "task.inspectWorktreeCleanup", { taskId: registered.task.id });
  assert.equal(registeredPreview.managed_worktree_operation_id, null);
  assert.equal(registeredPreview.worktree_generation, 0);
  assert.deepEqual(registeredPreview.blockers, ["managedProofMissing"]);
  assert.equal(registeredPreview.stale_resolution.forget_status, "unavailable");
  assert.equal(registeredPreview.stale_resolution.disposal_status, "available");
  evidence.checks.prooflessRegisteredProjectionIsTyped = true;

  await writeFile(path.join(guarded.path, ".git"), "gitdir: unrelated\n");
  const guardedPreview = await call(record, "task.inspectWorktreeCleanup", { taskId: guarded.task.id });
  assert.equal(guardedPreview.stale_resolution.forget_status, "available");
  assert.equal(guardedPreview.stale_resolution.disposal_status, "unavailable");
  assert.equal(guardedPreview.stale_resolution.blockers.includes("gitMetadataPresent"), true);
  const refused = await rawCall(record, record.token, "task.discardStaleWorktree", staleParams(guarded, guardedPreview, true));
  assert.equal(refused.error?.details?.kind, "worktreeStaleResolutionRefused");
  assert.equal(await exists(guarded.path), true);
  evidence.checks.gitMetadataRefusesDisposal = true;

  ({ app } = await launchDesktop());
  const page = await app.firstWindow();
  await selectProject(page, project.id);

  const registeredRow = page.locator(`[data-task-id="${registered.task.id}"]`);
  await registeredRow.waitFor();
  await registeredRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete Task and worktree" }).click();
  let dialog = page.getByRole("alertdialog", { name: /Delete/ });
  await dialog.getByText(/cannot verify this folder's current contents or Git ownership/i).waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  const keepRegistered = dialog.getByRole("radio", { name: /Keep the folder/i });
  assert.equal(await keepRegistered.isChecked(), true);
  let destructiveButton = dialog.getByRole("button", { name: "Delete Task; keep folder", exact: true });
  assert.equal(await destructiveButton.isEnabled(), true);
  await dialog.getByRole("radio", { name: /Permanently delete the unverified folder/i }).check();
  destructiveButton = dialog.getByRole("button", { name: "Delete Task and folder", exact: true });
  await waitFor(async () => await destructiveButton.isEnabled() ? true : undefined, 8_000, "enabled registered stale delete");
  await destructiveButton.click();
  await registeredRow.waitFor({ state: "detached" });
  assert.equal(await exists(registered.path), false);
  assert.equal(gitExit(repository, ["worktree", "list", "--porcelain"]), 0);
  assert.equal((await call(record, "task.list", { projectId: project.id, archiveScope: "active", taskIds: [registered.task.id] })).items.length, 0);
  assert.equal(gitExit(repository, ["show-ref", "--verify", "--quiet", "refs/heads/feature/proofless-registered"]), 0);
  evidence.checks.registeredCheckoutRemovedThroughGitThenTask = true;

  const discardRow = page.locator(`[data-task-id="${discard.task.id}"]`);
  await discardRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete Task and worktree" }).click();
  dialog = page.getByRole("alertdialog", { name: /Delete/ });
  await dialog.getByText(/cannot verify this folder's current contents or Git ownership/i).waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  assert.equal(await dialog.getByRole("radio", { name: /Keep the folder/i }).isChecked(), true);
  await dialog.getByRole("radio", { name: /Permanently delete the unverified folder/i }).check();
  destructiveButton = dialog.getByRole("button", { name: "Delete Task and folder", exact: true });
  await waitFor(async () => await destructiveButton.isEnabled() ? true : undefined, 8_000, "enabled orphan stale delete");
  evidence.checks.shownExplicitStaleDeletion = true;
  await destructiveButton.click();
  await discardRow.waitFor({ state: "detached" });
  assert.equal(await exists(discard.path), false);
  assert.equal((await call(record, "task.list", { projectId: project.id, archiveScope: "active", taskIds: [discard.task.id] })).items.length, 0);
  evidence.checks.disposalRemovesExactFolderThenTask = true;
  assert.equal(await exists(repository), true);
  assert.equal(await exists(guarded.path), true);
  assert.equal(gitExit(repository, ["show-ref", "--verify", "--quiet", "refs/heads/feature/stale-discard"]), 0);
  evidence.checks.repositoryBranchAndSiblingPreserved = true;
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (app) await app.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  const passed = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0;
  evidence.status = passed ? "PASS_LOCAL_WITH_SKIPS" : "FAIL";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await rm(temporary, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}

async function makeOrphan(record, projectId, title, branchName, fileName) {
  const managed = await makeManaged(record, projectId, title, branchName, fileName);
  git(repository, ["worktree", "remove", "--force", managed.path]);
  await mkdir(managed.path, { recursive: true });
  await writeFile(path.join(managed.path, fileName), `${fileName}\n`);
  return managed;
}

async function makeManaged(record, projectId, title, branchName, fileName) {
  const task = await call(record, "task.create", {
    projectId, title, brief: null,
    worktreeIntent: "none", worktreePrefix: null, baseRef: null,
    agentId: null, model: null, permission: null, reasoning: null, kickoffMessage: null,
  });
  const requestedPath = path.join(temporary, branchName.replaceAll("/", "-"));
  const provisioned = await call(record, "task.provisionWorktree", {
    operationId: randomUUID(), taskId: task.id, repositoryPath: repository,
    destinationPath: requestedPath, branchName, branchMode: "create", baseRef: "refs/remotes/origin/main",
  });
  const exactPath = provisioned.task.worktree.path;
  await writeFile(path.join(exactPath, fileName), `${fileName}\n`);
  return { task: provisioned.task, path: exactPath };
}

async function removeManagedProof(taskId) {
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.managed_worktrees = state.managed_worktrees.filter((proof) => proof.task_id !== taskId);
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  assert.ok(task);
  task.worktree_generation = 0;
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function staleParams(fixture, preview, acknowledge) {
  return {
    operationId: randomUUID(), taskId: fixture.task.id,
    expectedManagedWorktreeOperationId: preview.managed_worktree_operation_id,
    expectedWorktreeGeneration: preview.worktree_generation,
    targetPath: preview.target_path,
    acknowledgeUnverifiedDirectoryDeletion: acknowledge,
  };
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" },
  });
}

function gitExit(cwd, args) {
  try { git(cwd, args); return 0; } catch (error) { return error?.status ?? 1; }
}

async function exists(candidate) {
  return access(candidate).then(() => true, () => false);
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
  return waitFor(async () => {
    try {
      const record = JSON.parse(await readFile(runtimeFile, "utf8"));
      return record.pid === pid ? record : undefined;
    } catch { return undefined; }
  }, 8_000, "runtime discovery");
}

async function call(record, method, params = {}) {
  const response = await rawCall(record, record.token, method, params);
  if (response.ok) return response.result;
  throw new Error(`${method}: ${response.error?.code}: ${response.error?.message}`);
}

async function rawCall(record, token, method, params = {}) {
  const socket = new WebSocket(record.controlUrl);
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 12_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token, method, params })));
    socket.once("message", (raw) => { clearTimeout(timeout); socket.close(); resolve(JSON.parse(String(raw))); });
    socket.once("error", reject);
  });
}

async function launchDesktop() {
  const launched = await electron.launch({
    args: [path.join(root, "clients/desktop")], cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_FILE: runtimeFile, TERMLOOP_DESKTOP_USER_DATA_DIR: userDataDirectory },
  });
  const page = await launched.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  return { app: launched };
}

async function selectProject(page, projectId) {
  const trigger = page.getByRole("button", { name: "Current Project" });
  if (await trigger.getAttribute("data-selected-project-id") === projectId) return;
  await trigger.click();
  await page.locator(`[data-project-option-id="${projectId}"]`).click();
}

async function waitFor(check, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

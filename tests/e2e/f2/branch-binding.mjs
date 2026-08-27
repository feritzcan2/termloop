import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f2-branch-binding-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const projectScope = path.join(temporary, "project-scope");
const repository = path.join(projectScope, "repository");
const repositoryLink = path.join(projectScope, "repository-link");
const linked = path.join(projectScope, "linked");
const insideRepository = path.join(repository, "project-subdirectory");
const disjointProject = path.join(temporary, "disjoint-project");
const bareRepository = path.join(projectScope, "bare.git");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f2/branch-binding.local.json");
const globalGitConfig = path.join(temporary, "global.gitconfig");
const emptyHooksDirectory = path.join(temporary, "empty-hooks");
const invalidationQuietWindowMs = 500;

await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(projectScope, { recursive: true }),
  mkdir(disjointProject, { recursive: true }),
  mkdir(emptyHooksDirectory, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
  writeFile(globalGitConfig, ""),
]);
await initializeRepository();
let symlinkFailure;
try {
  await symlink(repository, repositoryLink, process.platform === "win32" ? "junction" : "dir");
} catch (error) {
  symlinkFailure = error instanceof Error ? error.message : String(error);
}

const evidence = {
  schema: "f2-branch-binding-v3",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release(), git: git(repository, ["--version"]).trim() },
  checks: {
    nestedRepositoryBinding: false,
    idempotentRetry: false,
    bindInvalidationSingleLiveEvent: false,
    idempotentRetryNoInvalidation: false,
    mainLinkedIdentityConflict: false,
    sameTaskDifferentBindingConflict: false,
    checkedOutBranchAccepted: false,
    closedTaskBinding: false,
    closedHolderStillConflicts: false,
    deleteReleasesBinding: false,
    projectContainmentMatrix: false,
    malformedAndMissingInputsTyped: false,
    readOnlyDenied: false,
    restartDurability: false,
    indexesUnchanged: false,
    desktopBranchMetadataVisible: false,
    desktopTypedHolderConflict: false,
    ...(symlinkFailure ? {} : { symlinkedRepositoryInput: false }),
  },
  skipped: {
    nonUtfRepositoryPath: process.platform === "win32" ? "not representable by the host path model" : "not exercised by this JSON control-contract fixture",
    crossPlatformRuntime: "local host only",
    ...(symlinkFailure ? { symlinkedRepositoryInput: symlinkFailure } : {}),
  },
  measurements: { invalidationQuietWindowMs },
  desktop: {},
  failures: [],
};

let server;
let app;
let subscription;
try {
  const before = await indexState();
  assertNoIndexLocks(before);
  server = await startServer();
  let record = await readRecord(server.pid);
  const nestedProject = await createProject(record, "Nested", projectScope);
  const holder = await createTask(record, nestedProject.id, "Holder");
  const contender = await createTask(record, nestedProject.id, "Contender");
  const checkedOut = await createTask(record, nestedProject.id, "Checked out");
  const uiHappy = await createTask(record, nestedProject.id, "UI happy", "Visible brief metadata");
  const uiConflict = await createTask(record, nestedProject.id, "UI conflict", "Conflict brief metadata");

  await new Promise((resolve) => setTimeout(resolve, 150));
  subscription = await subscribeToTasks(record);
  const subscribedRevision = subscription.stateRevision;

  const first = await controlCall(record, "task.bindBranch", {
    taskId: holder.id,
    repositoryPath: repository,
    branchName: "main",
  });
  assert.deepEqual(first.branch, { repository_root: await realpath(repository), name: "main" });
  const firstInvalidation = await subscription.waitForInvalidationAfter(subscribedRevision);
  assert.deepEqual(firstInvalidation.topics, ["task"]);
  assert.equal(firstInvalidation.stateRevision > subscribedRevision, true);
  await subscription.expectNoInvalidation(
    "unexpected additional Task invalidation after the first live bind event",
  );
  evidence.checks.bindInvalidationSingleLiveEvent = true;
  evidence.checks.nestedRepositoryBinding = true;

  const retried = await controlCall(record, "task.bindBranch", {
    taskId: holder.id,
    repositoryPath: linked,
    branchName: "main",
  });
  assert.equal(retried.updated_at_epoch_ms, first.updated_at_epoch_ms);
  assert.deepEqual(retried, first);
  await subscription.expectNoInvalidation(
    "unexpected Task invalidation after idempotent retry",
  );
  evidence.checks.idempotentRetryNoInvalidation = true;
  evidence.checks.idempotentRetry = true;
  subscription.close();
  subscription = undefined;

  const mainLinkedConflict = await rawControlCall(record, record.token, "task.bindBranch", {
    taskId: contender.id,
    repositoryPath: linked,
    branchName: "main",
  });
  assertConflict(mainLinkedConflict, "branchHeldByTask", holder.id);
  evidence.checks.mainLinkedIdentityConflict = true;

  const immutableConflict = await rawControlCall(record, record.token, "task.bindBranch", {
    taskId: holder.id,
    repositoryPath: repository,
    branchName: "feature/checked-out",
  });
  assertConflict(immutableConflict, "taskBranchAlreadyBound", holder.id);
  evidence.checks.sameTaskDifferentBindingConflict = true;

  const feature = await controlCall(record, "task.bindBranch", {
    taskId: checkedOut.id,
    repositoryPath: repository,
    branchName: "feature/checked-out",
  });
  assert.equal(feature.branch.name, "feature/checked-out");
  evidence.checks.checkedOutBranchAccepted = true;

  await controlCall(record, "task.close", { taskId: holder.id });
  const closedConflict = await rawControlCall(record, record.token, "task.bindBranch", {
    taskId: contender.id,
    repositoryPath: repository,
    branchName: "main",
  });
  assertConflict(closedConflict, "branchHeldByTask", holder.id);
  evidence.checks.closedHolderStillConflicts = true;

  await controlCall(record, "task.delete", { taskId: holder.id });
  const rebound = await controlCall(record, "task.bindBranch", {
    taskId: contender.id,
    repositoryPath: linked,
    branchName: "main",
  });
  assert.equal(rebound.branch.name, "main");
  evidence.checks.deleteReleasesBinding = true;

  const equalProject = await createProject(record, "Equal", repository);
  const equalTask = await createTask(record, equalProject.id, "Equal");
  await controlCall(record, "task.close", { taskId: equalTask.id });
  const equalBinding = await controlCall(record, "task.bindBranch", { taskId: equalTask.id, repositoryPath: repository, branchName: "main" });
  assert.equal(equalBinding.status, "closed");
  evidence.checks.closedTaskBinding = true;
  if (!symlinkFailure) {
    const symlinkRetry = await controlCall(record, "task.bindBranch", { taskId: equalTask.id, repositoryPath: repositoryLink, branchName: "main" });
    assert.equal(symlinkRetry.updated_at_epoch_ms, equalBinding.updated_at_epoch_ms);
    evidence.checks.symlinkedRepositoryInput = true;
  }
  const insideProject = await createProject(record, "Inside", insideRepository);
  const insideTask = await createTask(record, insideProject.id, "Inside");
  await controlCall(record, "task.bindBranch", { taskId: insideTask.id, repositoryPath: linked, branchName: "main" });
  const linkedProject = await createProject(record, "Linked", linked);
  const linkedTask = await createTask(record, linkedProject.id, "Linked");
  await controlCall(record, "task.bindBranch", { taskId: linkedTask.id, repositoryPath: repository, branchName: "main" });
  const disjoint = await createProject(record, "Disjoint", disjointProject);
  const disjointTask = await createTask(record, disjoint.id, "Disjoint");
  const disjointResult = await rawControlCall(record, record.token, "task.bindBranch", { taskId: disjointTask.id, repositoryPath: repository, branchName: "main" });
  assert.equal(disjointResult.error?.code, "invalidMessage");
  evidence.checks.projectContainmentMatrix = true;

  const malformedTask = await createTask(record, nestedProject.id, "Malformed");
  const malformed = await rawControlCall(record, record.token, "task.bindBranch", { taskId: malformedTask.id, repositoryPath: repository, branchName: "main~1" });
  assert.equal(malformed.error?.code, "invalidMessage");
  const missing = await rawControlCall(record, record.token, "task.bindBranch", { taskId: malformedTask.id, repositoryPath: repository, branchName: "missing" });
  assert.equal(missing.error?.code, "notFound");
  const missingRepository = await rawControlCall(record, record.token, "task.bindBranch", { taskId: malformedTask.id, repositoryPath: path.join(projectScope, "missing"), branchName: "main" });
  assert.equal(missingRepository.error?.code, "invalidMessage");
  const bare = await rawControlCall(record, record.token, "task.bindBranch", { taskId: malformedTask.id, repositoryPath: bareRepository, branchName: "main" });
  assert.equal(bare.error?.code, "invalidMessage");
  evidence.checks.malformedAndMissingInputsTyped = true;

  const denied = await rawControlCall(record, record.readOnlyToken, "task.bindBranch", { taskId: malformedTask.id, repositoryPath: repository, branchName: "main" });
  assert.equal(denied.error?.code, "capabilityDenied");
  evidence.checks.readOnlyDenied = true;

  ({ app } = await launchDesktop());
  const page = await app.firstWindow();
  evidence.desktop = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    electron: process.versions.electron,
    appVersion: electronApp.getVersion(),
    shown: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
  }));
  assert.equal(evidence.desktop.shown, true);
  await selectProject(page, nestedProject.id);
  const happyRow = page.locator(`[data-task-id="${uiHappy.id}"]`);
  await happyRow.waitFor();
  await bindBranchThroughDialog(page, happyRow, repository, "ui/happy");
  await happyRow.locator(".task-branch").getByText("Branch ui/happy", { exact: true }).waitFor();
  assert.match(await happyRow.innerText(), /Visible brief metadata/);
  assert.match(await happyRow.getAttribute("aria-label"), /branch ui\/happy/);
  evidence.checks.desktopBranchMetadataVisible = true;

  const conflictRow = page.locator(`[data-task-id="${uiConflict.id}"]`);
  await conflictRow.waitFor();
  await conflictRow.click({ button: "right" });
  await page.getByRole("menu", { name: "UI conflict actions" }).getByRole("menuitem", { name: /Bind branch/ }).click();
  await page.getByLabel("Repository path").fill(repository);
  await page.getByLabel("Existing branch").fill("ui/happy");
  await page.getByRole("dialog").getByRole("button", { name: "Bind branch", exact: true }).click();
  const conflictAlert = page.getByRole("alert");
  await conflictAlert.waitFor();
  assert.equal(await conflictAlert.innerText(), `Branch is already held by Task ${uiHappy.id}.`);
  evidence.checks.desktopTypedHolderConflict = true;
  await app.close();
  app = undefined;

  await stopServer(server);
  server = await startServer();
  record = await readRecord(server.pid);
  const persisted = (await controlCall(record, "task.list", { projectId: nestedProject.id })).find((task) => task.id === contender.id);
  assert.deepEqual(persisted.branch, { repository_root: await realpath(repository), name: "main" });
  evidence.checks.restartDurability = true;

  const after = await indexState();
  assertNoIndexLocks(after);
  assert.deepEqual(after, before);
  evidence.checks.indexesUnchanged = true;
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  subscription?.close();
  if (app) await app.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  evidence.status = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0 ? "PASS" : "FAIL";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await rm(temporary, { recursive: true, force: true });
  if (evidence.status !== "PASS") process.exitCode = 1;
}

async function initializeRepository() {
  git(projectScope, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "TermLoop Fixture"]);
  git(repository, ["config", "user.email", "fixture@termloop.invalid"]);
  await writeFile(path.join(repository, "tracked.txt"), "fixture\n");
  git(repository, ["add", "--", "tracked.txt"]);
  git(repository, ["commit", "-m", "fixture"], { GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" });
  git(repository, ["branch", "feature/checked-out"]);
  git(repository, ["branch", "ui/happy"]);
  git(repository, ["worktree", "add", "--detach", linked, "HEAD"]);
  git(linked, ["switch", "feature/checked-out"]);
  git(projectScope, ["init", "--bare", "--initial-branch=main", bareRepository]);
  await mkdir(insideRepository, { recursive: true });
}

function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", ["-c", `core.hooksPath=${emptyHooksDirectory}`, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalGitConfig,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
      ...extraEnv,
    },
  });
}

function assertNoIndexLocks(state) {
  for (const value of Object.values(state)) assert.equal(value.lock, false);
}

async function indexState() {
  const paths = [repository, linked].map((cwd) => {
    const value = git(cwd, ["rev-parse", "--git-path", "index"]).trim();
    return path.isAbsolute(value) ? value : path.join(cwd, value);
  });
  const result = {};
  for (const indexPath of paths) {
    const bytes = await readFile(indexPath);
    result[indexPath] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      lock: await access(path.join(path.dirname(indexPath), "index.lock")).then(() => true, () => false),
    };
  }
  return result;
}

async function createProject(record, name, folderPath) {
  return controlCall(record, "project.create", { name, folderPath });
}

async function createTask(record, projectId, title, brief = null) {
  return controlCall(record, "task.create", { projectId, title, brief, worktreeIntent: "none" });
}

function assertConflict(response, kind, taskId) {
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "conflict");
  assert.deepEqual(response.error?.details, { kind, taskId });
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
  throw new Error(`${method}: ${response.error?.code ?? "failed"}: ${response.error?.message ?? "failed"}`);
}

async function rawControlCall(record, token, method, params = {}) {
  const socket = new WebSocket(record.controlUrl);
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 8_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token, method, params })));
    socket.once("message", (raw) => {
      clearTimeout(timeout); socket.close(); resolve(JSON.parse(String(raw)));
    });
    socket.once("error", reject);
  });
}

async function subscribeToTasks(record) {
  const socket = new WebSocket(record.controlUrl);
  const id = randomUUID();
  const invalidations = [];
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("control.subscribe timed out")), 8_000);
    socket.once("open", () => socket.send(JSON.stringify({
      id,
      protocolVersion: record.protocolVersion,
      token: record.token,
      method: "control.subscribe",
      params: { topics: ["task"] },
    })));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id === id) {
        clearTimeout(timeout);
        if (message.ok) resolve(message.result);
        else reject(new Error(`control.subscribe: ${message.error?.message ?? "failed"}`));
      } else if (message.event === "projection.invalidated") {
        invalidations.push(message.payload);
      }
    });
    socket.once("error", reject);
  });
  return {
    stateRevision: result.stateRevision,
    close: () => socket.close(),
    async waitForInvalidationAfter(revision) {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const index = invalidations.findIndex((payload) => payload.stateRevision > revision);
        if (index >= 0) return invalidations.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Task invalidation after revision ${revision} was not observed`);
    },
    async expectNoInvalidation(message) {
      await new Promise((resolve) => setTimeout(resolve, invalidationQuietWindowMs));
      assert.equal(
        invalidations.length,
        0,
        message,
      );
    },
  };
}

async function launchDesktop() {
  const launched = await electron.launch({
    args: [path.join(root, "clients/desktop")],
    cwd: root,
    env: {
      ...process.env,
      TERMLOOP_RUNTIME_FILE: runtimeFile,
      TERMLOOP_DESKTOP_USER_DATA_DIR: electronUserDataDirectory,
    },
  });
  const page = await launched.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  await page.getByRole("button", { name: "Create Task" }).waitFor();
  return { app: launched };
}

async function bindBranchThroughDialog(page, taskRow, repositoryPath, branchName) {
  await taskRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Bind branch/ }).click();
  await page.getByLabel("Repository path").fill(repositoryPath);
  await page.getByLabel("Existing branch").fill(branchName);
  await page.getByRole("dialog").getByRole("button", { name: "Bind branch", exact: true }).click();
}

async function selectProject(page, projectId) {
  await page.getByRole("button", { name: "Current Project" }).click();
  await page.locator(`[data-project-option-id="${projectId}"]`).click();
}

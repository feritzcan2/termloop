import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f2-worktree-provisioning-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const repository = path.join(temporary, "repository");
const linked = path.join(temporary, "linked-existing");
const destination = path.join(temporary, "managed worktree");
const existingDestination = path.join(temporary, "existing branch worktree");
const uiDestination = path.join(temporary, "ui managed worktree");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f2/worktree-provisioning.local.json");
const globalGitConfig = path.join(temporary, "global.gitconfig");
const emptyHooksDirectory = path.join(temporary, "empty-hooks");
const gitProxyDirectory = path.join(temporary, "git-proxy");
const gitControlFile = path.join(temporary, "git-control");
const gitEnteredFile = `${gitControlFile}.entered`;
const invalidationQuietWindowMs = 500;

await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(emptyHooksDirectory, { recursive: true }),
  mkdir(gitProxyDirectory, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
  writeFile(globalGitConfig, ""),
]);
await installGitProxy();
git(temporary, ["init", "--initial-branch=main", repository]);
git(repository, ["config", "user.name", "TermLoop Fixture"]);
git(repository, ["config", "user.email", "fixture@termloop.invalid"]);
git(repository, ["commit", "--allow-empty", "-m", "fixture"], {
  GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
});
git(repository, ["branch", "checked-out"]);
git(repository, ["branch", "existing-free"]);
git(repository, ["worktree", "add", linked, "checked-out"]);

const evidence = {
  schema: "f2-worktree-provisioning-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release(), git: git(repository, ["--version"]).trim() },
  checks: {
    createModeSuccess: false,
    existingModeSuccess: false,
    freshExistingDestinationRejected: false,
    liveSameSpecCoalesced: false,
    coreResponsiveDuringGit: false,
    runningSuccessInvalidationOrder: false,
    runningFailureInvalidationOrder: false,
    rollbackRetrySuccess: false,
    bindingAndProofDurable: false,
    liveCompletionInvalidationQuietWindow: false,
    completedRetryNoMutationOrInvalidation: false,
    operationIdReuseTypedConflict: false,
    checkedOutBranchTypedConflict: false,
    readOnlyDenied: false,
    restartSnapshotConvergence: false,
    desktopShownSuccess: false,
    desktopTypedCheckedOutConflict: false,
    desktopInterruptedRetry: false,
    desktopRecoveryAttentionNonDismissible: false,
    indexesUnchangedAndUnlocked: false,
  },
  skipped: {
    crossPlatformRuntime: "local host only",
    nonUtfPath: process.platform === "win32" ? "not representable by the host path model" : "not exercised through the JSON control protocol",
    processKillMatrix: "covered by durable journal and primitive unit fixtures; external kill injection remains unmeasured locally",
    filesystemCaseFolding: "host volume capability not asserted",
  },
  measurements: { invalidationQuietWindowMs },
  desktop: {},
  failures: [],
};

let server;
let app;
let subscription;
try {
  const beforeIndexes = await indexState([repository, linked]);
  server = await startServer();
  let record = await readRecord(server.pid);
  const project = await controlCall(record, "project.create", { name: "Provisioning", folderPath: repository });
  const task = await createTask(record, project.id, "Managed checkout");
  const checkedOutTask = await createTask(record, project.id, "Checked-out conflict");
  const existingTask = await createTask(record, project.id, "Existing branch checkout");
  const uiTask = await createTask(record, project.id, "UI worktree", "Visible provisioning brief");
  const retryTask = await createTask(record, project.id, "Retry interrupted worktree");
  const attentionTask = await createTask(record, project.id, "Recovery attention worktree");
  const existingPathTask = await createTask(record, project.id, "Existing path conflict");
  const operationId = randomUUID();

  await new Promise((resolve) => setTimeout(resolve, 150));
  subscription = await subscribeToTasks(record);
  const subscribedRevision = subscription.stateRevision;
  const params = {
    operationId,
    taskId: task.id,
    repositoryPath: repository,
    destinationPath: destination,
    branchName: "feature/managed",
    branchMode: "create",
    baseRef: "refs/heads/main",
  };
  await setGitControl("block");
  const firstPromise = controlCall(record, "task.provisionWorktree", params);
  await waitForFile(gitEnteredFile);
  const runningEvent = await subscription.waitForInvalidationAfter(subscribedRevision);
  const runningSnapshot = (await controlCall(record, "task.list", { projectId: project.id, archiveScope: "active" })).items
    .find((candidate) => candidate.id === task.id);
  assert.equal(runningSnapshot.worktree_provisioning.status, "running");
  const pingStarted = Date.now();
  await controlCall(record, "system.ping");
  assert.equal(Date.now() - pingStarted < 1_000, true, "core stayed locked behind Git");
  evidence.checks.coreResponsiveDuringGit = true;
  const coalesced = await controlCall(record, "task.provisionWorktree", {
    ...params,
    operationId: randomUUID(),
  });
  assert.equal(coalesced.provisioning.status, "running");
  assert.equal(coalesced.provisioning.operation_id, operationId);
  evidence.checks.liveSameSpecCoalesced = true;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const runningStageEvents = subscription.takeInvalidations();
  const latestRunningRevision = Math.max(
    runningEvent.stateRevision,
    ...runningStageEvents.map((event) => event.stateRevision),
  );
  await clearGitControl();
  const first = await firstPromise;
  assert.equal(first.task.branch.name, "feature/managed");
  assert.equal(first.task.worktree.path, await realpath(destination));
  assert.equal(first.provisioning, null);
  assert.equal(git(destination, ["symbolic-ref", "--short", "HEAD"]).trim(), "feature/managed");
  evidence.checks.createModeSuccess = true;
  const event = await subscription.waitForInvalidationAfter(latestRunningRevision);
  assert.deepEqual(event.topics, ["task"]);
  await subscription.expectNoInvalidation("unexpected invalidation after completion quiet window");
  evidence.checks.runningSuccessInvalidationOrder = true;
  evidence.checks.liveCompletionInvalidationQuietWindow = true;

  const existingPromise = controlCall(record, "task.provisionWorktree", {
    operationId: randomUUID(),
    taskId: existingTask.id,
    repositoryPath: repository,
    destinationPath: existingDestination,
    branchName: "existing-free",
    branchMode: "existing",
  });
  const existingRunningEvent = await subscription.waitForInvalidationAfter(event.stateRevision);
  const existing = await existingPromise;
  assert.equal(existing.task.branch.name, "existing-free");
  assert.equal(existing.task.worktree.path, await realpath(existingDestination));
  assert.equal(git(existingDestination, ["symbolic-ref", "--short", "HEAD"]).trim(), "existing-free");
  const existingEvent = await subscription.waitForInvalidationAfter(existingRunningEvent.stateRevision);
  await subscription.expectNoInvalidation("existing-branch completion quiet window failed");
  evidence.checks.existingModeSuccess = true;

  const occupiedDestination = path.join(temporary, "already exists empty");
  await mkdir(occupiedDestination);
  const occupied = await rawControlCall(record, record.token, "task.provisionWorktree", {
    operationId: randomUUID(),
    taskId: existingPathTask.id,
    repositoryPath: repository,
    destinationPath: occupiedDestination,
    branchName: "feature/occupied",
    branchMode: "create",
    baseRef: "refs/heads/main",
  });
  assert.equal(occupied.error?.code, "conflict");
  const occupiedTask = (await controlCall(record, "task.list", { projectId: project.id, archiveScope: "active" })).items
    .find((candidate) => candidate.id === existingPathTask.id);
  assert.equal(occupiedTask.worktree_provisioning, undefined);
  await subscription.expectNoInvalidation("fresh existing destination created a journal invalidation");
  evidence.checks.freshExistingDestinationRejected = true;

  const retryDestination = path.join(temporary, "retry managed worktree");
  const retryOperationId = randomUUID();
  const retryParams = {
    operationId: retryOperationId,
    taskId: retryTask.id,
    repositoryPath: repository,
    destinationPath: retryDestination,
    branchName: "feature/retry-managed",
    branchMode: "create",
    baseRef: "refs/heads/main",
  };
  await setGitControl("block-fail");
  const failedPromise = rawControlCall(record, record.token, "task.provisionWorktree", retryParams);
  await waitForFile(gitEnteredFile);
  const failedRunningEvent = await subscription.waitForInvalidationAfter(existingEvent.stateRevision);
  const failedRunningSnapshot = (await controlCall(record, "task.list", { projectId: project.id, archiveScope: "active" })).items
    .find((candidate) => candidate.id === retryTask.id);
  assert.equal(failedRunningSnapshot.worktree_provisioning.status, "running");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const failedRunningStageEvents = subscription.takeInvalidations();
  const latestFailedRunningRevision = Math.max(
    failedRunningEvent.stateRevision,
    ...failedRunningStageEvents.map((event) => event.stateRevision),
  );
  await clearGitControl();
  const failed = await failedPromise;
  assert.equal(failed.ok, false);
  const failedEvent = await subscription.waitForInvalidationAfter(latestFailedRunningRevision);
  const failedSnapshot = (await controlCall(record, "task.list", { projectId: project.id, archiveScope: "active" })).items
    .find((candidate) => candidate.id === retryTask.id);
  assert.equal(failedSnapshot.worktree_provisioning.status, "failed");
  assert.equal(gitExit(repository, ["show-ref", "--verify", "--quiet", "refs/heads/feature/retry-managed"]), 1);
  evidence.checks.runningFailureInvalidationOrder = true;

  const attentionDestination = path.join(temporary, "attention managed worktree");
  const attentionOperationId = randomUUID();
  await setGitControl("add-then-fail");
  const attention = await rawControlCall(record, record.token, "task.provisionWorktree", {
    operationId: attentionOperationId,
    taskId: attentionTask.id,
    repositoryPath: repository,
    destinationPath: attentionDestination,
    branchName: "feature/attention-managed",
    branchMode: "create",
    baseRef: "refs/heads/main",
  });
  assertConflict(attention, {
    kind: "worktreeRecoveryAttention",
    operationId: attentionOperationId,
  });
  await subscription.waitForInvalidationAfter(failedEvent.stateRevision);
  subscription.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  subscription = await subscribeToTasks(record);

  const revision = subscription.stateRevision;
  const retry = await controlCall(record, "task.provisionWorktree", params);
  assert.deepEqual(retry, first);
  await subscription.expectNoInvalidation("completed retry emitted an invalidation");
  evidence.checks.completedRetryNoMutationOrInvalidation = true;

  const reused = await rawControlCall(record, record.token, "task.provisionWorktree", {
    ...params,
    destinationPath: path.join(temporary, "different destination"),
  });
  assertConflict(reused, { kind: "operationIdReused", operationId });
  evidence.checks.operationIdReuseTypedConflict = true;

  const checkedOut = await rawControlCall(record, record.token, "task.provisionWorktree", {
    operationId: randomUUID(),
    taskId: checkedOutTask.id,
    repositoryPath: repository,
    destinationPath: path.join(temporary, "must-not-exist"),
    branchName: "checked-out",
    branchMode: "existing",
  });
  assertConflict(checkedOut, { kind: "branchCheckedOutElsewhere", worktreePath: await realpath(linked) });
  evidence.checks.checkedOutBranchTypedConflict = true;

  const denied = await rawControlCall(record, record.readOnlyToken, "task.provisionWorktree", params);
  assert.equal(denied.error?.code, "capabilityDenied");
  evidence.checks.readOnlyDenied = true;
  subscription.close();
  subscription = undefined;

  ({ app } = await launchDesktop());
  const page = await app.firstWindow();
  evidence.desktop = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    electron: process.versions.electron,
    appVersion: electronApp.getVersion(),
    shown: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
  }));
  assert.equal(evidence.desktop.shown, true);
  await selectProject(page, project.id);
  const uiRow = page.locator(`[data-task-id="${uiTask.id}"]`);
  await uiRow.waitFor();
  await uiRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Create worktree/ }).click();
  await page.getByLabel("New worktree path").fill(uiDestination);
  await page.getByLabel("Branch source").selectOption("create");
  await page.getByLabel("Branch name").fill("feature/ui");
  await page.getByLabel("Exact base ref").selectOption("refs/heads/main");
  await page.getByRole("dialog").getByRole("button", { name: "Create worktree", exact: true }).click();
  await uiRow.locator(".task-branch").getByText("Branch feature/ui", { exact: true }).waitFor();
  assert.match(await uiRow.innerText(), /Visible provisioning brief/);
  assert.match(await uiRow.getAttribute("aria-label"), /worktree attached/);
  evidence.checks.desktopShownSuccess = true;

  const conflictRow = page.locator(`[data-task-id="${checkedOutTask.id}"]`);
  await conflictRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Create worktree/ }).click();
  await page.getByLabel("New worktree path").fill(path.join(temporary, "ui conflict destination"));
  await page.getByLabel("Branch name").selectOption("checked-out");
  await page.getByRole("dialog").getByRole("button", { name: "Create worktree", exact: true }).click();
  const alert = page.getByRole("alert");
  await alert.waitFor();
  assert.equal(await alert.innerText(), `Branch is already checked out at ${await realpath(linked)}.`);
  evidence.checks.desktopTypedCheckedOutConflict = true;
  await page.getByRole("button", { name: "Close dialog" }).click();

  const retryRow = page.locator(`[data-task-id="${retryTask.id}"]`);
  await retryRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Create worktree/ }).click();
  await page.getByLabel("New worktree path").fill(retryDestination);
  await page.getByLabel("Branch source").selectOption("create");
  await page.getByLabel("Branch name").fill("feature/retry-managed");
  await page.getByLabel("Exact base ref").selectOption("refs/heads/main");
  await page.getByRole("dialog").getByRole("button", { name: "Create worktree", exact: true }).click();
  await retryRow.locator(".task-branch").getByText("Branch feature/retry-managed", { exact: true }).waitFor();
  evidence.checks.rollbackRetrySuccess = true;
  evidence.checks.desktopInterruptedRetry = true;

  const attentionRow = page.locator(`[data-task-id="${attentionTask.id}"]`);
  await attentionRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Dismiss failure" }).waitFor({ state: "detached" });
  assert.match(await attentionRow.getAttribute("aria-label"), /worktree provisioning failed/);
  evidence.checks.desktopRecoveryAttentionNonDismissible = true;
  await app.close();
  app = undefined;

  await stopServer(server);
  server = await startServer();
  record = await readRecord(server.pid);
  const snapshot = (await controlCall(record, "task.list", { projectId: project.id, archiveScope: "active" })).items.find((candidate) => candidate.id === task.id);
  assert.deepEqual(snapshot.branch, first.task.branch);
  assert.deepEqual(snapshot.worktree, first.task.worktree);
  const restartSubscription = await subscribeToTasks(record);
  const restartedRevision = restartSubscription.stateRevision;
  const restartedRetry = await controlCall(record, "task.provisionWorktree", params);
  assert.deepEqual(restartedRetry, first);
  assert.equal(restartSubscription.stateRevision, restartedRevision);
  await restartSubscription.expectNoInvalidation("restart retry emitted an invalidation");
  restartSubscription.close();
  evidence.checks.restartSnapshotConvergence = true;
  const durableState = JSON.parse(await readFile(path.join(stateDirectory, "state.v1.json"), "utf8"));
  const proof = durableState.managed_worktrees.find((candidate) => candidate.operation_id === operationId);
  assert.equal(proof.normalized_spec_version, 1);
  assert.equal(proof.normalized_spec.operation_id, undefined);
  assert.equal(proof.normalized_spec.destination_path, await realpath(destination));
  assert.equal(
    durableState.provisioning_operations.some((operation) => operation.task_id === task.id),
    false,
  );
  const attentionJournal = durableState.provisioning_operations.find(
    (operation) => operation.task_id === attentionTask.id,
  );
  assert.equal(attentionJournal.failure, "recoveryAttention");
  evidence.checks.bindingAndProofDurable = true;

  const afterIndexes = await indexState([repository, linked]);
  assert.deepEqual(afterIndexes, beforeIndexes);
  evidence.checks.indexesUnchangedAndUnlocked = true;
  assert.equal(revision <= restartedRevision, true);
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

function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", ["-c", `core.hooksPath=${emptyHooksDirectory}`, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalGitConfig, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C", ...extraEnv },
  });
}

function gitExit(cwd, args) {
  try {
    git(cwd, args);
    return 0;
  } catch (error) {
    return error?.status ?? 1;
  }
}

async function installGitProxy() {
  const actualGit = await findExecutable(process.platform === "win32" ? "git.exe" : "git");
  const proxy = path.join(gitProxyDirectory, process.platform === "win32" ? "git.exe" : "git");
  if (process.platform === "win32") {
    throw new Error("Git fault proxy is unmeasured on Windows");
  }
  await writeFile(proxy, `#!/usr/bin/env node
const { existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const control = ${JSON.stringify(gitControlFile)};
const isAdd = args[0] === "worktree" && args[1] === "add";
if (control && isAdd && existsSync(control)) {
  const mode = readFileSync(control, "utf8").trim();
  if (mode === "block" || mode === "block-fail") {
    writeFileSync(control + ".entered", "entered");
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    while (existsSync(control)) Atomics.wait(sleep, 0, 0, 20);
    if (mode === "block-fail") {
      process.stderr.write("fatal: injected worktree add failure\\n");
      process.exit(128);
    }
  } else if (mode === "fail") {
    rmSync(control, { force: true });
    process.stderr.write("fatal: injected worktree add failure\\n");
    process.exit(128);
  } else if (mode === "add-then-fail") {
    rmSync(control, { force: true });
    const added = spawnSync(${JSON.stringify(actualGit)}, args, { stdio: "inherit", env: process.env });
    if ((added.status ?? 1) !== 0) process.exit(added.status ?? 1);
    process.stderr.write("fatal: injected post-add failure\\n");
    process.exit(128);
  }
}
const result = spawnSync(${JSON.stringify(actualGit)}, args, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`);
  await chmod(proxy, 0o755);
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`${name} was not found on PATH`);
}

async function setGitControl(mode) {
  await rm(gitEnteredFile, { force: true });
  await writeFile(gitControlFile, mode);
}

async function clearGitControl() {
  await rm(gitControlFile, { force: true });
}

async function waitForFile(file) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await access(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

async function indexState(worktrees) {
  const result = {};
  for (const cwd of worktrees) {
    const value = git(cwd, ["rev-parse", "--git-path", "index"]).trim();
    const indexPath = path.isAbsolute(value) ? value : path.join(cwd, value);
    result[indexPath] = {
      sha256: createHash("sha256").update(await readFile(indexPath)).digest("hex"),
      lock: await access(path.join(path.dirname(indexPath), "index.lock")).then(() => true, () => false),
    };
  }
  return result;
}

async function createTask(record, projectId, title, brief = null) {
  return controlCall(record, "task.create", { projectId, title, brief, worktreeIntent: "none" });
}

function assertConflict(response, details) {
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "conflict");
  assert.deepEqual(response.error?.details, details);
}

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${gitProxyDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      TERMLOOP_RUNTIME_DIR: runtimeDirectory,
      TERMLOOP_STATE_DIR: stateDirectory,
    },
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
    socket.once("message", (raw) => { clearTimeout(timeout); socket.close(); resolve(JSON.parse(String(raw))); });
    socket.once("error", reject);
  });
}

async function subscribeToTasks(record) {
  const socket = new WebSocket(record.controlUrl);
  const id = randomUUID();
  const invalidations = [];
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("control.subscribe timed out")), 8_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.token, method: "control.subscribe", params: { topics: ["task"] } })));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id === id) {
        clearTimeout(timeout);
        if (message.ok) resolve(message.result); else reject(new Error(message.error?.message ?? "subscribe failed"));
      } else if (message.event === "projection.invalidated") invalidations.push(message.payload);
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
      assert.equal(invalidations.length, 0, message);
    },
    takeInvalidations() {
      return invalidations.splice(0);
    },
  };
}

async function launchDesktop() {
  const launched = await electron.launch({
    args: [path.join(root, "clients/desktop")],
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_FILE: runtimeFile, TERMLOOP_DESKTOP_USER_DATA_DIR: electronUserDataDirectory },
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

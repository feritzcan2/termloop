import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f2-worktree-cleanup-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const electronUserDataDirectory = path.join(temporary, "electron");
const repository = path.join(temporary, "repository");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const traceFile = path.join(temporary, "git-trace.json");
const injectDirtyOnRemoveMarker = path.join(temporary, "inject-dirty-on-remove");
const proxyDirectory = path.join(temporary, "git-proxy");
const emptyHooks = path.join(temporary, "empty-hooks");
const globalConfig = path.join(temporary, "global.gitconfig");
const destructiveAcceptance = process.env.TERMLOOP_F2_DESTRUCTIVE === "1";
const evidencePath = path.join(root, destructiveAcceptance
  ? "artifacts/evidence/f2/destructive-worktree-cleanup.local.json"
  : "artifacts/evidence/f2/worktree-cleanup.local.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const idleWindowMs = Number(process.env.TERMLOOP_F2_IDLE_WINDOW_MS ?? 65_000);
const realGit = await findExecutable(process.platform === "win32" ? "git.exe" : "git");

await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(proxyDirectory, { recursive: true }),
  mkdir(emptyHooks, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
  writeFile(globalConfig, ""),
  writeFile(traceFile, ""),
]);
if (process.platform === "win32") throw new Error("local watcher/process acceptance is not implemented on Windows");
await installGitProxy();
git(temporary, ["init", "--initial-branch=main", repository]);
git(repository, ["config", "user.name", "TermLoop Fixture"]);
git(repository, ["config", "user.email", "fixture@termloop.invalid"]);
await writeFile(path.join(repository, ".gitignore"), ".env\nnode_modules\ntarget\n");
await writeFile(path.join(repository, "tracked.txt"), "base\n");
git(repository, ["add", ".gitignore", "tracked.txt"]);
git(repository, ["commit", "-m", "fixture"], {
  GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
});

const evidence = {
  schema: destructiveAcceptance ? "f2-destructive-worktree-cleanup-v2" : "f2-worktree-cleanup-v2",
  capturedAt: new Date().toISOString(),
  command: destructiveAcceptance ? "pnpm acceptance:f2-destructive-worktree-cleanup" : "pnpm acceptance:f2-worktree-cleanup",
  daemon: null,
  host: { platform: process.platform, arch: process.arch, release: os.release(), git: git(repository, ["--version"]).trim() },
  checks: {
    fiftyTaskInitialHealth: false,
    idleNoGitEventRefetchOrRender: false,
    scopedSingleTaskRefresh: false,
    repairSingleScopedInvalidation: false,
    cleanCleanupPreservesBranchAndTask: false,
    completedReplayNoMutation: false,
    staleGenerationRefused: false,
    ignoredContentRefused: false,
    destructiveEligibleCategoriesRemoved: false,
    destructiveShownAcknowledgement: false,
    destructivePreservesTaskBranchAndRepository: false,
    failedSafeCleanupSupersededByDestructive: false,
    liveSessionRefused: false,
    shownHealthPresenceLifecycle: false,
    liveSessionCleanupMutationRefused: false,
    absentPairClearsBinding: false,
    oneSidedAbsenceNeedsAttention: false,
    readOnlyDeniedBeforeGit: false,
    desktopShownCleanup: false,
    deleteRemainsSeparate: false,
    combinedDeleteRetiresSession: false,
    combinedDeleteRemovesWorktreeThenTask: false,
    combinedDeleteUsesOneConfirmation: false,
    alternateBranchShownAndCombinedDeleteEnabled: false,
    alternateBranchCleanupPreservesBothRefs: false,
  },
  measurements: {
    idleWindowMs,
    boundTasks: 50,
    initialHealthGitProcesses: 0,
    idleGitProcesses: 0,
    idleInvalidationEvents: 0,
    taskPatchDelta: 0,
    taskRowRenderDelta: 0,
    fullRefreshDelta: 0,
    scopedTaskPatchDelta: 0,
    scopedTaskRowRenderDelta: 0,
    repairInvalidationEvents: 0,
    repairTaskPatchDelta: 0,
    repairTaskRowRenderDelta: 0,
    repairFullRefreshDelta: 0,
    ignoredCategoriesRefused: 0,
    destructiveCategoriesRemoved: 0,
  },
  productVerdict: {
    ignoredContent: "ignored output is refused by safe cleanup and can be discarded only through the explicit irreversible acknowledgement",
  },
  skipped: {
    crossPlatformRuntime: "local host only; Windows/Linux watcher behavior remains unmeasured",
    processKillMatrix: "durable stage unit fixtures pass; external daemon kill injection remains unmeasured",
    externalWriterAfterFinalGate: "non-force refusal is covered by core/gitio fixtures; timing race remains unmeasured",
    caseDriveUnc: "not representable on this host",
    fallbackFakeClock: "the 300–360 second integrity fallback/jitter window is unit-design reviewed but not accelerated in this local run",
    watcherLifecycleRuntime: "shared-key/token/ref-count teardown has server unit coverage; repeated OS-handle cap/eviction/shutdown measurement remains open",
    hungRepositoryFairness: "round-robin/FIFO selection has server unit coverage; two hung repositories plus a third healthy real-Git run remains open",
    shownRecoveryMatrix: "shown clean cleanup and presence refusal pass; warning/replay/recovery-attention/retry dialogs remain unit or headless coverage",
    coldWarmPerJobProcesses: "initial and idle Trace2 totals are measured; separate cold/warm per-key job totals remain open",
  },
  failures: [],
};

let server;
let app;
let subscription;
try {
  server = await startServer();
  const record = await readRecord(server.pid);
  evidence.daemon = await call(record, "system.version");
  const project = await call(record, "project.create", { name: "Cleanup", folderPath: repository });
  const tasks = [];
  const worktrees = [];
  for (let index = 0; index < 50; index += 1) {
    const task = await call(record, "task.create", {
      projectId: project.id,
      title: `Cleanup ${index}`,
      brief: index === 5 ? "Shown cleanup fixture" : null,
      worktreeIntent: "none",
    });
    const destination = path.join(temporary, `worktree-${index}`);
    await call(record, "task.provisionWorktree", {
      operationId: randomUUID(),
      taskId: task.id,
      repositoryPath: repository,
      destinationPath: destination,
      branchName: `feature/cleanup-${index}`,
      branchMode: "create",
      baseRef: "refs/heads/main",
    });
    tasks.push(task);
    worktrees.push(destination);
  }

  const deniedTask = await taskById(record, project.id, tasks[6].id);
  await truncate(traceFile, 0);
  const denied = await rawCall(record, record.readOnlyToken, "task.cleanupWorktree", cleanupRequest(deniedTask));
  assert.equal(denied.error?.code, "capabilityDenied");
  assert.equal(await traceStartCount(), 0);
  evidence.checks.readOnlyDeniedBeforeGit = true;

  await truncate(traceFile, 0);
  subscription = await subscribe(record, project.id);
  await waitFor(async () => {
    const listed = (await call(record, "task.list", { projectId: project.id, archiveScope: "active" })).items;
    return listed.length === 50 && listed.every((task) => task.worktree_health) ? listed : undefined;
  }, 90_000, "initial health population");
  const initialProcesses = await traceStartCount();
  evidence.measurements.initialHealthGitProcesses = initialProcesses;
  assert.equal(initialProcesses <= 50 * 9, true, `initial health exceeded process budget: ${initialProcesses}`);
  evidence.checks.fiftyTaskInitialHealth = true;
  subscription.take();

  ({ app } = await launchDesktop());
  const page = await app.firstWindow();
  await selectProject(page, project.id);
  await page.locator(`[data-task-id="${tasks[49].id}"]`).waitFor();
  assert.equal(await page.locator('[data-testid="task-worktree-health"]').count(), 0);
  await page.locator(`[data-task-id="${tasks[0].id}"] [data-testid="task-worktree-presence"]`).waitFor();
  await waitForTraceQuiet(1_500);
  subscription.take();
  await truncate(traceFile, 0);
  const idleBefore = await diagnostics(page);
  await new Promise((resolve) => setTimeout(resolve, idleWindowMs));
  const idleAfter = await diagnostics(page);
  evidence.measurements.idleGitProcesses = await traceStartCount();
  evidence.measurements.fullRefreshDelta = idleAfter.full - idleBefore.full;
  evidence.measurements.taskPatchDelta = idleAfter.patch - idleBefore.patch;
  evidence.measurements.taskRowRenderDelta = idleAfter.rows - idleBefore.rows;
  assert.equal(evidence.measurements.idleGitProcesses, 0);
  assert.equal(evidence.measurements.fullRefreshDelta, 0);
  assert.equal(evidence.measurements.taskPatchDelta, 0);
  assert.equal(evidence.measurements.taskRowRenderDelta, 0);
  evidence.measurements.idleInvalidationEvents = subscription.take().length;
  assert.equal(evidence.measurements.idleInvalidationEvents, 0);
  evidence.checks.idleNoGitEventRefetchOrRender = true;

  const changedBefore = await diagnostics(page);
  await writeFile(path.join(worktrees[0], "untracked.txt"), "change\n");
  const changedEvent = await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(tasks[0].id));
  assert.deepEqual(changedEvent.entityScopes, [{ topic: "task", ids: [tasks[0].id] }]);
  await waitFor(async () => {
    const value = await diagnostics(page);
    return value.patch > changedBefore.patch ? value : undefined;
  }, 8_000, "desktop scoped Task patch");
  const changedAfter = await diagnostics(page);
  evidence.measurements.scopedTaskPatchDelta = changedAfter.patch - changedBefore.patch;
  evidence.measurements.scopedTaskRowRenderDelta = changedAfter.rows - changedBefore.rows;
  assert.equal(changedAfter.full, changedBefore.full);
  assert.equal(evidence.measurements.scopedTaskPatchDelta, 1);
  assert.equal(evidence.measurements.scopedTaskRowRenderDelta, 1);
  evidence.checks.scopedSingleTaskRefresh = true;
  await rm(path.join(worktrees[0], "untracked.txt"));
  await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(tasks[0].id));

  const repairDestination = path.join(temporary, "worktree-9-moved");
  await rename(worktrees[9], repairDestination);
  await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(tasks[9].id));
  const repairPreview = await call(record, "task.inspectWorktreeRepair", {
    taskId: tasks[9].id,
    candidatePath: repairDestination,
  });
  assert.equal(repairPreview.decision, "allowed");
  const repairParams = {
    operationId: randomUUID(),
    taskId: tasks[9].id,
    candidatePath: repairDestination,
    expectedManagedWorktreeOperationId: repairPreview.managed_worktree_operation_id,
    expectedWorktreeGeneration: repairPreview.worktree_generation,
  };
  subscription.take();
  const repairBefore = await diagnostics(page);
  const repairFailure = await page.evaluate(async (params) => {
    if (!window.termloopDiagnostics) return "diagnostics unavailable";
    return window.termloopDiagnostics.repairTaskWorktree(params);
  }, repairParams);
  assert.equal(repairFailure, undefined);
  const repairEvent = await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(tasks[9].id));
  assert.deepEqual(repairEvent.entityScopes, [{ topic: "task", ids: [tasks[9].id] }]);
  const repairAfter = await waitFor(async () => {
    const value = await diagnostics(page);
    return value.patch > repairBefore.patch ? value : undefined;
  }, 8_000, "repair scoped Task patch");
  await new Promise((resolve) => setTimeout(resolve, 750));
  const extraRepairEvents = subscription.take().filter((event) => event.entityScopes?.[0]?.ids?.includes(tasks[9].id));
  evidence.measurements.repairInvalidationEvents = 1 + extraRepairEvents.length;
  evidence.measurements.repairTaskPatchDelta = repairAfter.patch - repairBefore.patch;
  evidence.measurements.repairTaskRowRenderDelta = repairAfter.rows - repairBefore.rows;
  evidence.measurements.repairFullRefreshDelta = repairAfter.full - repairBefore.full;
  assert.equal(evidence.measurements.repairInvalidationEvents, 1);
  assert.equal(evidence.measurements.repairTaskPatchDelta, 1);
  assert.equal(evidence.measurements.repairTaskRowRenderDelta, 1);
  assert.equal(evidence.measurements.repairFullRefreshDelta, 0);
  evidence.checks.repairSingleScopedInvalidation = true;
  worktrees[9] = repairDestination;

  const cleanTask = await taskById(record, project.id, tasks[0].id);
  const preview = await waitFor(async () => {
    const value = await call(record, "task.inspectWorktreeCleanup", { taskId: cleanTask.id });
    return value.decision === "allowed" ? value : undefined;
  }, 8_000, "clean cleanup preview");
  const cleanupOperation = randomUUID();
  const cleanupParams = {
    operationId: cleanupOperation,
    taskId: cleanTask.id,
    expectedManagedWorktreeOperationId: preview.managed_worktree_operation_id,
    expectedWorktreeGeneration: preview.worktree_generation,
    cleanupMode: "safe",
    acknowledgedContentBlockers: [],
  };
  const cleaned = await call(record, "task.cleanupWorktree", cleanupParams);
  assert.equal(cleaned.outcome, "removed");
  assert.equal(cleaned.task.worktree, null);
  assert.equal(cleaned.task.branch.name, "feature/cleanup-0");
  assert.equal(gitExit(repository, ["show-ref", "--verify", "--quiet", "refs/heads/feature/cleanup-0"]), 0);
  assert.equal((await call(record, "task.list", { projectId: project.id, archiveScope: "active", taskIds: [tasks[0].id] })).items.length, 1);
  evidence.checks.cleanCleanupPreservesBranchAndTask = true;
  evidence.checks.deleteRemainsSeparate = true;
  const replay = await call(record, "task.cleanupWorktree", cleanupParams);
  assert.equal(replay.outcome, "alreadyCompleted");
  evidence.checks.completedReplayNoMutation = true;

  const replacement = path.join(temporary, "replacement-worktree");
  const reprovisioned = await call(record, "task.provisionWorktree", {
    operationId: randomUUID(),
    taskId: cleanTask.id,
    repositoryPath: repository,
    destinationPath: replacement,
    branchName: "feature/cleanup-0",
    branchMode: "existing",
  });
  const stale = await rawCall(record, record.token, "task.cleanupWorktree", cleanupParams);
  assert.equal(stale.error?.details?.kind, "managedWorktreeProofChanged");
  assert.equal(await realpath(replacement), reprovisioned.task.worktree.path);
  evidence.checks.staleGenerationRefused = true;

  const destructiveFixtures = [
    [tasks[1], async () => writeFile(path.join(worktrees[1], ".env"), "secret fixture\n"), "ignoredContent"],
    [tasks[7], async () => mkdir(path.join(worktrees[7], "node_modules")), "ignoredContent"],
    [tasks[8], async () => mkdir(path.join(worktrees[8], "target")), "ignoredContent"],
    [tasks[10], async () => writeFile(path.join(worktrees[10], "untracked.txt"), "local\n"), "untrackedContent"],
    [tasks[11], async () => writeFile(path.join(worktrees[11], "tracked.txt"), "changed\n"), "trackedChanges"],
    [tasks[12], async () => { await writeFile(path.join(worktrees[12], "tracked.txt"), "staged\n"); git(worktrees[12], ["add", "tracked.txt"]); }, "stagedChanges"],
  ];
  for (const [, createContent] of destructiveFixtures) await createContent();
  const shownDestructivePreview = await call(record, "task.inspectWorktreeCleanup", { taskId: tasks[1].id });
  assert.equal(shownDestructivePreview.decision, "refused");
  assert.equal(shownDestructivePreview.destructive_cleanup.status, "available");
  assert.equal(shownDestructivePreview.destructive_cleanup.eligible_blockers.includes("ignoredContent"), true);
  evidence.measurements.ignoredCategoriesRefused += 1;
  evidence.checks.ignoredContentRefused = true;

  const destructiveRow = page.locator(`[data-task-id="${tasks[1].id}"]`);
  subscription.take();
  const destructiveBefore = await diagnostics(page);
  await destructiveRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Cleanup worktree/ }).click();
  const destructiveDialog = page.getByRole("dialog", { name: /Cleanup/ });
  await destructiveDialog.getByText(/Irreversible checkout cleanup/).waitFor();
  await destructiveDialog.getByLabel(/cannot be recovered/).check();
  const warningAcknowledgement = destructiveDialog.getByLabel(/reviewed these warnings/);
  if (await warningAcknowledgement.count()) await warningAcknowledgement.check();
  await destructiveDialog.getByRole("button", { name: /Force cleanup and delete local files/ }).click();
  const destructiveEvent = await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(tasks[1].id));
  assert.deepEqual(destructiveEvent.entityScopes, [{ topic: "task", ids: [tasks[1].id] }]);
  const destructiveAfter = await waitFor(async () => {
    const value = await diagnostics(page);
    return value.patch > destructiveBefore.patch ? value : undefined;
  }, 8_000, "destructive scoped Task patch");
  assert.equal(destructiveAfter.full, destructiveBefore.full);
  assert.equal(destructiveAfter.patch - destructiveBefore.patch, 1);
  assert.equal(destructiveAfter.rows - destructiveBefore.rows, 1);
  evidence.checks.destructiveShownAcknowledgement = true;
  evidence.measurements.destructiveCategoriesRemoved += 1;

  for (const [task, , expectedBlocker] of destructiveFixtures.slice(1)) {
    const preview = await call(record, "task.inspectWorktreeCleanup", { taskId: task.id });
    assert.equal(preview.decision, "refused");
    assert.equal(preview.destructive_cleanup.status, "available");
    assert.equal(preview.destructive_cleanup.eligible_blockers.includes(expectedBlocker), true);
    if (expectedBlocker === "ignoredContent") evidence.measurements.ignoredCategoriesRefused += 1;
    const result = await call(record, "task.cleanupWorktree", {
      operationId: randomUUID(), taskId: task.id,
      expectedManagedWorktreeOperationId: preview.managed_worktree_operation_id,
      expectedWorktreeGeneration: preview.worktree_generation,
      cleanupMode: "discardCheckoutContent",
      acknowledgedContentBlockers: preview.destructive_cleanup.eligible_blockers,
    });
    assert.equal(result.outcome, "removed");
    assert.equal(result.task.worktree, null);
    evidence.measurements.destructiveCategoriesRemoved += 1;
  }
  assert.equal(evidence.measurements.destructiveCategoriesRemoved, destructiveFixtures.length);
  assert.equal(evidence.measurements.ignoredCategoriesRefused, 3);
  evidence.checks.destructiveEligibleCategoriesRemoved = true;
  assert.equal(gitExit(repository, ["show-ref", "--verify", "--quiet", "refs/heads/feature/cleanup-1"]), 0);
  assert.equal((await call(record, "task.list", { projectId: project.id, archiveScope: "active", taskIds: [tasks[1].id] })).items.length, 1);
  assert.equal(await access(repository).then(() => true, () => false), true);
  evidence.checks.destructivePreservesTaskBranchAndRepository = true;

  await writeFile(path.join(worktrees[9], ".env"), "combined destructive fixture\n");
  const combinedDestructiveSession = await call(record, "session.launchTerminal", { projectId: project.id, cwd: worktrees[9] });
  await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(tasks[9].id));
  const combinedDestructiveRow = page.locator(`[data-task-id="${tasks[9].id}"]`);
  await combinedDestructiveRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete Task and worktree" }).click();
  const combinedDestructiveDialog = page.getByRole("alertdialog", { name: /Delete/ });
  await combinedDestructiveDialog.getByText(/permanently deletes the Task, its worktree contents, and attached Sessions/i).waitFor();
  assert.equal(await combinedDestructiveDialog.getByRole("checkbox").count(), 0);
  await combinedDestructiveDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await waitFor(async () => (await combinedDestructiveRow.count()) === 0 ? true : undefined, 8_000, "combined destructive Task row removal");
  assert.equal(await combinedDestructiveRow.count(), 0, await combinedDestructiveDialog.innerText().catch(() => "Delete dialog closed without removing the Task row."));
  assert.equal(await access(worktrees[9]).then(() => true, () => false), false);
  assert.equal(gitExit(repository, ["show-ref", "--verify", "--quiet", "refs/heads/feature/cleanup-9"]), 0);
  assert.equal((await call(record, "session.list")).some((candidate) => candidate.id === combinedDestructiveSession.id), false);
  evidence.checks.combinedDeleteUsesOneConfirmation = true;

  const supersedeTask = await taskById(record, project.id, tasks[13].id);
  const supersedePreview = await call(record, "task.inspectWorktreeCleanup", { taskId: supersedeTask.id });
  assert.equal(supersedePreview.decision, "allowed");
  const failedSafeOperationId = randomUUID();
  await writeFile(injectDirtyOnRemoveMarker, "inject once\n");
  const failedSafe = await rawCall(record, record.token, "task.cleanupWorktree", {
    operationId: failedSafeOperationId,
    taskId: supersedeTask.id,
    expectedManagedWorktreeOperationId: supersedePreview.managed_worktree_operation_id,
    expectedWorktreeGeneration: supersedePreview.worktree_generation,
    cleanupMode: "safe",
    acknowledgedContentBlockers: [],
  });
  assert.equal(failedSafe.ok, false);
  assert.equal(await access(worktrees[13]).then(() => true, () => false), true);
  const destructiveRetryPreview = await call(record, "task.inspectWorktreeCleanup", { taskId: supersedeTask.id });
  assert.equal(destructiveRetryPreview.destructive_cleanup.status, "available");
  assert.equal(destructiveRetryPreview.destructive_cleanup.eligible_blockers.includes("untrackedContent"), true);
  const changedSameId = await rawCall(record, record.token, "task.cleanupWorktree", {
    operationId: failedSafeOperationId,
    taskId: supersedeTask.id,
    expectedManagedWorktreeOperationId: destructiveRetryPreview.managed_worktree_operation_id,
    expectedWorktreeGeneration: destructiveRetryPreview.worktree_generation,
    cleanupMode: "discardCheckoutContent",
    acknowledgedContentBlockers: destructiveRetryPreview.destructive_cleanup.eligible_blockers,
  });
  assert.equal(changedSameId.error?.details?.kind, "operationIdReused");
  const superseded = await call(record, "task.cleanupWorktree", {
    operationId: randomUUID(),
    taskId: supersedeTask.id,
    expectedManagedWorktreeOperationId: destructiveRetryPreview.managed_worktree_operation_id,
    expectedWorktreeGeneration: destructiveRetryPreview.worktree_generation,
    cleanupMode: "discardCheckoutContent",
    acknowledgedContentBlockers: destructiveRetryPreview.destructive_cleanup.eligible_blockers,
  });
  assert.equal(superseded.outcome, "removed");
  assert.equal(superseded.task.worktree, null);
  evidence.checks.failedSafeCleanupSupersededByDestructive = true;

  const session = await call(record, "session.launchTerminal", { projectId: project.id, cwd: worktrees[2] });
  await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(tasks[2].id));
  await page.locator(`[data-task-id="${tasks[2].id}"] [data-testid="task-worktree-presence"]`).getByText(/1 attached/i).waitFor();
  const inUse = await call(record, "task.inspectWorktreeCleanup", { taskId: tasks[2].id });
  assert.equal(inUse.blockers.includes("sessionAttached"), true);
  const refusedCleanup = await rawCall(record, record.token, "task.cleanupWorktree", cleanupRequest(await taskById(record, project.id, tasks[2].id)));
  assert.equal(refusedCleanup.error?.details?.kind, "worktreeCleanupRefused");
  assert.equal(refusedCleanup.error?.details?.blockers?.includes("sessionAttached"), true);
  evidence.checks.liveSessionCleanupMutationRefused = true;
  await call(record, "session.terminate", { sessionId: session.id });
  await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(tasks[2].id));
  await page.locator(`[data-task-id="${tasks[2].id}"] [data-testid="task-worktree-presence"]`).getByText(/no attached sessions/i).waitFor();
  evidence.checks.shownHealthPresenceLifecycle = true;
  evidence.checks.liveSessionRefused = true;

  const absentTask = await taskById(record, project.id, tasks[3].id);
  git(repository, ["worktree", "remove", worktrees[3]]);
  const absent = await call(record, "task.cleanupWorktree", cleanupRequest(absentTask));
  assert.equal(absent.outcome, "bindingCleared");
  evidence.checks.absentPairClearsBinding = true;

  const oneSidedTask = await taskById(record, project.id, tasks[4].id);
  await rm(worktrees[4], { recursive: true, force: true });
  const oneSided = await rawCall(record, record.token, "task.cleanupWorktree", cleanupRequest(oneSidedTask));
  assert.equal(oneSided.error?.details?.kind, "worktreeCleanupRecoveryAttention");
  evidence.checks.oneSidedAbsenceNeedsAttention = true;

  const combinedSession = await call(record, "session.launchTerminal", { projectId: project.id, cwd: worktrees[5] });
  await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(tasks[5].id));
  const uiRow = page.locator(`[data-task-id="${tasks[5].id}"]`);
  await uiRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete Task and worktree" }).click();
  const dialog = page.getByRole("alertdialog", { name: /Delete/ });
  await dialog.getByText(/permanently deletes the Task, its worktree contents, and attached Sessions/i).waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  const combinedDeleteButton = dialog.getByRole("button", { name: "Delete", exact: true });
  await combinedDeleteButton.click();
  await waitFor(async () => (await uiRow.count()) === 0 ? true : undefined, 8_000, "combined Task row removal");
  assert.equal(await uiRow.count(), 0, await dialog.innerText().catch(() => "Delete dialog closed without removing the Task row."));
  assert.equal(await access(worktrees[5]).then(() => true, () => false), false);
  assert.equal((await call(record, "session.list")).some((candidate) => candidate.id === combinedSession.id), false);
  assert.equal(gitExit(repository, ["show-ref", "--verify", "--quiet", "refs/heads/feature/cleanup-5"]), 0);
  evidence.checks.desktopShownCleanup = true;
  const remaining = (await call(record, "task.list", { projectId: project.id, archiveScope: "active", taskIds: [tasks[5].id, tasks[1].id] })).items;
  assert.deepEqual(remaining.map((task) => task.id), [tasks[1].id]);
  evidence.checks.combinedDeleteRetiresSession = true;
  evidence.checks.combinedDeleteRemovesWorktreeThenTask = true;

  const alternateTask = tasks[14];
  const alternateWorktree = worktrees[14];
  const alternateBranch = "agent/alternate-delete";
  git(alternateWorktree, ["checkout", "-b", alternateBranch]);
  const alternatePreview = await call(record, "task.inspectWorktreeCleanup", { taskId: alternateTask.id });
  assert.equal(alternatePreview.blockers.includes("branchMismatch"), false);
  assert.equal(alternatePreview.blockers.includes("headMismatch"), false);
  const alternateSession = await call(record, "session.launchTerminal", { projectId: project.id, cwd: alternateWorktree });
  await subscription.next((event) => event.entityScopes?.[0]?.ids?.includes(alternateTask.id));
  const alternateRow = page.locator(`[data-task-id="${alternateTask.id}"]`);
  await alternateRow.locator(".task-checked-out-branch").getByText(`→ ${alternateBranch}`).waitFor();
  await alternateRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete Task and worktree" }).click();
  const alternateDialog = page.getByRole("alertdialog", { name: /Delete/ });
  await alternateDialog.getByText(/permanently deletes the Task, its worktree contents, and attached Sessions/i).waitFor();
  assert.equal(await alternateDialog.getByRole("checkbox").count(), 0);
  const alternateDeleteButton = alternateDialog.getByRole("button", { name: "Delete", exact: true });
  await alternateDeleteButton.waitFor();
  await waitFor(async () => await alternateDeleteButton.isEnabled(), 8_000, "enabled alternate-branch combined delete");
  evidence.checks.alternateBranchShownAndCombinedDeleteEnabled = true;
  await alternateDeleteButton.click();
  await alternateRow.waitFor({ state: "detached" });
  assert.equal(await access(alternateWorktree).then(() => true, () => false), false);
  assert.equal((await call(record, "session.list")).some((candidate) => candidate.id === alternateSession.id), false);
  assert.equal((await call(record, "task.list", { projectId: project.id, archiveScope: "active", taskIds: [alternateTask.id] })).items.length, 0);
  assert.equal(gitExit(repository, ["show-ref", "--verify", "--quiet", "refs/heads/feature/cleanup-14"]), 0);
  assert.equal(gitExit(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${alternateBranch}`]), 0);
  evidence.checks.alternateBranchCleanupPreservesBothRefs = true;
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  subscription?.close();
  if (app) await app.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  const passed = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0;
  evidence.status = passed ? "PASS_LOCAL_WITH_SKIPS" : "FAIL";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await rm(temporary, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}

function cleanupRequest(task) {
  return {
    operationId: randomUUID(),
    taskId: task.id,
    expectedManagedWorktreeOperationId: task.worktree_cleanup?.managed_worktree_operation_id ?? task.worktree_provisioning?.operation_id ?? task.__proof,
    expectedWorktreeGeneration: task.worktree_generation,
    cleanupMode: "safe",
    acknowledgedContentBlockers: [],
  };
}

async function taskById(record, projectId, taskId) {
  const task = (await call(record, "task.list", { projectId, archiveScope: "active", taskIds: [taskId] })).items[0];
  assert(task, `Task ${taskId} is missing`);
  if (!task.__proof) {
    const preview = await call(record, "task.inspectWorktreeCleanup", { taskId });
    task.__proof = preview.managed_worktree_operation_id;
  }
  return task;
}

function git(cwd, args, extraEnv = {}) {
  return execFileSync(realGit, ["-c", `core.hooksPath=${emptyHooks}`, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C", ...extraEnv },
  });
}

function gitExit(cwd, args) {
  try { git(cwd, args); return 0; } catch (error) { return error?.status ?? 1; }
}

async function installGitProxy() {
  const proxy = path.join(proxyDirectory, "git");
  await writeFile(proxy, `#!/bin/sh
export GIT_TRACE2_EVENT=${JSON.stringify(traceFile)}
previous=
is_remove=0
force=0
destination=
for argument in "$@"; do
  if [ "$previous" = worktree ] && [ "$argument" = remove ]; then is_remove=1; fi
  if [ "$argument" = --force ]; then force=1; fi
  previous=$argument
  destination=$argument
done
if [ -f ${JSON.stringify(injectDirtyOnRemoveMarker)} ] && [ "$is_remove" = 1 ] && [ "$force" = 0 ]; then
  printf 'late writer\n' > "$destination/late-untracked.txt"
  rm -f ${JSON.stringify(injectDirtyOnRemoveMarker)}
fi
exec ${JSON.stringify(realGit)} "$@"
`);
  await chmod(proxy, 0o755);
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error(`${name} was not found on PATH`);
}

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: { ...process.env, PATH: `${proxyDirectory}${path.delimiter}${process.env.PATH ?? ""}`, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory },
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

async function subscribe(record, projectId) {
  const socket = new WebSocket(record.controlUrl);
  const id = randomUUID();
  const events = [];
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("subscribe timed out")), 8_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.token, method: "control.subscribe", params: { topics: ["task"], projectIds: [projectId] } })));
    socket.on("message", (raw) => {
      const value = JSON.parse(String(raw));
      if (value.id === id) { clearTimeout(timeout); value.ok ? resolve() : reject(new Error(value.error?.message)); }
      else if (value.event === "projection.invalidated") events.push(value.payload);
    });
    socket.once("error", reject);
  });
  return {
    close: () => socket.close(),
    take: () => events.splice(0),
    async next(predicate = () => true) {
      return waitFor(() => {
        const index = events.findIndex(predicate);
        return index >= 0 ? events.splice(index, 1)[0] : undefined;
      }, 8_000, "scoped invalidation");
    },
  };
}

async function launchDesktop() {
  const launched = await electron.launch({
    args: [path.join(root, "clients/desktop")],
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_FILE: runtimeFile, TERMLOOP_DESKTOP_USER_DATA_DIR: electronUserDataDirectory, TERMLOOP_DESKTOP_DIAGNOSTICS: "1" },
  });
  const page = await launched.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  return { app: launched };
}

async function diagnostics(page) {
  return page.evaluate(() => ({
    full: window.termloopDiagnostics?.projectionRefreshCount() ?? -1,
    patch: window.termloopDiagnostics?.taskPatchCount() ?? -1,
    rows: window.termloopDiagnostics?.taskRowRenderCount() ?? -1,
  }));
}

async function traceStartCount() {
  const text = await readFile(traceFile, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).reduce((count, line) => {
    try { return count + (JSON.parse(line).event === "start" ? 1 : 0); } catch { return count; }
  }, 0);
}

async function waitForTraceQuiet(duration) {
  let previous = await traceStartCount();
  let quietSince = Date.now();
  while (Date.now() - quietSince < duration) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await traceStartCount();
    if (current !== previous) { previous = current; quietSince = Date.now(); }
  }
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

async function selectProject(page, projectId) {
  const trigger = page.getByRole("button", { name: "Current Project" });
  if (await trigger.getAttribute("data-selected-project-id") === projectId) return;
  await trigger.click();
  await page.locator(`[data-project-option-id="${projectId}"]`).click();
}

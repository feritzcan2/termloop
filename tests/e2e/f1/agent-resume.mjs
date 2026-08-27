import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { _electron as electron } from "playwright";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f1-agent-resume-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const inactiveClaudeDirectory = path.join(projectDirectory, "inactive-claude");
const inactiveCodexDirectory = path.join(projectDirectory, "inactive-codex");
const fastExitAgentDirectory = path.join(projectDirectory, "fast-exit-agent");
const relocationSourceDirectory = path.join(projectDirectory, "relocation-source");
const taskWorktreeDirectory = path.join(temporary, "task-worktree");
const testHomeDirectory = path.join(temporary, "home");
const binDirectory = path.join(testHomeDirectory, ".local", "bin");
const tracePath = path.join(temporary, "provider-modes.txt");
const layoutPath = path.join(temporary, "layout.v1.json");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const resumeLogPath = path.join(runtimeDirectory, "agent-resume-cycles.jsonl");
const cargoTargetDirectory = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
const serverBinary = path.join(cargoTargetDirectory, "debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const requireGhostty = process.env.TERMLOOP_E2E_REQUIRE_GHOSTTY === "1";
const evidencePath = path.join(
  root,
  `artifacts/evidence/f1/${requireGhostty ? "ghostty-agent-resume" : "agent-resume"}.local.json`,
);
const wsModule = createRequire(import.meta.url).resolve("ws");
await Promise.all([
  runtimeDirectory,
  stateDirectory,
  projectDirectory,
  inactiveClaudeDirectory,
  inactiveCodexDirectory,
  fastExitAgentDirectory,
  relocationSourceDirectory,
  binDirectory,
  path.dirname(evidencePath),
].map((directory) => mkdir(directory, { recursive: true })));
await installFakeProviders();
git(["init", "--initial-branch=main", projectDirectory]);
git(["-C", projectDirectory, "config", "user.name", "TermLoop Fixture"]);
git(["-C", projectDirectory, "config", "user.email", "fixture@termloop.invalid"]);
git(["-C", projectDirectory, "commit", "--allow-empty", "-m", "fixture"]);

const evidence = {
  schema: requireGhostty ? "f1-ghostty-agent-resume-v1" : "f1-agent-resume-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  providerEvidence: {
    deterministicAdapters: "PASS",
    realClaude: "YELLOW — not exercised by this deterministic command",
    realCodex: "YELLOW — not exercised by this deterministic command",
  },
  checks: {},
  failures: [],
};

async function launchTaskAgent(record, params) {
  const preview = await controlCall(record, "task.previewAgent", params);
  return controlCall(record, "task.launchAgent", {
    taskId: params.taskId,
    agentId: params.agentId,
    launchTicket: preview.launch_ticket,
  });
}

async function launchProjectAgent(record, params) {
  const preview = await controlCall(record, "session.previewAgent", params);
  return controlCall(record, "session.launchAgent", {
    projectId: params.projectId,
    cwd: params.cwd,
    agentId: params.agentId,
    launchTicket: preview.launch_ticket,
  });
}

async function resumeAgent(record, sessionId) {
  const preview = await controlCall(record, "session.previewResumeAgent", { sessionId });
  return controlCall(record, "session.resumeAgent", {
    sessionId,
    launchTicket: preview.launch_ticket,
  });
}

let server;
let app;
try {
  let record;
  [server, record] = await startServer();
  const project = await controlCall(record, "project.create", { name: "Resume", folderPath: projectDirectory });
  const task = await controlCall(record, "task.create", { projectId: project.id, title: "Resume presence", brief: null, worktreeIntent: "none" });
  const provisioned = await controlCall(record, "task.provisionWorktree", {
    operationId: crypto.randomUUID(),
    taskId: task.id,
    repositoryPath: projectDirectory,
    destinationPath: taskWorktreeDirectory,
    branchName: "feature/resume-presence",
    branchMode: "create",
    baseRef: "refs/heads/main",
  });
  const taskWorktreePath = provisioned.task.worktree.path;
  const claude = await launchTaskAgent(record, {
    taskId: task.id,
    agentId: "claude",
    model: "fable",
    permission: "bypassPermissions",
    reasoning: "high",
  });
  const codex = await launchProjectAgent(record, {
    projectId: project.id,
    cwd: projectDirectory,
    agentId: "codex",
    model: "gpt-5.6-sol",
    permission: "bypassPermissions",
    reasoning: "xhigh",
  });
  const terminal = await controlCall(record, "session.launchTerminal", { projectId: project.id, cwd: projectDirectory });
  const privateState = await waitForPrivateReferences(2);
  const publicFresh = await controlCall(record, "session.list");
  const privateIds = privateState.sessions.filter((session) => session.resume_ref).map((session) => session.resume_ref.nativeSessionId);
  const privateClaude = privateState.sessions.find((session) => session.id === claude.id);
  const privateCodex = privateState.sessions.find((session) => session.id === codex.id);
  evidence.checks.launchSelectionPersistsPrivately = privateClaude?.launch_selection?.model === "fable"
    && privateClaude.launch_selection.permission === "bypassPermissions"
    && privateClaude.launch_selection.reasoning === "high"
    && privateCodex?.launch_selection?.model === "gpt-5.6-sol"
    && privateCodex.launch_selection.permission === "bypassPermissions"
    && privateCodex.launch_selection.reasoning === "xhigh";
  evidence.checks.privateReferencesEstablished = privateIds.length === 2;
  evidence.checks.publicProjectionRedactsReferences = privateIds.every((id) => !JSON.stringify(publicFresh).includes(id))
    && publicFresh.filter((session) => session.kind === "Agent").every((session) => session.process.args.length === 0);

  const providerRecords = await readdir(path.join(runtimeDirectory, "managed-processes", "provider"));
  const ptyRecords = await readdir(path.join(runtimeDirectory, "managed-processes", "pty"));
  evidence.checks.processRolesCannotOverwrite = providerRecords.includes(`${codex.id}.process`)
    && ptyRecords.includes(`${codex.id}.process`)
    && ptyRecords.length === 3;

  const inactiveClaude = await launchProjectAgent(record, {
    projectId: project.id,
    cwd: inactiveClaudeDirectory,
    agentId: "claude",
  });
  const inactiveCodex = await launchProjectAgent(record, {
    projectId: project.id,
    cwd: inactiveCodexDirectory,
    agentId: "codex",
  });
  const fastExitAgent = await launchProjectAgent(record, {
    projectId: project.id,
    cwd: fastExitAgentDirectory,
    agentId: "claude",
  });
  await waitUntil(async () => {
    const statuses = await controlCall(record, "agent.statusList");
    return statuses.some((status) =>
      status.sessionId === fastExitAgent.id && status.status === "working",
    ) ? true : undefined;
  }, 8_000, "fast-exit Claude prompt activity was not observed");
  const freshLaunchCountBeforeRestart = (await readFile(tracePath, "utf8"))
    .split("\n")
    .filter((line) => line.endsWith("-fresh")).length;

  app = await launchDesktop();
  let page = await app.firstWindow();
  await waitForDesktopConnection(page, "desktop did not connect");
  // This unpackaged test desktop is client-only. Simulate the one packaged
  // desktop that owns its bundled daemon; client-only and remote desktops are
  // verified separately to never send this automatic lifecycle command.
  const firstClientLaunchWave = await controlCall(record, "session.restartAgentsForClientLaunch", {
    clientLaunchId: crypto.randomUUID(),
  });
  assert.equal(firstClientLaunchWave.alreadyAccepted, false);
  assert.equal(firstClientLaunchWave.candidateCount, 3);
  if (requireGhostty) {
    assert.equal(
      await page.evaluate(() => window.termloop.terminalRendererKind()),
      "ghostty",
      "production desktop did not select the native Ghostty renderer",
    );
    evidence.checks.nativeGhosttyRendererSelected = true;
  }
  const afterFirstClientLaunch = await waitUntil(async () => {
    const sessions = await controlCall(record, "session.list");
    const currentClaude = sessions.find((session) => session.id === claude.id);
    const currentCodex = sessions.find((session) => session.id === codex.id);
    return currentClaude?.lifecycle_state === "running"
      && currentCodex?.lifecycle_state === "running"
      && currentClaude.runtime_epoch !== claude.runtime_epoch
      && currentCodex.runtime_epoch !== codex.runtime_epoch
      ? sessions
      : undefined;
  }, 12_000, "first Electron launch did not restart live agents");
  const interruptedCodex = await waitUntil(async () => {
    const statuses = await controlCall(record, "agent.statusList");
    return statuses.find((status) =>
      status.sessionId === codex.id
      && status.status === "interrupted"
      && status.source === "process"
    );
  }, 8_000, "working Codex did not remain interrupted after client-launch restart");
  evidence.checks.clientRestartWorkingCodexInterrupted = Boolean(interruptedCodex);
  await assertVisibleStartupOutput(page, claude.id, "TERMLOOP_CLAUDE_RESUME_SCREEN");
  await assertVisibleStartupOutput(page, codex.id, "TERMLOOP_CODEX_RESUME_SCREEN");
  evidence.checks.electronReceivesInitialTuiOutput = true;
  const firstRestartTrace = await readFile(tracePath, "utf8");
  evidence.checks.electronRestartReappliesBypassPermission =
    firstRestartTrace.includes("claude-resume-bypass")
    && firstRestartTrace.includes("codex-resume-bypass");
  const resumeLog = await readFile(resumeLogPath, "utf8");
  evidence.checks.restoreCyclesAreLoggedWithoutProviderReferences =
    [claude.id, codex.id].every((sessionId) => resumeLog.includes(sessionId))
    && ["request", "planned", "preparationStarted", "readinessObserved", "stabilityConfirmed", "committed"]
      .every((phase) => resumeLog.includes(`\"phase\":\"${phase}\"`))
    && privateIds.every((nativeId) => !resumeLog.includes(nativeId));
  const sessionsAfterClientLaunch = await controlCall(record, "session.list");
  evidence.checks.liveAgentsWithoutConversationActivityArePreserved =
    [inactiveClaude, inactiveCodex].every((inactiveAgent) => {
      const current = sessionsAfterClientLaunch.find((session) => session.id === inactiveAgent.id);
      return current?.lifecycle_state === "running"
        && current.runtime_epoch === inactiveAgent.runtime_epoch;
    });
  if (requireGhostty) {
    const responsiveProjects = await controlCall(record, "project.list");
    evidence.checks.controlPlaneResponsiveAfterNativeResume = responsiveProjects.some(
      (candidate) => candidate.id === project.id,
    );
  } else {
  const fastExitFailure = await waitUntil(async () => {
    const sessions = await controlCall(record, "session.list");
    const current = sessions.find((session) => session.id === fastExitAgent.id);
    return current?.lifecycle_state === "resumeFailed" ? current : undefined;
  }, 8_000, "readiness followed by fast exit did not become resumeFailed");
  evidence.checks.fastExitRemainsRetryableWithoutEpochCommit =
    fastExitFailure.resume_failure_reason === "resumeRejected"
    && fastExitFailure.retryable === true
    && fastExitFailure.runtime_epoch === fastExitAgent.runtime_epoch;
  const freshLaunchCountAfterFailure = (await readFile(tracePath, "utf8"))
    .split("\n")
    .filter((line) => line.endsWith("-fresh")).length;
  evidence.checks.failedResumeNeverFallsBackToFreshConversation =
    freshLaunchCountAfterFailure === freshLaunchCountBeforeRestart;

  const relocatingCodex = await launchProjectAgent(record, {
    projectId: project.id,
    cwd: relocationSourceDirectory,
    agentId: "codex",
    model: "gpt-5.6-sol",
    permission: "acceptEdits",
    reasoning: "high",
  });
  await waitUntil(async () => {
    const statuses = await controlCall(record, "agent.statusList");
    return statuses.some((status) => status.sessionId === relocatingCodex.id && status.status === "working")
      ? true
      : undefined;
  }, 8_000, "relocation source did not become active");
  const relocationPreview = await controlCall(record, "session.previewRelocateAgentToTask", {
    sessionId: relocatingCodex.id,
    taskId: task.id,
    mode: "resume",
  });
  evidence.checks.relocationPreviewIsInvocationOwned = relocationPreview.can_relocate === true
    && relocationPreview.manifest?.target?.cwd === taskWorktreePath
    && relocationPreview.manifest?.target?.conversation === "resume"
    && relocationPreview.manifest?.provenance?.template_ref === "builtin.agent.worktree-relocation"
    && relocationPreview.model === "gpt-5.6-sol"
    && relocationPreview.permission === "acceptEdits"
    && relocationPreview.reasoning === "high"
    && relocationPreview.warnings.includes("taskLifecycleApplies")
    && relocationPreview.warnings.includes("crossCwdPathsMayBeStale")
    && relocationPreview.warnings.includes("sourceTurnWillBeInterrupted")
    && relocationPreview.warnings.includes("targetHasActiveSessions");
  await selectWorkspaceView(page, "All active agents view");
  const relocatingRow = page.locator(`.active-agent-rail ${sessionSelector(relocatingCodex.id)}`);
  await relocatingRow.waitFor();
  await relocatingRow.click({ button: "right" });
  await page.getByRole("menuitem").filter({ hasText: "Continue in Task worktree" }).click();
  const relocationDialog = await waitForRelocationDialog(app);
  await relocationDialog.locator("#relocation-task").selectOption({ label: task.title });
  await waitUntil(async () => await relocationDialog
    .getByRole("heading")
    .filter({ hasText: `to “${task.title}”` })
    .count() === 1
    && await relocationDialog.getByRole("button", { name: "Yes" }).isEnabled()
    ? true
    : undefined, 8_000, "Task relocation did not open its ready preview");
  evidence.checks.rowMenuOpensRelocationPreview = await relocationDialog
    .getByText("continue in the Task worktree", { exact: false })
    .count() === 1;
  await relocationDialog.getByRole("button", { name: "Yes" }).click();
  const relocatedCodex = await waitUntil(async () => {
    const sessions = await controlCall(record, "session.list");
    const current = sessions.find((session) => session.id === relocatingCodex.id);
    return current?.lifecycle_state === "running"
      && current.process.cwd === taskWorktreePath
      && current.runtime_epoch !== relocatingCodex.runtime_epoch
      ? current
      : undefined;
  }, 12_000, "Task relocation did not commit the replacement Agent");
  evidence.checks.crossCwdResumeCommitsOnlyTargetProjection = relocatedCodex.lifecycle_state === "running"
    && relocatedCodex.process.cwd === taskWorktreePath
    && relocatedCodex.runtime_epoch !== relocatingCodex.runtime_epoch;
  await selectWorkspaceView(page, "Tasks and Sessions view");
  await waitUntil(async () => {
    const taskGroup = page.locator(`[data-task-id$="${task.id}"]`).locator("xpath=../..");
    return await taskGroup.locator(sessionSelector(relocatingCodex.id)).count() === 1
      ? true
      : undefined;
  }, 8_000, "relocated Session was not projected under its Task");
  evidence.checks.rendererRegroupsOnlyFromCwdPresence = true;
  const projectRelocationPreview = await controlCall(record, "session.previewRelocateAgentToProject", {
    sessionId: relocatingCodex.id,
    projectId: project.id,
  });
  evidence.checks.projectRelocationPreviewIsInvocationOwned = projectRelocationPreview.can_relocate === true
    && projectRelocationPreview.target_cwd === project.folder_path
    && projectRelocationPreview.manifest?.target?.cwd === project.folder_path
    && projectRelocationPreview.manifest?.target?.conversation === "resume"
    && projectRelocationPreview.manifest?.provenance?.template_ref === "builtin.agent.project-relocation"
    && projectRelocationPreview.warnings.includes("taskLifecycleNoLongerApplies")
    && projectRelocationPreview.warnings.includes("crossCwdPathsMayBeStale");
  await pointerDragTaskSessionToProject(page, relocatingCodex.id);
  const projectRelocationDialog = await waitForRelocationDialog(app);
  await waitUntil(async () => await projectRelocationDialog
    .getByRole("button", { name: "Yes" }).isEnabled()
    ? true
    : undefined, 8_000, "Project checkout drop did not open its ready relocation preview");
  evidence.checks.sidebarDragBackOpensProjectRelocationPreview = await projectRelocationDialog
    .getByText("continue in the Project checkout", { exact: false })
    .count() === 1;
  // dnd-kit suppresses click-through briefly after pointer drag end. A real
  // user cannot traverse from the sidebar drop to this button in that window.
  await page.waitForTimeout(60);
  await projectRelocationDialog.getByRole("button", { name: "Yes" }).click();
  const relocatedBackToProject = await waitUntil(async () => {
    const relocationError = await projectRelocationDialog.locator(".form-error[role=alert]").textContent().catch(() => undefined);
    if (relocationError) throw new Error(`Project checkout relocation failed: ${relocationError}`);
    const sessions = await controlCall(record, "session.list");
    const current = sessions.find((session) => session.id === relocatingCodex.id);
    return current?.lifecycle_state === "running"
      && current.process.cwd === project.folder_path
      && current.runtime_epoch !== relocatedCodex.runtime_epoch
      ? current
      : undefined;
  }, 12_000, "Project checkout drop did not commit the Project replacement Agent");
  evidence.checks.projectRelocationKeepsLogicalSession = relocatedBackToProject.id === relocatingCodex.id;
  await waitUntil(async () => {
    const taskGroup = page.locator(`[data-task-id$="${task.id}"]`).locator("xpath=../..");
    return await taskGroup.locator(sessionSelector(relocatingCodex.id)).count() === 0
      ? true
      : undefined;
  }, 8_000, "Project-relocated Session stayed under its Task");
  await selectWorkspaceView(page, "All active agents view");
  await waitUntil(async () => await page
    .locator(`.active-agent-rail ${sessionSelector(relocatingCodex.id)}`)
    .count() === 1
    /// The terminal rail shares this view but holds no Agent row, so the Agent
    /// is listed exactly once here.
    && await page.locator('.session-navigation[aria-label="Live sessions"]')
      .locator(sessionSelector(relocatingCodex.id)).count() === 0
    ? true
    : undefined, 8_000, "Project-relocated Session was not projected under Active Agents");
  evidence.checks.projectRelocationRegroupsOnlyFromCwdPresence = true;
  await controlCall(record, "session.terminate", { sessionId: relocatingCodex.id });
  await controlCall(record, "session.close", { sessionId: relocatingCodex.id });

  await resumeAgent(record, fastExitAgent.id);
  const fastExitAfterRetry = await waitUntil(async () => {
    const sessions = await controlCall(record, "session.list");
    const current = sessions.find((session) => session.id === fastExitAgent.id);
    return current?.lifecycle_state === "running"
      && current.runtime_epoch !== fastExitAgent.runtime_epoch ? current : undefined;
  }, 8_000, "fast-exit agent Retry did not resume the same Session");
  const manuallyRefreshedFastExit = await controlCall(record, "session.restartAgent", {
    sessionId: fastExitAgent.id,
  });
  assert.equal(manuallyRefreshedFastExit.id, fastExitAgent.id);
  await waitUntil(async () => {
    const sessions = await controlCall(record, "session.list");
    const current = sessions.find((session) => session.id === fastExitAgent.id);
    return current?.lifecycle_state === "running"
      && current.runtime_epoch !== fastExitAfterRetry.runtime_epoch ? current : undefined;
  }, 12_000, "transient resume failure revoked client-launch conversation activity");
  evidence.checks.transientFailureRetainsConversationActivity = true;
  await controlCall(record, "session.terminate", { sessionId: inactiveCodex.id });
  const explicitlyStoppedCodex = (await controlCall(record, "session.list"))
    .find((session) => session.id === inactiveCodex.id);
  assert.equal(explicitlyStoppedCodex?.lifecycle_state, "exited");
  evidence.checks.explicitlyStoppedAgentAdvertisesResume = explicitlyStoppedCodex.retryable === true;
  const explicitlyResumedCodex = await resumeAgent(record, inactiveCodex.id);
  evidence.checks.explicitTicketedResumeKeepsLogicalId = explicitlyResumedCodex.id === inactiveCodex.id;
  evidence.checks.explicitTicketedResumeReachesRunning = explicitlyResumedCodex.lifecycle_state === "running";
  evidence.checks.explicitTicketedResumeUsesFreshEpoch = explicitlyResumedCodex.runtime_epoch !== inactiveCodex.runtime_epoch;
  evidence.checks.explicitTicketedResumeReopensStoppedAgent =
    evidence.checks.explicitTicketedResumeKeepsLogicalId
    && evidence.checks.explicitTicketedResumeReachesRunning
    && evidence.checks.explicitTicketedResumeUsesFreshEpoch;
  evidence.explicitResumeDiagnostic = {
    resultLifecycleState: explicitlyResumedCodex.lifecycle_state,
    freshEpoch: explicitlyResumedCodex.runtime_epoch !== inactiveCodex.runtime_epoch,
    phases: (await readFile(resumeLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.sessionId === inactiveCodex.id && entry.trigger === "manualRetry")
      .map((entry) => ({ phase: entry.phase, detail: entry.detail })),
  };
  for (const session of [inactiveClaude, inactiveCodex, fastExitAgent]) {
    await controlCall(record, "session.terminate", { sessionId: session.id });
    await controlCall(record, "session.close", { sessionId: session.id });
  }

  const waveIds = [claude.id, codex.id];
  const beforeWave = await controlCall(record, "session.list");
  const beforeWaveEpochs = new Map(
    beforeWave.filter((session) => waveIds.includes(session.id)).map((session) => [session.id, session.runtime_epoch]),
  );
  const waveResult = await controlCall(record, "session.restartAgentsForClientLaunch", {
    clientLaunchId: crypto.randomUUID(),
  });
  assert.equal(waveResult.alreadyAccepted, true);
  assert.equal(waveResult.candidateCount, firstClientLaunchWave.candidateCount);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterWave = await controlCall(record, "session.list");
  evidence.checks.secondClientLaunchCannotRestartAgentsInOneEpoch = waveIds.every((sessionId) => {
    const session = afterWave.find((candidate) => candidate.id === sessionId);
    return session?.runtime_epoch === beforeWaveEpochs.get(sessionId);
  });

  const traceBeforeRendererReconnect = await readFile(tracePath, "utf8");
  await page.reload();
  await waitForDesktopConnection(page, "renderer reload did not reconnect");
  await page.evaluate(() => window.termloopDiagnostics?.reconnectTerminalAttachments());
  await new Promise((resolve) => setTimeout(resolve, 500));
  evidence.checks.rendererReloadAndAttachmentReconnectDoNotResume = await readFile(tracePath, "utf8") === traceBeforeRendererReconnect;
  const terminalAfterFirstLaunch = afterFirstClientLaunch.find((session) => session.id === terminal.id);
  const traceBeforeClientRestart = await readFile(tracePath, "utf8");
  await app.close(); app = undefined;
  const delayedDiscovery = await readFile(runtimeFile, "utf8");
  await rm(runtimeFile, { force: true });
  app = await launchDesktop(); page = await app.firstWindow();
  await new Promise((resolve) => setTimeout(resolve, 10_500));
  await writeFile(runtimeFile, delayedDiscovery);
  await waitForDesktopConnection(page, "desktop did not reconnect");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterClientRestart = await controlCall(record, "session.list");
  evidence.checks.clientOnlyElectronLaunchDoesNotRestartAgents = [claude.id, codex.id].every((sessionId) => {
    const before = afterWave.find((session) => session.id === sessionId);
    const after = afterClientRestart.find((session) => session.id === sessionId);
    return after?.lifecycle_state === "running" && after.runtime_epoch === before?.runtime_epoch;
  }) && (await readFile(tracePath, "utf8")) === traceBeforeClientRestart;
  evidence.checks.delayedDaemonDiscoveryDoesNotGrantLifecycleOwnership = true;
  const terminalAfterSecondLaunch = afterClientRestart.find((session) => session.id === terminal.id);
  evidence.checks.electronLaunchLeavesGenericTerminal = terminalAfterFirstLaunch?.lifecycle_state === "running"
    && terminalAfterSecondLaunch?.runtime_epoch === terminalAfterFirstLaunch.runtime_epoch;
  await app.close(); app = undefined;

  await waitUntil(async () => {
    const statuses = await controlCall(record, "agent.statusList");
    return [claude.id, codex.id].every((sessionId) =>
      statuses.some((status) => status.sessionId === sessionId && status.status === "working"),
    ) ? true : undefined;
  }, 8_000, "fake providers were not working before graceful whole-app shutdown");
  await Promise.all([
    writeFile(path.join(taskWorktreeDirectory, ".termloop-test-bootstrap-only"), ""),
    writeFile(path.join(projectDirectory, ".termloop-test-bootstrap-only"), ""),
  ]);
  server.kill("SIGINT");
  await new Promise((resolve) => server.once("exit", resolve));
  [server, record] = await startServer();
  await waitUntil(async () => {
    const sessions = await controlCall(record, "session.list");
    return [claude.id, codex.id].every((sessionId) =>
      sessions.some((session) => session.id === sessionId && session.lifecycle_state === "running"),
    ) ? true : undefined;
  }, 12_000, "agents did not resume after graceful coupled desktop/daemon restart");
  const gracefulRestartStatuses = await waitUntil(async () => {
    const statuses = await controlCall(record, "agent.statusList");
    const restoredClaude = statuses.find((status) => status.sessionId === claude.id);
    const restoredCodex = statuses.find((status) => status.sessionId === codex.id);
    return restoredClaude?.status === "interrupted"
      && restoredClaude.source === "process"
      && restoredCodex?.status === "interrupted"
      && restoredCodex.source === "process"
      ? statuses
      : undefined;
  }, 8_000, "graceful restart did not interrupt working Claude and Codex");
  evidence.checks.coupledLifecycleWorkingAgentsInterrupted = gracefulRestartStatuses.length > 0;
  evidence.checks.claudeResumeHookCredentialAccepted = !(await readFile(tracePath, "utf8"))
    .includes("claude-resume-hook-rejected");
  await Promise.all([
    rm(path.join(taskWorktreeDirectory, ".termloop-test-bootstrap-only"), { force: true }),
    rm(path.join(projectDirectory, ".termloop-test-bootstrap-only"), { force: true }),
  ]);

  const duplicate = spawnServer();
  const duplicateExit = await Promise.race([
    new Promise((resolve) => duplicate.once("exit", (code) => resolve(code))),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
  ]);
  if (duplicateExit === "timeout") duplicate.kill("SIGKILL");
  evidence.checks.secondLiveDaemonRefused = duplicateExit !== "timeout" && duplicateExit !== 0;

  server.kill("SIGKILL");
  await new Promise((resolve) => server.once("exit", resolve));
  [server, record] = await startServer();
  const restored = await waitUntil(async () => {
    const sessions = await controlCall(record, "session.list");
    const restoredClaude = sessions.find((session) => session.id === claude.id);
    const restoredCodex = sessions.find((session) => session.id === codex.id);
    const staleTerminal = sessions.find((session) => session.id === terminal.id);
    return restoredClaude?.lifecycle_state === "running"
      && restoredCodex?.lifecycle_state === "running"
      && restoredClaude.runtime_epoch !== claude.runtime_epoch
      && restoredCodex.runtime_epoch !== codex.runtime_epoch
      && staleTerminal?.lifecycle_state === "stale"
      ? sessions
      : undefined;
  }, 12_000, "Sessions did not converge after daemon restart");
  evidence.checks.sameLogicalIdsAndFreshEpoch = restored.some((session) => session.id === claude.id)
    && restored.some((session) => session.id === codex.id);
  await waitUntil(async () => {
    const tasks = await controlCall(record, "task.list", {
      projectId: project.id,
      archiveScope: "active",
    });
    const restoredTask = tasks.items.find((candidate) => candidate.id === task.id);
    return restoredTask?.worktree_presence?.attached_sessions
      ?.some((attached) => attached.session_id === claude.id) || undefined;
  }, 4_000, "resumed Task agent stayed absent until another launch refreshed presence");
  evidence.checks.taskPresenceRestoredWithoutNewLaunch = true;
  evidence.checks.genericTerminalStayedStale = restored.find((session) => session.id === terminal.id)?.lifecycle_state === "stale";
  await waitUntil(async () => {
    const trace = await readFile(tracePath, "utf8").catch(() => "");
    return trace.includes("claude-resume") && trace.includes("codex-resume") ? true : undefined;
  }, 4_000, "provider resume argv was not observed");
  evidence.checks.providerSpecificResumePaths = true;

  const traceBeforeRetry = await readFile(tracePath, "utf8");
  await Promise.all([
    resumeAgent(record, claude.id),
    resumeAgent(record, claude.id),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  evidence.checks.runningRetryIsIdempotent = await readFile(tracePath, "utf8") === traceBeforeRetry;
  const closed = await controlCall(record, "session.close", { sessionId: terminal.id });
  evidence.checks.staleCloseDeletesDescriptor = closed.closed === true
    && !(await controlCall(record, "session.list")).some((session) => session.id === terminal.id);
  }
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (app) await app.close().catch(() => undefined);
  if (server?.exitCode === null) {
    server.kill("SIGINT");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  evidence.status = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0 ? "PASS" : "FAIL";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (process.env.TERMLOOP_E2E_DIAGNOSTICS === "1") {
    process.stderr.write(`TermLoop E2E diagnostics retained at ${temporary}\n`);
  } else {
    await rm(temporary, { recursive: true, force: true });
  }
  if (evidence.status !== "PASS") process.exitCode = 1;
}

async function launchDesktop() {
  return electron.launch({
    args: [path.join(root, "clients", "desktop")],
    cwd: root,
    env: {
      ...process.env,
      TERMLOOP_RUNTIME_FILE: runtimeFile,
      TERMLOOP_LAYOUT_FILE: layoutPath,
      TERMLOOP_DESKTOP_USER_DATA_DIR: electronUserDataDirectory,
      TERMLOOP_DESKTOP_DIAGNOSTICS: "1",
      ...(requireGhostty ? { TERMLOOP_TERMINAL_RENDERER: "ghostty" } : {}),
    },
  });
}

async function waitForDesktopConnection(page, message) {
  try {
    await waitUntil(async () => {
      const projectTitle = await page.locator("#project-title").innerText().catch(() => "");
      const selectedProjectId = await page.locator("#project").getAttribute("data-selected-project-id").catch(() => "");
      return projectTitle === "Resume" && selectedProjectId ? true : undefined;
    }, 10_000, message);
  } catch {
    await page.getByRole("button", { name: /Errors/ }).click().catch(() => undefined);
    const errors = await page.locator(".error-log-panel li p").allInnerTexts().catch(() => []);
    const body = await page.locator("body").innerText().catch(() => "unavailable");
    throw new Error(`${message}: errors=${JSON.stringify(errors.slice(0, 12))}; ui=${body.slice(0, 400).replaceAll("\n", " | ")}`);
  }
}

/// The workspace views are exclusive: Tasks and their worktrees in one, every
/// Agent plus the Project's own terminals in the other. A gesture that needs
/// rows from both no longer exists, so each step states the view it acts in.
async function selectWorkspaceView(page, label) {
  const tab = page.locator(`button[aria-label="${label}"]`);
  await tab.click();
  await waitUntil(
    async () => await tab.getAttribute("aria-selected") === "true" ? true : undefined,
    4_000,
    `${label} did not become the selected workspace view`,
  );
}

async function waitForRelocationDialog(app) {
  return waitUntil(async () => {
    for (const candidate of app.windows()) {
      const dialog = candidate.getByRole("alertdialog");
      if (await dialog.isVisible().catch(() => false)) return dialog;
    }
    return undefined;
  }, 5_000, "Session relocation dialog did not open in any Electron window");
}

async function pointerDragTaskSessionToProject(page, sessionId) {
  const sourceRow = page.locator(`.task-group ${sessionSelector(sessionId)}`);
  const sourceContainer = sourceRow.locator("xpath=..");
  const source = await sourceContainer.locator(".session-drag-handle").boundingBox();
  const target = await page.locator('[data-session-drop-target="project-root"]').boundingBox();
  assert.ok(source && target);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 5, source.y + source.height / 2, { steps: 2 });
  await waitUntil(async () => await sourceContainer.evaluate(
    (element) => element.classList.contains("dragging"),
  ) ? true : undefined, 2_000, "Task Agent row did not activate its pointer drag");
  await page.mouse.move(target.x + target.width / 2, target.y + Math.min(target.height / 2, 38), { steps: 12 });
  await waitUntil(async () => await page
    .locator('[data-session-drop-target="project-root"]')
    .evaluate((element) => element.classList.contains("session-drop-target"))
    ? true
    : undefined, 2_000, "The Project checkout did not become the active Session drop target");
  await page.mouse.up();
}

function git(args) {
  return execFileSync("git", args, {
    cwd: temporary,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
    },
  });
}

async function installFakeProviders() {
  const claudePath = path.join(binDirectory, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") throw new Error("deterministic provider adapters are not yet implemented for Windows");
  await writeFile(claudePath, `#!/bin/sh
case "$1" in
  --help) printf '%s\\n' '  --session-id <uuid>' '  --resume <uuid>' '  --settings <file>'; exit 0 ;;
  --version) echo '2.1.fake'; exit 0 ;;
esac
settings=''
native_session_id=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--settings' ]; then settings="$argument"; fi
  if [ "$previous" = '--session-id' ] || [ "$previous" = '--resume' ]; then native_session_id="$argument"; fi
  previous="$argument"
done
run_hook() {
  event="$1"
  [ -n "$settings" ] || return
  hook_command=$(node -e "const value=JSON.parse(process.argv[1]); process.stdout.write(value.hooks[process.argv[2]][0].hooks[0].command)" "$settings" "$event")
  if [ -n "$native_session_id" ]; then
    printf '{"hook_event_name":"%s","session_id":"%s"}' "$event" "$native_session_id" | sh -c "$hook_command"
  else
    printf '{"hook_event_name":"%s"}' "$event" | sh -c "$hook_command"
  fi
}
case " $* " in
  *' --session-id '*)
    echo claude-fresh >> '${tracePath}'
    # Match a provider hook that arrives after the Session commit rather than
    # racing the daemon's fresh-launch apply step.
    sleep 0.1
    if [ "$(basename "$PWD")" != 'inactive-claude' ]; then run_hook UserPromptSubmit; fi
    ;;
  *' --resume '*)
    echo claude-resume >> '${tracePath}'
    case " $* " in
      *' --dangerously-skip-permissions '*) echo claude-resume-bypass >> '${tracePath}' ;;
    esac
    if ! run_hook SessionStart; then echo claude-resume-hook-rejected >> '${tracePath}'; fi
    if [ "$(basename "$PWD")" = 'task-worktree' ] && [ ! -e .termloop-test-bootstrap-only ]; then
      run_hook UserPromptSubmit
    fi
    if [ "$(basename "$PWD")" = 'fast-exit-agent' ] && [ ! -e .resume-rejected-once ]; then
      : > .resume-rejected-once
      exit 42
    fi
    printf '\\033[2J\\033[HTERMLOOP_CLAUDE_RESUME_SCREEN\\r\\n'
    ;;
esac
while :; do sleep 1; done
`);
  await chmod(claudePath, 0o755);
  const codexPath = path.join(binDirectory, "codex");
  await writeFile(codexPath, `#!/usr/bin/env node
const { WebSocket, WebSocketServer } = require(${JSON.stringify(wsModule)});
const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto"); const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("  --remote <ADDR>"); process.exit(0); }
if (args[0] === "--version") { console.log("codex-cli 0.fake"); process.exit(0); }
if (args[0] === "app-server" && args.includes("--help")) { console.log("  --listen <URL>"); process.exit(0); }
if (args[0] === "resume" && args.includes("--help")) { console.log("Usage: codex resume [OPTIONS] [SESSION_ID]"); console.log("  --remote <ADDR>"); process.exit(0); }
if (args[0] === "app-server") {
  const endpoint = new URL(args[args.indexOf("--listen") + 1]);
  const server = new WebSocketServer({ host: endpoint.hostname, port: Number(endpoint.port) });
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const initialize = JSON.parse(String(raw));
    socket.send(JSON.stringify({ method: "thread/started", params: { thread: { id: initialize.resumeId || crypto.randomUUID() } } }));
    if (path.basename(process.cwd()) !== "inactive-codex" || initialize.resumeId) {
      if (initialize.resumeId) {
        socket.send(JSON.stringify({ method: "thread/status/changed", params: { status: { type: "idle" } } }));
        if (initialize.resumeId && !fs.existsSync(path.join(process.cwd(), ".termloop-test-bootstrap-only"))) {
          setTimeout(() => socket.send(JSON.stringify({ method: "turn/started", params: {} })), 1_500);
        }
      } else {
        socket.send(JSON.stringify({ method: "turn/started", params: {} }));
      }
    }
  }));
  return;
}
fs.appendFileSync(${JSON.stringify(tracePath)}, (args[0] === "resume" ? "codex-resume" : "codex-fresh") + "\\n");
if (args[0] === "resume" && args.includes("--dangerously-bypass-approvals-and-sandbox")) {
  fs.appendFileSync(${JSON.stringify(tracePath)}, "codex-resume-bypass\\n");
}
if (args[0] === "resume") process.stdout.write("\\u001b[2J\\u001b[HTERMLOOP_CODEX_RESUME_SCREEN\\r\\n");
const endpoint = args[args.indexOf("--remote") + 1];
const socket = new WebSocket(endpoint);
socket.on("open", () => socket.send(JSON.stringify({ resumeId: args[0] === "resume" ? args[1] : null })));
setInterval(() => {}, 1000);
`);
  await chmod(codexPath, 0o755);
}

function spawnServer() {
  return spawn(serverBinary, [], {
    cwd: root,
    env: {
      ...process.env,
      HOME: testHomeDirectory,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      TERMLOOP_RUNTIME_DIR: runtimeDirectory,
      TERMLOOP_STATE_DIR: stateDirectory,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function startServer() {
  const child = spawnServer();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (process.env.TERMLOOP_E2E_DIAGNOSTICS === "1") process.stderr.write(chunk);
  });
  const record = await waitUntil(async () => {
    try {
      const value = JSON.parse(await readFile(runtimeFile, "utf8"));
      return value.pid === child.pid ? value : undefined;
    } catch {
      return undefined;
    }
  }, 10_000, () => `runtime discovery did not appear: ${stderr}`);
  return [child, record];
}

async function controlCall(record, method, params = {}) {
  const socket = new WebSocket(record.controlUrl);
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 12_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.token, method, params })));
    socket.on("message", (raw) => {
      const response = JSON.parse(String(raw));
      if (response.id !== id) return;
      clearTimeout(timeout); socket.close();
      if (response.ok) resolve(response.result);
      else reject(new Error(`${method}: ${response.error?.message ?? "failed"}`));
    });
    socket.once("error", reject);
  });
}

async function waitForPrivateReferences(count) {
  return waitUntil(async () => {
    try {
      const state = JSON.parse(await readFile(path.join(stateDirectory, "state.v1.json"), "utf8"));
      return state.sessions.filter((session) => session.resume_ref).length === count ? state : undefined;
    } catch {
      return undefined;
    }
  }, 8_000, "private ResumeRefs were not established");
}

async function assertVisibleStartupOutput(page, sessionId, marker) {
  await page.locator(sessionSelector(sessionId)).click();
  let diagnostics = {};
  await waitUntil(
    async () => {
      const observation = await page.evaluate(async (expected) => {
        const text = await window.termloopDiagnostics?.selectedTerminalText();
        const probe = window.termloopDiagnostics?.selectedTerminalProbe();
        return {
          matched: text?.includes(expected) === true,
          textLength: text?.length ?? 0,
          probeTextLength: probe?.text.length ?? 0,
          selectedRow: document.querySelector("[data-session-id].selected")?.dataset?.sessionId,
          paneSession: document.querySelector("[data-pane-session-id]")?.dataset?.paneSessionId,
          hasClaudeMarker: text?.includes("TERMLOOP_CLAUDE_RESUME_SCREEN") === true,
          hasCodexMarker: text?.includes("TERMLOOP_CODEX_RESUME_SCREEN") === true,
          connectionFailed: text?.includes("[terminal connection failed:") === true,
          connectionLost: text?.includes("[terminal connection lost") === true,
        };
      }, marker);
      diagnostics = observation;
      return observation.matched || undefined;
    },
    15_000,
    () => `selected terminal renderer did not render ${marker}; diagnostics=${JSON.stringify(diagnostics)}`,
  );
}

function sessionSelector(rawSessionId) {
  // Renderer ids are connection-scoped (`tlc:...<raw id>`); the daemon-facing
  // fixture intentionally retains the raw UUID so it can assert one durable
  // logical Session across process generations.
  return `[data-session-id$="${rawSessionId}"]`;
}

async function waitUntil(probe, timeoutMs, failure) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(typeof failure === "function" ? failure() : failure);
}

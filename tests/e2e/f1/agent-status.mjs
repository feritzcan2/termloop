import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f1-agent-status-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const layoutFile = path.join(temporary, "layout.v1.json");
const stateFile = path.join(stateDirectory, "state.v1.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f1/agent-status.local.json");
const reportPath = path.join(root, "artifacts/evidence/f1/AGENT-STATUS.md");
const codexStatusPromptPath = path.join(root, "resources/prompts/development/f1-codex-status-acceptance.md");
await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(projectDirectory, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
]);

const evidence = {
  schema: "f1-agent-status-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  agents: { claudeA: null, claudeB: null, codex: null },
  measurements: { controlLatencyDuringCodexPreparationMs: null },
  checks: {
    sameCwdAgentsAttributedBySession: false,
    structuredHookStatusRendered: false,
    observationIsRuntimeOnly: false,
    processExitOverridesObservation: false,
    unobservableStatesRemainDocumented: false,
    attentionFocusCreatesNoPaneOrSession: false,
    staleAttentionDoesNotMutateLayout: false,
    codexLaunchUsesNoTrustBypass: false,
    codexAppServerLifecycleRendered: false,
    codexPreparationKeepsControlResponsive: false,
    orphanProviderReapedOnDaemonRestart: false,
  },
  failures: [],
};

let server;
let app;

async function launchProjectAgent(record, params) {
  const preview = await controlCall(record, "session.previewAgent", params);
  return controlCall(record, "session.launchAgent", {
    projectId: params.projectId,
    cwd: params.cwd,
    agentId: params.agentId,
    launchTicket: preview.launch_ticket,
  });
}

try {
  server = await startServer();
  const record = await readRecord(server.pid);
  // These real interactive CLIs receive no prompt or input. A previously
  // trusted cwd avoids an agent-owned trust dialog masking SessionStart hooks.
  const trustedAgentCwd = root;
  const project = await controlCall(record, "project.create", { name: "Agent Status", folderPath: trustedAgentCwd });
  const otherProject = await controlCall(record, "project.create", { name: "Other Project", folderPath: projectDirectory });
  const otherTerminal = await controlCall(record, "session.launchTerminal", { projectId: otherProject.id, cwd: projectDirectory });
  const claudeA = await launchProjectAgent(record, { projectId: project.id, cwd: trustedAgentCwd, agentId: "claude" });
  const claudeB = await launchProjectAgent(record, { projectId: project.id, cwd: trustedAgentCwd, agentId: "claude" });
  app = await electron.launch({
    args: [path.join(root, "clients/desktop")],
    cwd: root,
    env: {
      ...process.env,
      TERMLOOP_RUNTIME_FILE: runtimeFile,
      TERMLOOP_LAYOUT_FILE: layoutFile,
      TERMLOOP_DESKTOP_DIAGNOSTICS: "1",
      TERMLOOP_DESKTOP_USER_DATA_DIR: electronUserDataDirectory,
    },
  });
  const page = await app.firstWindow();
  const codexLaunch = launchProjectAgent(record, { projectId: project.id, cwd: trustedAgentCwd, agentId: "codex" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const controlProbeStartedAt = performance.now();
  await controlCall(record, "session.list");
  evidence.measurements.controlLatencyDuringCodexPreparationMs = Number((performance.now() - controlProbeStartedAt).toFixed(2));
  assert.ok(evidence.measurements.controlLatencyDuringCodexPreparationMs < 500);
  evidence.checks.codexPreparationKeepsControlResponsive = true;
  const codex = await codexLaunch;
  await page.locator(`[data-session-id="${codex.id}"]`).waitFor();
  const statuses = await waitForStatuses(record, [claudeA.id, claudeB.id]);
  evidence.agents.claudeA = statuses.find((value) => value.sessionId === claudeA.id);
  evidence.agents.claudeB = statuses.find((value) => value.sessionId === claudeB.id);
  evidence.agents.codex = statuses.find((value) => value.sessionId === codex.id);
  assert.equal(claudeA.process.cwd, claudeB.process.cwd);
  assert.equal(evidence.agents.claudeA.source, "hook");
  assert.equal(evidence.agents.claudeB.source, "hook");
  assert.ok(!codex.process.args.includes("--dangerously-bypass-hook-trust"));
  assert.deepEqual(codex.process.args, []);
  evidence.checks.codexLaunchUsesNoTrustBypass = true;
  evidence.checks.sameCwdAgentsAttributedBySession = true;

  for (const session of [claudeA, claudeB]) {
    await page.locator(`[data-session-id="${session.id}"]`).waitFor();
    await waitUntil(async () => /hook/.test(await page.locator(`[data-session-id="${session.id}"] .live-dot`).getAttribute("title") ?? ""), 5_000, "structured status did not render");
  }
  evidence.checks.structuredHookStatusRendered = true;

  await page.locator(`[data-session-id="${codex.id}"]`).click();
  await waitUntil(async () => {
    const probe = await page.evaluate(() => window.termloopDiagnostics?.selectedTerminalProbe());
    return /OpenAI Codex|directory:|model:/i.test(probe?.text ?? "");
  }, 20_000, "Codex TUI did not become ready");
  const codexCycle = captureCodexCycle(record, codex.id);
  await page.locator(".layout-pane.active .xterm-helper-textarea").focus();
  await page.keyboard.type(await deliveredPrompt(codexStatusPromptPath));
  await page.keyboard.press("Enter");
  const codexStatuses = await codexCycle;
  evidence.agents.codex = codexStatuses.at(-1);
  assert.ok(codexStatuses.some((value) => value.status === "working" && value.source === "appServer"));
  assert.equal(evidence.agents.codex.status, "idle");
  assert.equal(evidence.agents.codex.source, "appServer");
  await waitUntil(async () => /(?:Idle|Ready for review) · appServer/.test(await page.locator(`[data-session-id="${codex.id}"] .live-dot`).getAttribute("title") ?? ""), 5_000, "Codex App Server status did not render");
  evidence.checks.codexAppServerLifecycleRendered = true;

  await selectProject(page, otherProject.id);
  const paneCountBeforeAttention = await page.locator(".layout-pane").count();
  const sessionCountBeforeAttention = (await controlCall(record, "session.list")).filter((value) => value.lifecycle_state === "running").length;
  assert.equal(await page.evaluate((sessionId) => window.termloopDiagnostics?.activateAgentAttention(sessionId), claudeB.id), true);
  await waitUntil(async () => await page.getByRole("button", { name: "Current Project" }).getAttribute("data-selected-project-id") === project.id, 2_000, "attention did not switch Project");
  assert.equal(await page.locator(`[data-session-id="${claudeB.id}"]`).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".layout-pane").count(), paneCountBeforeAttention);
  assert.equal((await controlCall(record, "session.list")).filter((value) => value.lifecycle_state === "running").length, sessionCountBeforeAttention);
  evidence.checks.attentionFocusCreatesNoPaneOrSession = true;

  const durable = await readFile(stateFile, "utf8");
  assert.ok(!durable.includes("TERMLOOP_HOOK_TOKEN"));
  assert.ok(!durable.includes("observationSequence"));
  assert.ok(!durable.includes("observedAtEpochMs"));
  assert.ok(!durable.includes("dangerously-bypass-hook-trust"));
  evidence.checks.observationIsRuntimeOnly = true;

  await controlCall(record, "session.terminate", { sessionId: claudeA.id });
  await waitUntil(async () => {
    const current = await controlCall(record, "agent.statusList");
    const status = current.find((value) => value.sessionId === claudeA.id);
    return status?.status === "exited" && status?.source === "process";
  }, 5_000, "process exit did not override hook status");
  evidence.checks.processExitOverridesObservation = true;
  await waitUntil(async () => await page.locator(`[data-session-id="${claudeA.id}"]`).count() === 1, 5_000, "exited agent descriptor disappeared from the rail");
  await controlCall(record, "session.close", { sessionId: claudeA.id });
  await waitUntil(async () => await page.locator(`[data-session-id="${claudeA.id}"]`).count() === 0, 5_000, "closed agent descriptor remained in the rail");
  const layoutBeforeStaleAttention = await page.evaluate(() => JSON.stringify(window.termloopDiagnostics?.layoutDocument()));
  assert.equal(await page.evaluate((sessionId) => window.termloopDiagnostics?.activateAgentAttention(sessionId), claudeA.id), false);
  assert.equal(await page.evaluate(() => JSON.stringify(window.termloopDiagnostics?.layoutDocument())), layoutBeforeStaleAttention);
  evidence.checks.staleAttentionDoesNotMutateLayout = true;

  const spike = JSON.parse(await readFile(path.join(root, "spikes/f1-agent-signals/evidence.json"), "utf8"));
  evidence.checks.unobservableStatesRemainDocumented = spike.status === "MIXED" && spike.claude.awaitingInputObservable === false;
  await controlCall(record, "session.terminate", { sessionId: claudeB.id });
  await controlCall(record, "session.terminate", { sessionId: codex.id });
  await controlCall(record, "session.terminate", { sessionId: otherTerminal.id });

  const orphanCandidate = await launchProjectAgent(record, {
    projectId: project.id,
    cwd: trustedAgentCwd,
    agentId: "codex",
  });
  const providerRecordPath = path.join(runtimeDirectory, "managed-processes", "provider", `${orphanCandidate.id}.process`);
  const providerProcessId = Number((await readFile(providerRecordPath, "utf8")).split("\n")[1]);
  assert.ok(processIsAlive(providerProcessId));
  await app.close();
  app = undefined;
  server.kill("SIGKILL");
  await new Promise((resolve) => server.once("exit", resolve));
  server = await startServer();
  await readRecord(server.pid);
  await waitUntil(async () => !processIsAlive(providerProcessId), 5_000, "orphaned App Server survived daemon-start reconciliation");
  await assert.rejects(readFile(providerRecordPath, "utf8"));
  evidence.checks.orphanProviderReapedOnDaemonRestart = true;
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (server?.capturedStderr) evidence.failures.push(server.capturedStderr());
} finally {
  if (app) await app.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  evidence.status = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0 ? "PASS" : "FAIL";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(reportPath, report(evidence));
  await rm(temporary, { recursive: true, force: true });
  if (evidence.status !== "PASS") process.exitCode = 1;
}

async function waitForStatuses(record, sessionIds) {
  const deadline = Date.now() + 15_000;
  let statuses = [];
  while (Date.now() < deadline) {
    statuses = await controlCall(record, "agent.statusList");
    if (sessionIds.every((id) => statuses.some((value) => value.sessionId === id && value.source === "hook"))) return statuses;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const sessions = await controlCall(record, "session.list");
  throw new Error(`real agents did not report correlated hook status: ${JSON.stringify({
    statuses,
    sessions: sessions
      .filter((value) => sessionIds.includes(value.id))
      .map((value) => ({ id: value.id, agentId: value.process.agent_id, lifecycleState: value.lifecycle_state })),
  })}`);
}

async function captureCodexCycle(record, sessionId) {
  const deadline = Date.now() + 45_000;
  const observed = [];
  let sawWorking = false;
  while (Date.now() < deadline) {
    const status = (await controlCall(record, "agent.statusList")).find((value) => value.sessionId === sessionId);
    if (status && !observed.some((value) => value.status === status.status && value.source === status.source)) {
      observed.push(status);
    }
    sawWorking ||= status?.status === "working" && status?.source === "appServer";
    if (sawWorking && status?.status === "idle" && status?.source === "appServer") return observed;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Codex App Server lifecycle was incomplete: ${JSON.stringify(observed)}`);
}

async function deliveredPrompt(filePath) {
  const source = await readFile(filePath, "utf8");
  const marker = "## Delivered prompt\n\n";
  const prompt = source.split(marker)[1]?.trim();
  assert.ok(prompt, `visible prompt has no delivered body: ${filePath}`);
  return prompt;
}

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.capturedStderr = () => stderr;
  child.once("exit", (code) => { if (code && !child.killed) evidence.failures.push(`server exited ${code}: ${stderr}`); });
  await readRecord(child.pid);
  return child;
}

async function selectProject(page, projectId) {
  await page.getByRole("button", { name: "Current Project" }).click();
  await page.locator(`[data-project-option-id="${projectId}"]`).click();
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
  const socket = new WebSocket(record.controlUrl);
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 8_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.token, method, params })));
    socket.on("message", (raw) => {
      const response = JSON.parse(String(raw));
      if (response.id !== id) return;
      clearTimeout(timeout);
      socket.close();
      if (response.ok) resolve(response.result);
      else reject(new Error(`${method}: ${response.error?.message ?? "failed"}`));
    });
    socket.once("error", reject);
  });
}

async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(message);
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function report(value) {
  const rows = Object.entries(value.checks).map(([name, result]) => `| ${name} | ${result ? "PASS" : "FAIL"} |`).join("\n");
  return `# F1-03B Agent status acceptance\n\n- Status: **${value.status}**\n- Captured: ${value.capturedAt}\n- Host: ${value.host.platform}/${value.host.arch} ${value.host.release}\n- Scope: two real Claude Sessions plus one real Codex TUI connected through a Session-scoped App Server bridge, shown Electron status UI, durable-state inspection\n\n| Check | Result |\n|---|---|\n${rows}\n\n## Measurements\n\n- Control response while Codex runtime preparation was active: ${value.measurements.controlLatencyDuringCodexPreparationMs ?? "not measured"} ms (budget < 500 ms).\n\n## Observed real-agent status\n\n- Claude A: ${value.agents.claudeA ? `${value.agents.claudeA.status} / ${value.agents.claudeA.source}` : "not observed"}\n- Claude B: ${value.agents.claudeB ? `${value.agents.claudeB.status} / ${value.agents.claudeB.source}` : "not observed"}\n- Codex TUI: ${value.agents.codex ? `${value.agents.codex.status} / ${value.agents.codex.source}` : "not observed"}\n- Codex lifecycle is derived from typed App Server status messages; its normal terminal UI remains the interaction surface.\n- Codex launches with no hook-trust bypass. Claude awaiting-input remains explicitly unobserved and degrades honestly.\n${value.failures.length ? `\n## Failures\n\n\`\`\`text\n${value.failures.join("\n\n")}\n\`\`\`\n` : ""}`;
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f1-session-navigation-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f1/session-navigation.local.json");
const reportPath = path.join(root, "artifacts/evidence/f1/SESSION-NAVIGATION.md");
await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(projectDirectory, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
]);

const evidence = {
  schema: "f1-session-navigation-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    fiftySessionsRendered: false,
    mouseSelectionKeepsManualOrder: false,
    keyboardNavigation: false,
    renameThroughDesktop: false,
    detachKeepsProcessRunning: false,
    renameSurvivesClientRestart: false,
    renameSurvivesDaemonRestart: false,
  },
  failures: [],
};

let server;
let app;
try {
  server = await startServer();
  const record = await readRecord(server.pid);
  const project = await controlCall(record, "project.create", { name: "Fifty Sessions", folderPath: projectDirectory });
  const sessions = [];
  for (let index = 0; index < 25; index += 1) {
    sessions.push(await controlCall(record, "session.launchTerminal", { projectId: project.id, cwd: projectDirectory }));
  }
  const agentSession = await controlCall(record, "session.launchAgent", { projectId: project.id, cwd: projectDirectory, agentId: "codex" });
  sessions.push(agentSession);
  for (let index = 25; index < 49; index += 1) {
    sessions.push(await controlCall(record, "session.launchTerminal", { projectId: project.id, cwd: projectDirectory }));
  }

  ({ app } = await launchDesktop());
  let page = await app.firstWindow();
  /// The Agent rail and the Project's terminal rail share this one view, so all
  /// 50 Sessions render together. They stay separate lists: the Agent is in the
  /// rail above, the 49 terminals in the rail below it.
  await selectWorkspaceView(page, "All active agents view");
  await page.locator(`.active-agent-rail [data-session-id="${agentSession.id}"]`).waitFor();
  await waitForSessionCount(page, 50);
  assert.equal(await page.locator(".session-navigation .session-item").count(), 49);
  evidence.checks.fiftySessionsRendered = true;

  /// Selection is established by this fixture rather than inherited, so the
  /// navigation assertion does not depend on which Session the app happened to
  /// select at launch. Arrow keys move within the rail that owns the focused
  /// row, so the expected order is that rail's own order.
  await page.locator(`[data-session-id="${sessions[0].id}"]`).click();
  const initialSelectedId = await selectedSessionId(page);
  const initialDomOrder = await page.locator(".session-item.terminal").evaluateAll((items) => items.map((item) => item.getAttribute("data-session-id")));
  const initialIndex = initialDomOrder.indexOf(initialSelectedId);
  assert.notEqual(initialIndex, -1);
  await page.locator(`[data-session-id="${initialSelectedId}"]`).focus();
  await page.keyboard.press("ArrowUp");
  const expectedPreviousId = initialDomOrder[(initialIndex - 1 + initialDomOrder.length) % initialDomOrder.length];
  await waitUntil(async () => await selectedSessionId(page) === expectedPreviousId, 2_000, "ArrowUp did not follow the rendered terminal order");
  await page.keyboard.press("ArrowDown");
  await waitUntil(async () => await selectedSessionId(page) === initialSelectedId, 2_000, "ArrowDown did not follow the rendered terminal order");
  evidence.checks.keyboardNavigation = true;

  const renamedId = sessions[10].id;
  const renamedItem = page.locator(`[data-session-id="${renamedId}"]`);
  const terminalOrderBeforeSelection = await page.locator(".session-item.terminal").evaluateAll((items) => items.map((item) => item.getAttribute("data-session-id")));
  await renamedItem.click();
  assert.equal(await renamedItem.getAttribute("aria-pressed"), "true");
  assert.deepEqual(await page.locator(".session-item.terminal").evaluateAll((items) => items.map((item) => item.getAttribute("data-session-id"))), terminalOrderBeforeSelection);
  evidence.checks.mouseSelectionKeepsManualOrder = true;

  await renamedItem.click({ button: "right" });
  await page.getByRole("menu", { name: /actions$/ }).getByRole("menuitem", { name: "Rename…" }).click();
  const renameInput = page.getByRole("textbox", { name: "Session name" });
  await renameInput.fill("  Build API  ");
  await page.getByRole("button", { name: "Save" }).click();
  await waitUntil(async () => (await renamedItem.locator("strong").innerText()) === "Build API", 5_000, "renamed Session label did not render");
  evidence.checks.renameThroughDesktop = true;

  await renamedItem.click();
  assert.equal(await renamedItem.getAttribute("aria-pressed"), "true");
  await renamedItem.click({ button: "right" });
  await page.getByRole("menu", { name: "Build API actions" }).getByRole("menuitem", { name: "Close pane Session keeps running" }).click();
  await waitUntil(async () => !(await renamedItem.getAttribute("class"))?.includes("visible"), 5_000, "detached Session stayed marked visible");
  const afterDetach = await controlCall(record, "session.list");
  assert.equal(afterDetach.find((session) => session.id === renamedId).lifecycle_state, "running");
  assert.equal(await page.locator(".session-item").count(), 50);
  evidence.checks.detachKeepsProcessRunning = true;

  await app.close();
  app = undefined;

  ({ app } = await launchDesktop());
  page = await app.firstWindow();
  await selectWorkspaceView(page, "All active agents view");
  await waitForSessionCount(page, 50);
  await page.locator(`[data-session-id="${renamedId}"] strong`).getByText("Build API", { exact: true }).waitFor();
  evidence.checks.renameSurvivesClientRestart = true;
  await app.close();
  app = undefined;

  await stopServer(server);
  server = await startServer();
  const restartedRecord = await readRecord(server.pid);
  const restartedSessions = await controlCall(restartedRecord, "session.list");
  const restartedRenamed = restartedSessions.find((session) => session.id === renamedId);
  assert.equal(restartedRenamed.name, "Build API");
  assert.equal(restartedRenamed.lifecycle_state, "stale");
  evidence.checks.renameSurvivesDaemonRestart = true;
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (app) await app.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  evidence.status = Object.values(evidence.checks).every((value) => value === true) && evidence.failures.length === 0 ? "PASS" : "FAIL";
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
    },
  });
  const page = await launched.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  await waitUntil(async () => /50 live/.test(await page.locator(".connection-status").innerText().catch(() => "")), 10_000, "desktop did not load 50 live Sessions");
  return { app: launched, page };
}

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("exit", (code) => {
    if (code && !child.killed) evidence.failures.push(`server exited ${code}: ${stderr}`);
  });
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
  const socket = new WebSocket(record.controlUrl);
  const id = crypto.randomUUID();
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 8_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.token, method, params })));
    socket.once("message", (raw) => {
      clearTimeout(timeout);
      socket.close();
      const response = JSON.parse(String(raw));
      if (response.ok) resolve(response.result);
      else reject(new Error(`${method}: ${response.error?.message ?? "failed"}`));
    });
    socket.once("error", reject);
  });
}

/// The sidebar's workspace views are exclusive: Tasks in one, and every Agent
/// plus the Project's own terminals in the other. A fixture that reads either
/// list states which view it is acting in.
async function selectWorkspaceView(page, label) {
  const tab = page.locator(`button[aria-label="${label}"]`);
  await tab.click();
  await waitUntil(
    async () => await tab.getAttribute("aria-selected") === "true",
    4_000,
    `${label} did not become the selected workspace view`,
  );
}

async function waitForSessionCount(page, count) {
  await waitUntil(async () => await page.locator(".session-item").count() === count, 10_000, `expected ${count} Session items`);
}

async function selectedSessionId(page) {
  return await page.locator('.session-item[aria-pressed="true"]').getAttribute("data-session-id");
}

async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(message);
}

function report(value) {
  const rows = Object.entries(value.checks).map(([name, result]) => `| ${name} | ${result ? "PASS" : "FAIL"} |`).join("\n");
  return `# F1-01 Session navigation acceptance\n\n- Status: **${value.status}**\n- Captured: ${value.capturedAt}\n- Host: ${value.host.platform}/${value.host.arch} ${value.host.release}\n- Scope: real daemon, 49 real PTYs + 1 real Codex agent, shown Electron window, mixed-group mouse/keyboard navigation, stable manual order, sidebar context-menu rename/detach, client/daemon restart\n\n| Check | Result |\n|---|---|\n${rows}\n${value.failures.length ? `\n## Failures\n\n\`\`\`text\n${value.failures.join("\n\n")}\n\`\`\`\n` : ""}`;
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f1-pane-layout-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const layoutFile = path.join(temporary, "desktop", "layout.v1.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f1/pane-layout.local.json");
const reportPath = path.join(root, "artifacts/evidence/f1/PANE-LAYOUT.md");
await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(projectDirectory, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
]);

const evidence = {
  schema: "f1-pane-layout-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    sidebarContextMenuTargetsInvisibleSession: false,
    horizontalAndVerticalSplit: false,
    focusMovement: false,
    keyboardResize: false,
    visiblePaneWebglBound: false,
    layoutRestoresKnownSessions: false,
    visibleSessionMenuClosesPane: false,
    sidebarContextMenuTerminatesTargetSession: false,
    paneCloseKeepsProcessRunning: false,
    missingReferencePlaceholder: false,
    missingReferenceNoImplicitLaunch: false,
    removedReferenceStaysRemoved: false,
  },
  measurements: { liveWebglContexts: null, rootRatioBefore: null, rootRatioAfter: null },
  failures: [],
};

let server;
let app;
try {
  server = await startServer();
  const record = await readRecord(server.pid);
  const project = await controlCall(record, "project.create", { name: "Pane Layout", folderPath: projectDirectory });
  const sessions = [];
  for (let index = 0; index < 3; index += 1) {
    sessions.push(await controlCall(record, "session.launchTerminal", { projectId: project.id, cwd: projectDirectory }));
    await controlCall(record, "session.rename", { sessionId: sessions[index].id, name: `Pane ${index + 1}` });
  }

  ({ app } = await launchDesktop(3));
  let page = await app.firstWindow();
  await waitForPaneCount(page, 1);

  assert.equal(await page.getByRole("button", { name: "Split pane right" }).count(), 0);
  await sidebarSession(page, sessions[1].id).click({ button: "right" });
  const hiddenSessionMenu = page.getByRole("menu", { name: "Pane 2 actions" });
  await hiddenSessionMenu.getByRole("menuitem", { name: "Open in split right" }).click();
  await waitForPaneCount(page, 2);
  await page.locator(`[data-pane-session-id="${sessions[1].id}"]`).waitFor();
  evidence.checks.sidebarContextMenuTargetsInvisibleSession = true;
  await sidebarSession(page, sessions[2].id).click({ button: "right" });
  await page.getByRole("menu", { name: "Pane 3 actions" }).getByRole("menuitem", { name: "Open in split down" }).click();
  await waitForPaneCount(page, 3);
  await page.locator(`[data-pane-session-id="${sessions[2].id}"]`).waitFor();
  assert.deepEqual(await paneSessionIds(page), sessions.map((session) => session.id));
  evidence.checks.horizontalAndVerticalSplit = true;

  await page.getByRole("button", { name: "Focus previous pane" }).click();
  await waitUntil(async () => await activePaneSessionId(page) === sessions[1].id, 2_000, "previous-pane focus did not follow tree order");
  await page.getByRole("button", { name: "Focus next pane" }).click();
  await waitUntil(async () => await activePaneSessionId(page) === sessions[2].id, 2_000, "next-pane focus did not follow tree order");
  evidence.checks.focusMovement = true;

  const rootDivider = page.locator(".split-divider").first();
  const rootSplit = rootDivider.locator("..");
  evidence.measurements.rootRatioBefore = Number(await rootSplit.getAttribute("data-ratio"));
  await page.waitForTimeout(100);
  await rootDivider.focus();
  assert.equal(await rootDivider.evaluate((element) => document.activeElement === element), true);
  await rootDivider.dispatchEvent("keydown", { key: "ArrowRight", code: "ArrowRight" });
  await waitUntil(async () => Number(await rootSplit.getAttribute("data-ratio")) > evidence.measurements.rootRatioBefore, 2_000, "keyboard resize did not change the split ratio");
  evidence.measurements.rootRatioAfter = Number(await rootSplit.getAttribute("data-ratio"));
  evidence.checks.keyboardResize = true;

  const metrics = await page.evaluate(() => globalThis.termloopDiagnostics?.rendererMetrics());
  evidence.measurements.liveWebglContexts = metrics?.liveWebglContexts ?? null;
  assert.ok(typeof evidence.measurements.liveWebglContexts === "number" && evidence.measurements.liveWebglContexts <= 3);
  evidence.checks.visiblePaneWebglBound = true;

  await waitForSavedPaneCount(project.id, 3);
  await app.close();
  app = undefined;

  ({ app } = await launchDesktop(3));
  page = await app.firstWindow();
  await waitForPaneCount(page, 3);
  assert.deepEqual(await paneSessionIds(page), sessions.map((session) => session.id));
  evidence.checks.layoutRestoresKnownSessions = true;

  await sidebarSession(page, sessions[2].id).click({ button: "right" });
  const visibleSessionMenu = page.getByRole("menu", { name: "Pane 3 actions" });
  await visibleSessionMenu.getByText("Visible in layout").waitFor();
  await visibleSessionMenu.getByRole("menuitem", { name: "Close pane Session keeps running" }).click();
  await waitForPaneCount(page, 2);
  const afterClose = await controlCall(record, "session.list");
  assert.equal(afterClose.find((session) => session.id === sessions[2].id).lifecycle_state, "running");
  evidence.checks.visibleSessionMenuClosesPane = true;
  evidence.checks.paneCloseKeepsProcessRunning = true;
  await waitForSavedPaneCount(project.id, 2);
  await app.close();
  app = undefined;

  await controlCall(record, "session.terminate", { sessionId: sessions[1].id });
  ({ app } = await launchDesktop(2));
  page = await app.firstWindow();
  await waitForPaneCount(page, 2);
  await page.locator(`[data-missing-session-id="${sessions[1].id}"]`).waitFor();
  await page.getByText("Nothing was restarted automatically.", { exact: false }).waitFor();
  evidence.checks.missingReferencePlaceholder = true;

  const afterMissingRestore = await controlCall(record, "session.list");
  const running = afterMissingRestore.filter((session) => session.lifecycle_state === "running");
  assert.deepEqual(new Set(running.map((session) => session.id)), new Set([sessions[0].id, sessions[2].id]));
  evidence.checks.missingReferenceNoImplicitLaunch = true;

  await page.locator(".pane-placeholder.missing").getByRole("button", { name: "Remove reference" }).click();
  await waitUntil(async () => await page.locator(".pane-placeholder.empty").count() === 1, 2_000, "missing reference was not cleared");
  await waitForSavedPaneSessionCount(project.id, 1);
  await app.close();
  app = undefined;

  ({ app } = await launchDesktop(2));
  page = await app.firstWindow();
  await waitForPaneCount(page, 2);
  assert.equal(await page.locator(".pane-placeholder.missing").count(), 0);
  assert.equal((await paneSessionIds(page)).filter(Boolean).length, 1);
  evidence.checks.removedReferenceStaysRemoved = true;

  await sidebarSession(page, sessions[2].id).click({ button: "right" });
  await page.getByRole("menu", { name: "Pane 3 actions" }).getByRole("menuitem", { name: "Close Session End its process and remove it" }).click();
  await waitUntil(async () => await sidebarSession(page, sessions[2].id).count() === 0, 5_000, "closed Session remained in the sidebar");
  const afterContextTerminate = await controlCall(record, "session.list");
  assert.equal(afterContextTerminate.some((session) => session.id === sessions[2].id), false);
  evidence.checks.sidebarContextMenuTerminatesTargetSession = true;
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

async function launchDesktop(liveSessions) {
  const launched = await electron.launch({
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
  const page = await launched.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  await waitUntil(async () => new RegExp(`${liveSessions} live`).test(await page.locator(".connection-status").innerText().catch(() => "")), 10_000, "desktop did not load the expected live Sessions");
  /// This fixture reads the Project's terminal rows, which sit under the Agent
  /// rail in the Agents view. Selecting it keeps the fixture independent of
  /// whichever view the app opens on.
  await selectWorkspaceView(page, "All active agents view");
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

function sidebarSession(page, sessionId) {
  return page.locator(`.sidebar [data-session-id="${sessionId}"]`);
}

async function paneSessionIds(page) {
  return await page.locator(".layout-pane").evaluateAll((items) => items.map((item) => item.getAttribute("data-pane-session-id")));
}

async function activePaneSessionId(page) {
  return await page.locator(".layout-pane.active").getAttribute("data-pane-session-id");
}

async function waitForPaneCount(page, count) {
  await waitUntil(async () => await page.locator(".layout-pane").count() === count, 8_000, `expected ${count} layout panes`);
}

async function waitForSavedPaneCount(projectId, count) {
  await waitUntil(async () => {
    try {
      const document = JSON.parse(await readFile(layoutFile, "utf8"));
      return countPanes(document.projects?.[projectId]?.root) === count;
    } catch {
      return false;
    }
  }, 5_000, `layout file did not persist ${count} panes`);
}

async function waitForSavedPaneSessionCount(projectId, count) {
  await waitUntil(async () => {
    try {
      const document = JSON.parse(await readFile(layoutFile, "utf8"));
      return paneSessionIdsFromNode(document.projects?.[projectId]?.root).filter(Boolean).length === count;
    } catch {
      return false;
    }
  }, 5_000, `layout file did not persist ${count} Session references`);
}

function countPanes(node) {
  if (!node) return 0;
  return node.type === "pane" ? 1 : countPanes(node.first) + countPanes(node.second);
}

function paneSessionIdsFromNode(node) {
  if (!node) return [];
  return node.type === "pane" ? [node.sessionId] : [...paneSessionIdsFromNode(node.first), ...paneSessionIdsFromNode(node.second)];
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
  return `# F1-02 Pane layout acceptance\n\n- Status: **${value.status}**\n- Captured: ${value.capturedAt}\n- Host: ${value.host.platform}/${value.host.arch} ${value.host.release}\n- Scope: real daemon, three real PTYs, shown Electron window, sidebar context-menu split/focus/resize/close/restore/missing-reference flows\n- Live WebGL contexts with three visible panes: ${value.measurements.liveWebglContexts ?? "unmeasured"}\n- Root ratio: ${value.measurements.rootRatioBefore ?? "?"} → ${value.measurements.rootRatioAfter ?? "?"}\n\n| Check | Result |\n|---|---|\n${rows}\n${value.failures.length ? `\n## Failures\n\n\`\`\`text\n${value.failures.join("\n\n")}\n\`\`\`\n` : ""}`;
}

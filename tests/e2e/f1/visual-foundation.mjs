import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f1-visual-foundation-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const layoutFile = path.join(temporary, "desktop", "layout.v1.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidenceDirectory = path.join(root, "artifacts/evidence/f1");
const evidencePath = path.join(evidenceDirectory, "visual-foundation.local.json");
const reportPath = path.join(evidenceDirectory, "VISUAL-FOUNDATION.md");
const screenshotPath = path.join(evidenceDirectory, "visual-foundation.png");
await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(projectDirectory, { recursive: true }),
  mkdir(evidenceDirectory, { recursive: true }),
]);

const evidence = {
  schema: "f1-visual-foundation-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    selectionKeepsManualOrder: false,
    pointerReorderPersists: false,
    keyboardReorderPersists: false,
    centerDropReservedForFutureAction: false,
    pointerDropOutsideIsNoop: false,
    keyboardContextMenuRestoresFocus: false,
    terminalViewportFitsPanes: false,
    threePaneReviewStateCaptured: false,
  },
  measurements: { paneFitGaps: [] },
  screenshot: path.relative(root, screenshotPath),
  failures: [],
};

let server;
let app;
try {
  server = await startServer();
  const record = await readRecord(server.pid);
  const project = await controlCall(record, "project.create", { name: "TermLoop Next", folderPath: projectDirectory });
  const sessions = [];
  for (const name of ["API server", "Web client", "Test runner", "Git status", "Release notes", "Scratch shell"]) {
    const session = await controlCall(record, "session.launchTerminal", { projectId: project.id, cwd: projectDirectory });
    await controlCall(record, "session.rename", { sessionId: session.id, name });
    sessions.push(session);
  }

  ({ app } = await launchDesktop(6));
  let page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForSessionCount(page, 6);

  const initialOrder = await sessionOrder(page);
  await sidebarSession(page, sessions[3].id).click();
  assert.deepEqual(await sessionOrder(page), initialOrder);
  evidence.checks.selectionKeepsManualOrder = true;

  await pointerDrag(page, sessions[5].id, sessions[1].id, "before");
  const pointerOrder = await sessionOrder(page);
  assert.deepEqual(pointerOrder, [sessions[0].id, sessions[5].id, sessions[1].id, sessions[2].id, sessions[3].id, sessions[4].id]);
  await waitForSavedOrder(project.id, pointerOrder);
  evidence.checks.pointerReorderPersists = true;

  const keyboardSource = sessionDragHandle(page, sessions[4].id);
  await keyboardSource.focus();
  await page.keyboard.press("Space");
  await page.locator(".session-drag-preview").waitFor();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(120);
  await page.keyboard.press("Space");
  await page.locator(".session-drag-preview").waitFor({ state: "hidden" });
  const keyboardOrder = await sessionOrder(page);
  const keyboardExpected = [...pointerOrder];
  const keyboardSourceIndex = keyboardExpected.indexOf(sessions[4].id);
  [keyboardExpected[keyboardSourceIndex - 1], keyboardExpected[keyboardSourceIndex]] = [keyboardExpected[keyboardSourceIndex], keyboardExpected[keyboardSourceIndex - 1]];
  assert.deepEqual(keyboardOrder, keyboardExpected);
  await waitForSavedOrder(project.id, keyboardOrder);
  evidence.checks.keyboardReorderPersists = true;

  const beforeCenterDrop = await sessionOrder(page);
  await pointerDrag(page, sessions[2].id, sessions[0].id, "on");
  assert.deepEqual(await sessionOrder(page), beforeCenterDrop);
  await page.getByText(/reserved for a future handoff action/).waitFor();
  evidence.checks.centerDropReservedForFutureAction = true;

  await pointerDragOutside(page, sessions[2].id);
  assert.deepEqual(await sessionOrder(page), beforeCenterDrop);
  evidence.checks.pointerDropOutsideIsNoop = true;

  const contextTarget = sidebarSession(page, sessions[1].id);
  await contextTarget.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Web client actions" });
  await menu.waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await waitUntil(
    async () => await contextTarget.evaluate((element) => document.activeElement === element),
    2_000,
    "Session menu did not restore focus to its invoker",
  );
  evidence.checks.keyboardContextMenuRestoresFocus = true;

  await contextTarget.click({ button: "right" });
  await page.getByRole("menu", { name: "Web client actions" }).getByRole("menuitem", { name: "Open in split right" }).click();
  await sidebarSession(page, sessions[0].id).click({ button: "right" });
  await page.getByRole("menu", { name: "API server actions" }).getByRole("menuitem", { name: "Open in split down" }).click();
  await waitUntil(async () => await page.locator(".layout-pane").count() === 3, 4_000, "three-pane review state did not render");
  await page.waitForTimeout(350);
  const paneFitGaps = await page.locator(".layout-pane").evaluateAll((panes) => panes.map((pane) => {
    const mount = pane.querySelector(".terminal-mount")?.getBoundingClientRect();
    const terminal = pane.querySelector(".terminal-surface")?.getBoundingClientRect();
    const viewport = pane.querySelector(".xterm")?.getBoundingClientRect();
    const screen = pane.querySelector(".xterm-screen")?.getBoundingClientRect();
    return mount && terminal && viewport && screen
      ? { hostGap: Math.abs(mount.height - terminal.height), gridGap: viewport.height - screen.height }
      : undefined;
  }));
  evidence.measurements.paneFitGaps = paneFitGaps;
  assert.equal(paneFitGaps.length, 3);
  assert.ok(paneFitGaps.every((measurement) => measurement && measurement.hostGap <= 1 && measurement.gridGap >= 0 && measurement.gridGap < 20));
  evidence.checks.terminalViewportFitsPanes = true;
  const terminalInputs = page.locator(".layout-pane .xterm-helper-textarea");
  for (let index = 0; index < await terminalInputs.count(); index += 1) {
    await terminalInputs.nth(index).focus();
    await page.keyboard.press("Control+L");
  }
  await page.waitForTimeout(250);
  await page.locator(".drop-notice").waitFor({ state: "hidden" });
  await page.screenshot({ path: screenshotPath });
  evidence.checks.threePaneReviewStateCaptured = true;

  await app.close();
  app = undefined;
  ({ app } = await launchDesktop(6));
  page = await app.firstWindow();
  await waitForSessionCount(page, 6);
  assert.deepEqual(await sessionOrder(page), keyboardOrder);
  evidence.checks.pointerReorderPersists = true;
  evidence.checks.keyboardReorderPersists = true;
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
  await waitUntil(async () => new RegExp(`${liveSessions} live`).test(await page.locator(".connection-status").innerText().catch(() => "")), 10_000, "desktop did not load live Sessions");
  /// This fixture reads the Project's terminal rows, which sit under the Agent
  /// rail in the Agents view. Selecting it keeps the fixture independent of
  /// whichever view the app opens on.
  await selectWorkspaceView(page, "All active agents view");
  return { app: launched, page };
}

async function pointerDrag(page, sourceId, targetId, placement) {
  const source = await sessionDragHandle(page, sourceId).boundingBox();
  const target = await sidebarSession(page, targetId).boundingBox();
  assert.ok(source && target);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 3 });
  const targetY = placement === "before" ? target.y + 3 : placement === "after" ? target.y + target.height - 3 : target.y + target.height / 2;
  await page.mouse.move(target.x + target.width / 2, targetY, { steps: 12 });
  await page.mouse.up();
}

async function pointerDragOutside(page, sourceId) {
  const source = await sessionDragHandle(page, sourceId).boundingBox();
  assert.ok(source);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 3 });
  await page.mouse.move(1_300, 40, { steps: 12 });
  await page.mouse.up();
}

async function sessionOrder(page) {
  return await page.locator(".session-item.terminal").evaluateAll((items) => items.map((item) => item.getAttribute("data-session-id")));
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

function sessionDragHandle(page, sessionId) {
  return sidebarSession(page, sessionId).locator("xpath=..").locator(".session-drag-handle");
}

async function waitForSessionCount(page, count) {
  await waitUntil(async () => await page.locator(".session-item").count() === count, 10_000, `expected ${count} Session items`);
}

async function waitForSavedOrder(projectId, expected) {
  await waitUntil(async () => {
    try {
      const document = JSON.parse(await readFile(layoutFile, "utf8"));
      return JSON.stringify(document.sessionOrderByProject?.[projectId]) === JSON.stringify(expected);
    } catch {
      return false;
    }
  }, 5_000, "manual Session order was not persisted");
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
  return `# F1-02.5 Visual foundation acceptance\n\n- Status: **${value.status}**\n- Captured: ${value.capturedAt}\n- Host: ${value.host.platform}/${value.host.arch} ${value.host.release}\n- Scope: real daemon, six real PTYs, shown Electron window at 1440×900, pointer/keyboard drag, context-menu keyboard flow, restart persistence, three-pane visual review state\n- Screenshot: \`${value.screenshot}\`\n\n| Check | Result |\n|---|---|\n${rows}\n${value.failures.length ? `\n## Failures\n\n\`\`\`text\n${value.failures.join("\n\n")}\n\`\`\`\n` : ""}`;
}

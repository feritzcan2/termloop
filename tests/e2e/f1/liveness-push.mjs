import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f1-liveness-push-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const layoutFile = path.join(temporary, "layout.v1.json");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f1/liveness-push.local.json");
const reportPath = path.join(root, "artifacts/evidence/f1/LIVENESS-PUSH.md");
await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(projectDirectory, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
]);

const evidence = {
  schema: "f1-liveness-push-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  measurements: {
    externalExitLatencyMs: [],
    externalExitP95Ms: null,
    idleObservationSeconds: 60,
    idleControlEventFrames: null,
    reconnectProjectionRefreshDelta: null,
  },
  checks: {
    externalExitUpdatesSidebar: false,
    externalExitP95Within1500Ms: false,
    sessionListIsPureDuringIdle: false,
    noIdleInvalidationLivelock: false,
    subscriptionReconnects: false,
    daemonRestartMakesGenericSessionsStale: false,
  },
  failures: [],
};

let server;
let app;
try {
  if (process.platform === "win32") throw new Error("external process kill fixture needs a Windows process-tree adapter");
  server = await startServer();
  let record = await readRecord(server.pid);
  const project = await controlCall(record, "project.create", { name: "Liveness", folderPath: projectDirectory });
  app = await launchDesktop();
  const page = await app.firstWindow();
  await waitUntil(async () => /1 project/.test(await page.locator(".connection-status").innerText().catch(() => "")), 10_000, "desktop did not connect");
  await new Promise((resolve) => setTimeout(resolve, 400));

  for (let index = 0; index < 10; index += 1) {
    const descendantsBefore = await descendantPids(server.pid);
    const session = await controlCall(record, "session.launchTerminal", { projectId: project.id, cwd: projectDirectory });
    await waitUntil(async () => await page.locator(`[data-session-id="${session.id}"]`).count() === 1, 4_000, "launched Session did not appear through push");
    const childPid = await waitForNewDescendant(server.pid, descendantsBefore);
    const startedAt = performance.now();
    process.kill(childPid, "SIGKILL");
    await waitUntil(async () => {
      const sessions = await controlCall(record, "session.list");
      return sessions.find((value) => value.id === session.id)?.lifecycle_state === "exited";
    }, 4_000, "exited Session did not become a stopped descriptor through push");
    evidence.measurements.externalExitLatencyMs.push(Number((performance.now() - startedAt).toFixed(2)));
    await controlCall(record, "session.close", { sessionId: session.id });
    await waitUntil(async () => await page.locator(`[data-session-id="${session.id}"]`).count() === 0, 4_000, "closed Session descriptor remained in the sidebar");
  }
  evidence.measurements.externalExitP95Ms = percentile(evidence.measurements.externalExitLatencyMs, 0.95);
  evidence.checks.externalExitUpdatesSidebar = evidence.measurements.externalExitLatencyMs.length === 10;
  evidence.checks.externalExitP95Within1500Ms = evidence.measurements.externalExitP95Ms <= 1_500;

  const idleSessions = [];
  for (let index = 0; index < 10; index += 1) {
    idleSessions.push(await controlCall(record, "session.launchTerminal", { projectId: project.id, cwd: projectDirectory }));
  }
  await waitUntil(async () => await page.locator(".session-item").count() === 10, 5_000, "idle Sessions did not appear");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const idle = await observeIdleSubscription(record, 60_000);
  evidence.measurements.idleControlEventFrames = idle.eventFrames;
  evidence.checks.noIdleInvalidationLivelock = idle.eventFrames === 0;
  evidence.checks.sessionListIsPureDuringIdle = idle.stateRevisionAfter === idle.stateRevisionBefore;

  for (const session of idleSessions) {
    await controlCall(record, "session.terminate", { sessionId: session.id });
    await controlCall(record, "session.close", { sessionId: session.id });
  }
  await waitUntil(async () => await page.locator(".session-item").count() === 0, 5_000, "terminated idle Sessions remained visible");
  const restartSessions = [];
  for (let index = 0; index < 3; index += 1) {
    restartSessions.push(await controlCall(record, "session.launchTerminal", { projectId: project.id, cwd: projectDirectory }));
  }
  await waitUntil(async () => await page.locator(".session-item").count() === 3, 5_000, "restart fixture Sessions did not appear");
  const refreshBefore = await page.evaluate(() => window.termloopDiagnostics?.projectionRefreshCount() ?? -1);
  await stopServer(server);
  server = await startServer();
  record = await readRecord(server.pid);
  await waitUntil(async () => await page.evaluate((baseline) => (window.termloopDiagnostics?.projectionRefreshCount() ?? -1) > baseline, refreshBefore), 10_000, "desktop did not refresh after daemon restart");
  await waitUntil(async () => await page.locator(".session-item").count() === 3, 10_000, "desktop did not preserve stale Session descriptors after daemon restart");
  const refreshAfter = await page.evaluate(() => window.termloopDiagnostics?.projectionRefreshCount() ?? -1);
  evidence.measurements.reconnectProjectionRefreshDelta = refreshAfter - refreshBefore;
  evidence.checks.subscriptionReconnects = evidence.measurements.reconnectProjectionRefreshDelta >= 1;
  const restarted = await controlCall(record, "session.list");
  evidence.checks.daemonRestartMakesGenericSessionsStale = restartSessions.every((session) => restarted.find((value) => value.id === session.id)?.lifecycle_state === "stale");
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
  return electron.launch({
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

async function observeIdleSubscription(record, durationMs) {
  const socket = new WebSocket(record.controlUrl);
  const id = crypto.randomUUID();
  let eventFrames = 0;
  let lastEventAt = Date.now();
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("control.subscribe timed out")), 8_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.readOnlyToken, method: "control.subscribe", params: { topics: ["session"] } })));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id === id) {
        clearTimeout(timeout);
        if (!message.ok) reject(new Error(message.error?.message ?? "subscribe failed"));
        else resolve(message.result);
      } else if (message.event === "projection.invalidated") {
        eventFrames += 1;
        lastEventAt = Date.now();
      }
    });
    socket.once("error", reject);
  });
  while (Date.now() - lastEventAt < 500) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  eventFrames = 0;
  const baseline = await controlCall(record, "control.subscribe", { topics: ["session"] });
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const after = await controlCall(record, "control.subscribe", { topics: ["session"] });
  socket.close();
  return { eventFrames, stateRevisionBefore: baseline.stateRevision, stateRevisionAfter: after.stateRevision };
}

async function descendantPids(rootPid) {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid="]);
  const children = new Map();
  for (const line of stdout.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    const values = children.get(ppid) ?? [];
    values.push(pid);
    children.set(ppid, values);
  }
  const result = new Set();
  const queue = [rootPid];
  while (queue.length) {
    for (const pid of children.get(queue.shift()) ?? []) {
      if (result.has(pid)) continue;
      result.add(pid);
      queue.push(pid);
    }
  }
  return result;
}

async function waitForNewDescendant(rootPid, before) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const current = await descendantPids(rootPid);
    const added = [...current].filter((pid) => !before.has(pid));
    if (added.length) return added[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("new PTY child process was not observed");
}

async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function report(value) {
  const rows = Object.entries(value.checks).map(([name, result]) => `| ${name} | ${result ? "PASS" : "FAIL"} |`).join("\n");
  const latencies = value.measurements.externalExitLatencyMs.join(", ");
  return `# F1-03A Liveness push acceptance\n\n- Status: **${value.status}**\n- Captured: ${value.capturedAt}\n- Host: ${value.host.platform}/${value.host.arch} ${value.host.release}\n- Scope: real daemon, shown Electron window, ten externally-killed PTY children, 60-second idle subscription, daemon reconnect\n\n| Check | Result |\n|---|---|\n${rows}\n\n## Measurements\n\n- External-exit latency samples (ms): ${latencies}\n- External-exit p95 (ms): ${value.measurements.externalExitP95Ms}\n- Idle observation: ${value.measurements.idleObservationSeconds}s\n- Idle unsolicited event frames: ${value.measurements.idleControlEventFrames}\n- Reconnect projection refresh delta: ${value.measurements.reconnectProjectionRefreshDelta}\n${value.failures.length ? `\n## Failures\n\n\`\`\`text\n${value.failures.join("\n\n")}\n\`\`\`\n` : ""}`;
}

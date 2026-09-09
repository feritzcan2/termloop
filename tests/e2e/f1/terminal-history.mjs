import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "termloop-terminal-history-")));
const runtimeFile = path.join(temporary, "runtime.json");
const projectDirectory = path.join(temporary, "project");
const changedDirectory = path.join(projectDirectory, "changed");
const renderer = process.env.TERMLOOP_TERMINAL_RENDERER ?? "xterm";
const evidenceDirectory = path.join(root, "artifacts/evidence/f1");
const serverPath = path.join(path.resolve(process.env.CARGO_TARGET_DIR ?? "target"), "debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
await mkdir(changedDirectory, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });
let server;
let app;
let record;
let passed = false;

async function until(probe, failure, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(failure);
}

async function startServer() {
  await rm(runtimeFile, { force: true });
  server = spawn(serverPath, [], { env: { ...process.env, TERMLOOP_RUNTIME_DIR: temporary, TERMLOOP_STATE_DIR: temporary }, stdio: ["ignore", "ignore", "pipe"] });
  // Keep bounded diagnostics without ever printing discovery credentials.
  let errors = "";
  server.stderr.on("data", (chunk) => { errors = (errors + chunk.toString()).slice(-32_768); });
  record = await until(async () => {
    try { return JSON.parse(await readFile(runtimeFile, "utf8")); } catch { return undefined; }
  }, "daemon discovery timed out", 60_000).catch((error) => { throw new Error(`${error.message}: ${errors}`); });
}

async function call(method, params = {}) {
  const socket = new WebSocket(record.controlUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 10_000);
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      socket.once("open", () => socket.send(JSON.stringify({ id: "history", protocolVersion: record.protocolVersion, token: record.token, method, params })));
      socket.once("message", (bytes) => {
        clearTimeout(timer);
        const response = JSON.parse(bytes.toString());
        if (response.ok) resolve(response.result);
        else reject(new Error(`${method}: ${response.error?.code}`));
      });
    });
  } finally { socket.close(); }
}

function frame(session, sequence, kind, payload = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(41 + payload.length);
  bytes.write("TL01");
  Buffer.from(session.id.replaceAll("-", ""), "hex").copy(bytes, 4);
  bytes.writeBigUInt64BE(BigInt(session.runtime_epoch), 20);
  bytes.writeBigUInt64BE(BigInt(sequence), 28);
  bytes[36] = kind;
  bytes.writeUInt32BE(payload.length, 37);
  payload.copy(bytes, 41);
  return bytes;
}

async function command(session, text, marker) {
  const socket = new WebSocket(record.terminalUrl);
  let sequence = 1;
  let output = "";
  const input = (text) => socket.send(frame(session, sequence++, 1, Buffer.from(text)));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("terminal handshake timed out")), 10_000);
      socket.once("error", reject);
      socket.once("open", () => socket.send(Buffer.from(`TL01${record.terminalToken}`)));
      socket.once("message", (bytes) => { clearTimeout(timer); assert.equal(bytes.toString(), "TLOK"); resolve(); });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`shell did not produce ${marker}`)), 20_000);
      socket.on("message", (bytes) => {
        if (bytes.length < 41) return;
        const kind = bytes[36];
        if (kind === 12) { clearTimeout(timer); reject(new Error("terminal frame was rejected")); return; }
        if (kind === 11) { input(`${text}\r`); return; }
        if (kind !== 2 && kind !== 6) return;
        const chunk = bytes.subarray(41).toString();
        const previousQueries = output.split("\x1b[6n").length;
        output += chunk;
        const queries = output.split("\x1b[6n").length;
        for (let index = previousQueries; index < queries; index++) input("\x1b[1;1R");
        const credit = Buffer.alloc(8); credit.writeBigUInt64BE(BigInt(bytes.length - 41));
        socket.send(frame(session, sequence++, 11, credit));
        if (output.includes(`\r\n${marker}\r\n`)) { clearTimeout(timer); resolve(); }
      });
      socket.send(frame(session, sequence++, 10));
    });
    return output;
  } finally { socket.close(); }
}

async function desktop() {
  app = await electron.launch({ args: [path.join(root, "clients/desktop")], cwd: root, env: {
    ...process.env, TERMLOOP_RUNTIME_FILE: runtimeFile,
    TERMLOOP_LAYOUT_FILE: path.join(temporary, "layout.v1.json"),
    TERMLOOP_DESKTOP_USER_DATA_DIR: path.join(temporary, "desktop"),
    TERMLOOP_DESKTOP_DIAGNOSTICS: "1", TERMLOOP_TERMINAL_RENDERER: renderer,
  } });
  const page = await app.firstWindow();
  await until(async () => (await page.locator("#project-title").innerText().catch(() => "")) === "Terminal history", "desktop did not connect");
  assert.equal(await page.evaluate(() => window.termloop.terminalRendererKind()), renderer);
  return page;
}

async function visible(page, session, marker) {
  await page.locator(`[data-session-id$="${session.id}"]`).click();
  return until(async () => {
    const text = await page.evaluate(() => window.termloopDiagnostics?.selectedTerminalText());
    return text?.includes(marker) ? text : undefined;
  }, `${renderer} did not render ${marker}`);
}

try {
  await startServer();
  const project = await call("project.create", { name: "Terminal history", folderPath: projectDirectory });
  const shell = await call("session.launchTerminal", { projectId: project.id, cwd: projectDirectory });
  const peer = await call("session.launchTerminal", { projectId: project.id, cwd: projectDirectory });
  await call("session.rename", { sessionId: shell.id, name: "Persistent shell" });
  await command(shell, `cd '${changedDirectory}'; echo TERMLOOP_SAVED_OUTPUT`, "TERMLOOP_SAVED_OUTPUT");
  await command(peer, "echo TERMLOOP_PEER_OUTPUT", "TERMLOOP_PEER_OUTPUT");
  let page = await desktop();
  await visible(page, shell, "TERMLOOP_SAVED_OUTPUT");
  await visible(page, peer, "TERMLOOP_PEER_OUTPUT");
  await visible(page, shell, "TERMLOOP_SAVED_OUTPUT");
  await app.close(); app = undefined;
  const exited = once(server, "exit");
  await call("system.shutdown");
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("graceful shutdown timed out")), 10_000))]);
  server = undefined;
  await startServer();
  const sessions = await call("session.list");
  const restored = sessions.find((session) => session.id === shell.id);
  assert.equal(restored?.name, "Persistent shell");
  assert.equal(restored.lifecycle_state, "running");
  assert.notEqual(restored.runtime_epoch, shell.runtime_epoch);
  assert.equal(restored.process.cwd, changedDirectory);
  page = await desktop();
  await visible(page, restored, "TERMLOOP_SAVED_OUTPUT");
  await visible(page, restored, "New shell after application restart");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 780));
  await command(restored, "echo TERMLOOP_NEW_INPUT", "TERMLOOP_NEW_INPUT");
  const text = await visible(page, restored, "TERMLOOP_NEW_INPUT");
  assert.ok(text.includes("TERMLOOP_SAVED_OUTPUT"));
  await page.screenshot({ path: path.join(evidenceDirectory, `terminal-history-${renderer}.png`) });
  await writeFile(path.join(evidenceDirectory, `terminal-history-${renderer}.json`), JSON.stringify({
    status: "PASS", renderer, checks: ["logical identity and name", "changed cwd", "inert history replay", "new input", "peer focus", "window resize", "desktop and daemon restart"],
    limitations: ["unpackaged Electron; packaged supervisor covered by its existing unit tests"],
  }, null, 2));
  console.log(`TERMINAL_HISTORY_${renderer.toUpperCase()}_PASS`);
  const inspectMs = Math.min(60_000, Math.max(0, Number(process.env.TERMLOOP_E2E_INSPECT_MS) || 0));
  if (inspectMs) await new Promise((resolve) => setTimeout(resolve, inspectMs));
  passed = true;
} finally {
  if (app) await app.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  }
  if (passed) await rm(temporary, { recursive: true, force: true });
  else console.error(`Terminal history fixture retained at ${temporary}`);
}

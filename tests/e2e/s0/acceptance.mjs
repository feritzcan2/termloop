import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";

const SERVER_DISCOVERY_ATTEMPTS = 600;
const SERVER_DISCOVERY_POLL_MS = 50;

const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "termloop-s0-"));
await mkdir("artifacts/evidence/s0", { recursive: true });
const cliBuild = spawnSync("pnpm", ["--filter", "@termloop/cli", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (cliBuild.status !== 0) process.exit(cliBuild.status ?? 1);
const build = spawnSync("cargo", ["build", "-p", "termloop-server"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const cargoTargetDirectory = path.resolve(process.env.CARGO_TARGET_DIR ?? "target");
const serverPath = path.join(cargoTargetDirectory, "debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const server = spawn(serverPath, [], {
  env: { ...process.env, TERMLOOP_RUNTIME_DIR: runtimeDir, TERMLOOP_STATE_DIR: runtimeDir, ANTHROPIC_API_KEY: "must-not-be-persisted" }, stdio: ["ignore", "pipe", "pipe"]
});
let serverError = ""; server.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

async function waitForRuntime() {
  const runtimePath = path.join(runtimeDir, "runtime.json");
  for (let attempt = 0; attempt < SERVER_DISCOVERY_ATTEMPTS; attempt++) {
    try { return { runtimePath, record: JSON.parse(await readFile(runtimePath, "utf8")) }; } catch { await new Promise((resolve) => setTimeout(resolve, SERVER_DISCOVERY_POLL_MS)); }
  }
  throw new Error(`server discovery timeout: ${serverError}`);
}

async function rawCall(record, overrides = {}) {
  const socket = new WebSocket(record.controlUrl);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("raw call timeout")), 5000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: "raw", protocolVersion: record.protocolVersion, token: record.token, method: "system.ping", params: {}, ...overrides })), { once: true });
    socket.addEventListener("message", (event) => { clearTimeout(timer); socket.close(); resolve(JSON.parse(event.data)); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("raw socket error")); }, { once: true });
  });
}

async function terminalHandshake(record, token = record.terminalToken) {
  const socket = new WebSocket(record.terminalUrl); socket.binaryType = "arraybuffer";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("terminal handshake timeout")), 5000);
    socket.addEventListener("open", () => socket.send(new Uint8Array([...new TextEncoder().encode("TL01"), ...new TextEncoder().encode(token)])), { once: true });
    socket.addEventListener("message", (event) => { clearTimeout(timer); socket.close(); resolve(new TextDecoder().decode(event.data)); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("terminal socket error")); }, { once: true });
  });
}

function uuidBytes(id) { const hex = id.replaceAll("-", ""); return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)); }
function terminalFrame(id, epoch, sequence, kind, payload = new Uint8Array()) { const bytes = new Uint8Array(41 + payload.length); const view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode("TL01")); bytes.set(uuidBytes(id), 4); view.setBigUint64(20, BigInt(epoch)); view.setBigUint64(28, BigInt(sequence)); bytes[36] = kind; view.setUint32(37, payload.length); bytes.set(payload, 41); return bytes; }
function acknowledgedBytes(bytes) { const payload = new Uint8Array(8); new DataView(payload.buffer).setBigUint64(0, BigInt(bytes)); return payload; }

async function terminalRoundTrip(record, session, marker) {
  const socket = new WebSocket(record.terminalUrl); socket.binaryType = "arraybuffer"; const decoder = new TextDecoder(); let text = "";
  await new Promise((resolve, reject) => { socket.addEventListener("open", () => socket.send(new Uint8Array([...new TextEncoder().encode("TL01"), ...new TextEncoder().encode(record.terminalToken)])), { once: true }); socket.addEventListener("message", (event) => { if (decoder.decode(event.data) === "TLOK") resolve(); }, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const command = process.platform === "win32" ? `Write-Output ${marker}` : `printf '${marker}\\n'\n`;
  let nextInputSequence = 2; let attachAcknowledged = false; let cursorResponseSent = false;
  const sendInput = (input) => socket.send(terminalFrame(session.id, session.runtime_epoch, nextInputSequence++, 1, new TextEncoder().encode(input)));
  const result = await new Promise((resolve, reject) => {
    // A cold hosted ConPTY can spend more than 30 seconds between replaying
    // PowerShell's startup DSR and flushing the first submitted command. Keep
    // the tighter Unix budget while allowing the observed Windows startup.
    const timeout = setTimeout(() => reject(new Error(`terminal marker timeout: ${text}`)), process.platform === "win32" ? 90000 : 10000);
    let commandTimer;
    let enterTimer;
    const finishFailure = (error) => { clearTimeout(timeout); clearTimeout(commandTimer); clearTimeout(enterTimer); reject(error); };
    socket.addEventListener("error", () => finishFailure(new Error("terminal round-trip socket error")), { once: true });
    socket.addEventListener("message", (event) => {
      const bytes = new Uint8Array(event.data);
      if (bytes.length < 41) return;
      const kind = bytes[36];
      const payload = bytes.slice(41);
      if (kind === 12) { finishFailure(new Error(`terminal attach/input rejected: ${decoder.decode(payload)}`)); return; }
      if (kind === 11) {
        if (!attachAcknowledged) {
          attachAcknowledged = true;
          if (process.platform !== "win32") commandTimer ??= setTimeout(() => sendInput(command), 50);
        }
        return;
      }
      if (kind !== 2 && kind !== 6) return;
      text += decoder.decode(payload);
      if (process.platform === "win32" && attachAcknowledged && !cursorResponseSent && text.includes("\x1b[6n")) {
        cursorResponseSent = true;
        sendInput("\x1b[1;1R");
        commandTimer ??= setTimeout(() => {
          // ConPTY can discard Enter when it shares the write that is still
          // being replayed as cooked PowerShell input. Mirror production's
          // unframed paste plus separately settled submit boundary.
          sendInput(command);
          enterTimer ??= setTimeout(() => sendInput("\r"), 500);
        }, 250);
      }
      const markerOccurrences = text.split(marker).length - 1;
      // PowerShell echoes the submitted command before executing it. Require
      // the second occurrence so the round trip proves command output, not
      // merely terminal input echo, before a reattach or exit is attempted.
      if (markerOccurrences >= (process.platform === "win32" ? 2 : 1)) { clearTimeout(timeout); clearTimeout(commandTimer); clearTimeout(enterTimer); resolve(text); }
    });
    socket.send(terminalFrame(session.id, session.runtime_epoch, 1, 10));
  });
  socket.close(); return result;
}

async function exitTerminal(record, session) {
  const socket = new WebSocket(record.terminalUrl); socket.binaryType = "arraybuffer"; const decoder = new TextDecoder();
  await new Promise((resolve, reject) => { socket.addEventListener("open", () => socket.send(new Uint8Array([...new TextEncoder().encode("TL01"), ...new TextEncoder().encode(record.terminalToken)])), { once: true }); socket.addEventListener("message", (event) => { if (decoder.decode(event.data) === "TLOK") resolve(); }, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("terminal natural-exit timeout")), process.platform === "win32" ? 15000 : 5000);
    let exitSent = false;
    socket.addEventListener("message", (event) => {
      const bytes = new Uint8Array(event.data);
      if (bytes.length < 41) return;
      const kind = bytes[36];
      if (kind === 12) { clearTimeout(timeout); reject(new Error(`terminal exit rejected: ${decoder.decode(bytes.slice(41))}`)); return; }
      if (kind === 11 && !exitSent) {
        exitSent = true;
        setTimeout(() => socket.send(terminalFrame(session.id, session.runtime_epoch, 2, 1, new TextEncoder().encode(process.platform === "win32" ? "exit\r" : "exit\n"))), process.platform === "win32" ? 250 : 0);
      }
      if (kind === 5) { clearTimeout(timeout); resolve(); }
    });
    socket.send(terminalFrame(session.id, session.runtime_epoch, 1, 10));
  });
  socket.close();
}

async function staleEpochRejected(record, session) {
  const socket = new WebSocket(record.terminalUrl); socket.binaryType = "arraybuffer"; const decoder = new TextDecoder();
  await new Promise((resolve, reject) => { socket.addEventListener("open", () => socket.send(new Uint8Array([...new TextEncoder().encode("TL01"), ...new TextEncoder().encode(record.terminalToken)])), { once: true }); socket.addEventListener("message", (event) => { if (decoder.decode(event.data) === "TLOK") resolve(); }, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const rejected = await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("stale epoch timeout")), 5000); socket.addEventListener("message", (event) => { const bytes = new Uint8Array(event.data); if (bytes.length >= 41 && bytes[36] === 12) { clearTimeout(timeout); resolve(true); } }); socket.send(terminalFrame(session.id, session.runtime_epoch + 1, 1, 10)); });
  socket.close(); return rejected;
}

const evidence = { capturedAt: new Date().toISOString(), platform: process.platform, checks: {} };
let acceptedProjectId;
let firstRuntimeEpoch;
let renamedSessionId;
try {
  const { runtimePath, record } = await waitForRuntime();
  assert.match(record.controlUrl, /^ws:\/\/127\.0\.0\.1:\d+\/control$/);
  assert.match(record.terminalUrl, /^ws:\/\/127\.0\.0\.1:\d+\/terminal$/);
  evidence.checks.loopbackDiscovery = true;

  if (process.platform !== "win32") {
    const mode = (await stat(runtimePath)).mode & 0o777;
    assert.equal(mode, 0o600); evidence.checks.discoveryMode = mode.toString(8);
  }

  const env = { ...process.env, TERMLOOP_RUNTIME_FILE: runtimePath };
  for (const command of ["version", "capabilities", "ping"]) {
    const run = spawnSync("node", ["clients/cli/dist/index.js", command, "--json"], { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr); JSON.parse(run.stdout); evidence.checks[`cli_${command}`] = true;
  }

  const unauthenticated = await rawCall(record, { token: "x".repeat(64) });
  assert.equal(unauthenticated.error.code, "unauthenticated"); evidence.checks.unauthenticated = true;
  const shortCredential = await rawCall(record, { token: "short" });
  assert.equal(shortCredential.error.code, "unauthenticated"); evidence.checks.credentialShapeValidated = true;
  const staleIdentity = `${record.protocolVersion.slice(0, -1)}${record.protocolVersion.endsWith("0") ? "1" : "0"}`;
  const unsupported = await rawCall(record, { protocolVersion: staleIdentity });
  assert.equal(unsupported.error.code, "unsupportedVersion"); evidence.checks.unsupportedVersion = true;
  const staleCases = await Promise.all([
    rawCall(record, { protocolVersion: staleIdentity, params: [] }),
    rawCall(record, { protocolVersion: staleIdentity, unexpected: true }),
    rawCall(record, { protocolVersion: staleIdentity, token: "short", method: "unknown.method", params: [] }),
    rawCall(record, { protocolVersion: staleIdentity, token: record.readOnlyToken, method: "project.create", params: { name: "Must not dispatch", folderPath: process.cwd() } }),
  ]);
  assert.ok(staleCases.every((response) => response.error?.code === "unsupportedVersion"));
  const projectsAfterStaleMutation = await rawCall(record, { method: "project.list" });
  assert.ok(!projectsAfterStaleMutation.result.some((project) => project.name === "Must not dispatch"));
  evidence.checks.identityPreflightBeforeDecodeCapabilityAndDispatch = true;
  const missingIdentity = await rawCall(record, { protocolVersion: undefined });
  const nonStringIdentity = await rawCall(record, { protocolVersion: 42 });
  assert.equal(missingIdentity.error.code, "invalidMessage");
  assert.equal(nonStringIdentity.error.code, "invalidMessage");
  evidence.checks.identityShapeValidated = true;
  const unknown = await rawCall(record, { method: "unknown.method" });
  assert.equal(unknown.error.code, "methodNotFound"); evidence.checks.methodNotFound = true;
  const extraProperty = await rawCall(record, { unexpected: true });
  assert.equal(extraProperty.error.code, "invalidMessage");
  const invalidParamsShape = await rawCall(record, { params: [] });
  assert.equal(invalidParamsShape.error.code, "invalidMessage"); evidence.checks.schemaEnvelopeValidated = true;
  const oversized = await rawCall(record, { params: { payload: "x".repeat(9 * 1024 * 1024) } });
  assert.equal(oversized.error.code, "requestTooLarge"); evidence.checks.oversizedRequestTyped = true;
  const concurrent = await Promise.all([rawCall(record), rawCall(record)]);
  assert.ok(concurrent.every((response) => response.ok === true)); evidence.checks.concurrentControlClients = true;
  assert.equal(await terminalHandshake(record), "TLOK"); evidence.checks.binaryTerminalHandshake = true;
  assert.equal(await terminalHandshake(record, "x".repeat(64)), "TLAUTH"); evidence.checks.terminalCredentialIsolation = true;
  const denied = await rawCall(record, { token: record.readOnlyToken, method: "project.create", params: { name: "Denied", folderPath: process.cwd() } });
  assert.equal(denied.error.code, "capabilityDenied"); evidence.checks.capabilityDenied = true;
  const readable = await rawCall(record, { token: record.readOnlyToken, method: "project.list" });
  assert.equal(readable.ok, true); evidence.checks.readOnlyCapability = true;

  const invalidProject = await rawCall(record, { method: "project.create", params: { folderPath: process.cwd() } });
  assert.equal(invalidProject.error.code, "invalidMessage");
  const extraProjectParam = await rawCall(record, { method: "project.create", params: { name: "Extra", folderPath: process.cwd(), unexpected: true } });
  assert.equal(extraProjectParam.error.code, "invalidMessage");
  const wrongSessionParam = await rawCall(record, { method: "session.terminate", params: { sessionId: 42 } });
  assert.equal(wrongSessionParam.error.code, "invalidMessage");
  const missingRenameName = await rawCall(record, { method: "session.rename", params: { sessionId: "session-1" } });
  assert.equal(missingRenameName.error.code, "invalidMessage");
  evidence.checks.invalidParamsTyped = true;

  const projectResponse = await rawCall(record, { method: "project.create", params: { name: "Acceptance", folderPath: process.cwd() } });
  assert.equal(projectResponse.ok, true); evidence.checks.projectCreate = true;
  acceptedProjectId = projectResponse.result.id;
  const cliProjects = spawnSync("node", ["clients/cli/dist/index.js", "project-list", "--json"], { env, encoding: "utf8" });
  assert.equal(cliProjects.status, 0, cliProjects.stderr); assert.equal(JSON.parse(cliProjects.stdout)[0].id, projectResponse.result.id); evidence.checks.cliProjectFlow = true;
  const missingProject = await rawCall(record, { method: "session.launchTerminal", params: { projectId: "missing", cwd: process.cwd() } });
  assert.equal(missingProject.error.code, "notFound");
  const unsupportedAgent = await rawCall(record, { method: "session.launchAgent", params: { projectId: projectResponse.result.id, cwd: process.cwd(), agentId: "unknown" } });
  assert.equal(unsupportedAgent.error.code, "invalidMessage");
  const missingSession = await rawCall(record, { method: "session.terminate", params: { sessionId: "00000000-0000-0000-0000-000000000000" } });
  assert.equal(missingSession.error.code, "notFound"); evidence.checks.domainErrorsTyped = true;
  const terminalResponse = await rawCall(record, { method: "session.launchTerminal", params: { projectId: projectResponse.result.id, cwd: process.cwd() } });
  assert.equal(terminalResponse.ok, true);
  renamedSessionId = terminalResponse.result.id;
  const deniedRename = await rawCall(record, { token: record.readOnlyToken, method: "session.rename", params: { sessionId: renamedSessionId, name: "Denied" } });
  assert.equal(deniedRename.error.code, "capabilityDenied");
  const cliRename = spawnSync("node", ["clients/cli/dist/index.js", "session-rename", "--session", renamedSessionId, "--name", "  Acceptance shell  ", "--json"], { env, encoding: "utf8" });
  assert.equal(cliRename.status, 0, cliRename.stderr);
  assert.equal(JSON.parse(cliRename.stdout).name, "Acceptance shell");
  const readOnlySessions = await rawCall(record, { token: record.readOnlyToken, method: "session.list" });
  assert.equal(readOnlySessions.result.find((session) => session.id === renamedSessionId).name, "Acceptance shell");
  evidence.checks.sessionRenameCapabilityAndReadProjection = true;
  firstRuntimeEpoch = terminalResponse.result.runtime_epoch;
  assert.equal(await staleEpochRejected(record, terminalResponse.result), true); evidence.checks.staleEpochRejected = true;
  await terminalRoundTrip(record, terminalResponse.result, "TERMLOOP_SLICE_ONE");
  await terminalRoundTrip(record, terminalResponse.result, "TERMLOOP_SLICE_REATTACH"); evidence.checks.terminalReattach = true;
  const claudeAvailable = process.env.TERMLOOP_SKIP_AGENT_SPAWN !== "1" && spawnSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? ["claude"] : ["-c", "command -v claude"], { encoding: "utf8" }).status === 0;
  const agentPreview = claudeAvailable ? await rawCall(record, { method: "session.previewAgent", params: { projectId: projectResponse.result.id, cwd: process.cwd(), agentId: "claude" } }) : undefined;
  if (agentPreview) assert.equal(agentPreview.ok, true);
  const agentResponse = agentPreview ? await rawCall(record, {
    method: "session.launchAgent",
    params: {
      projectId: projectResponse.result.id,
      cwd: process.cwd(),
      agentId: "claude",
      launchTicket: agentPreview.result.launch_ticket,
    },
  }) : undefined;
  if (agentResponse) { assert.equal(agentResponse.ok, true); assert.equal(agentResponse.result.process.agent_id, "claude"); evidence.checks.realAgentSpawn = true; }
  else evidence.checks.realAgentSpawn = process.env.TERMLOOP_SKIP_AGENT_SPAWN === "1" ? "skipped: disabled for this run" : "skipped: claude executable absent";
  const cliSessions = spawnSync("node", ["clients/cli/dist/index.js", "session-list", "--json"], { env, encoding: "utf8" });
  assert.equal(cliSessions.status, 0, cliSessions.stderr); assert.equal(JSON.parse(cliSessions.stdout).length, agentResponse ? 2 : 1); evidence.checks.cliSessionFlow = true;
  const stateText = await readFile(path.join(runtimeDir, "state.v1.json"), "utf8");
  assert.equal(stateText.includes("must-not-be-persisted"), false); evidence.checks.secretFreeProcessDescriptor = true;
  await exitTerminal(record, terminalResponse.result);
  let terminalExited = false;
  for (let attempt = 0; attempt < 50 && !terminalExited; attempt++) {
    const reaped = await rawCall(record, { method: "session.list" });
    terminalExited = reaped.result.find((session) => session.id === terminalResponse.result.id).lifecycle_state === "exited";
    if (!terminalExited) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(terminalExited, true); evidence.checks.naturalExitReconciled = true;
  if (agentResponse) await rawCall(record, { method: "session.terminate", params: { sessionId: agentResponse.result.id } });

  const desktop = spawnSync("pnpm", ["--filter", "@termloop/desktop", "smoke"], { env, encoding: "utf8", timeout: process.platform === "win32" ? 90000 : 30000, shell: process.platform === "win32" });
  assert.equal(desktop.status, 0, `${desktop.stdout}\n${desktop.stderr}\n${desktop.error ?? ""}`);
  assert.match(desktop.stdout, /TERMLOOP_DESKTOP_SMOKE_READY/); evidence.checks.desktopSmoke = true;
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

await rm(path.join(runtimeDir, "runtime.json"), { force: true });
const restarted = spawn(serverPath, [], {
  env: { ...process.env, TERMLOOP_RUNTIME_DIR: runtimeDir, TERMLOOP_STATE_DIR: runtimeDir }, stdio: ["ignore", "pipe", "pipe"]
});
let restartError = ""; restarted.stderr.on("data", (chunk) => { restartError += chunk.toString(); });
let restartRecord;
for (let attempt = 0; attempt < SERVER_DISCOVERY_ATTEMPTS; attempt++) {
  try { restartRecord = JSON.parse(await readFile(path.join(runtimeDir, "runtime.json"), "utf8")); break; } catch { await new Promise((resolve) => setTimeout(resolve, SERVER_DISCOVERY_POLL_MS)); }
}
assert.ok(restartRecord, `restarted server discovery timeout: ${restartError}`);
try {
  const projectsAfterRestart = await rawCall(restartRecord, { method: "project.list" });
  assert.ok(projectsAfterRestart.result.some((project) => project.id === acceptedProjectId)); evidence.checks.durableProjectAcrossRestart = true;
  const sessionsAfterRestart = await rawCall(restartRecord, { method: "session.list" });
  assert.equal(sessionsAfterRestart.result.find((session) => session.id === renamedSessionId).name, "Acceptance shell");
  evidence.checks.sessionNameDurableAcrossRestart = true;
  const restartedSession = await rawCall(restartRecord, { method: "session.launchTerminal", params: { projectId: acceptedProjectId, cwd: process.cwd() } });
  assert.equal(restartedSession.ok, true);
  assert.notEqual(restartedSession.result.runtime_epoch, firstRuntimeEpoch); evidence.checks.daemonRestartEpochChanged = true;
  await rawCall(restartRecord, { method: "session.terminate", params: { sessionId: restartedSession.result.id } });
} finally {
  restarted.kill("SIGTERM");
  await Promise.race([once(restarted, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

await writeFile("artifacts/evidence/s0/local.json", JSON.stringify(evidence, null, 2));
const requiredChecks = ["loopbackDiscovery", "cli_version", "cli_capabilities", "cli_ping", "unauthenticated", "credentialShapeValidated", "unsupportedVersion", "identityPreflightBeforeDecodeCapabilityAndDispatch", "identityShapeValidated", "methodNotFound", "schemaEnvelopeValidated", "oversizedRequestTyped", "concurrentControlClients", "binaryTerminalHandshake", "terminalCredentialIsolation", "capabilityDenied", "readOnlyCapability", "invalidParamsTyped", "projectCreate", "cliProjectFlow", "domainErrorsTyped", "sessionRenameCapabilityAndReadProjection", "staleEpochRejected", "terminalReattach", "cliSessionFlow", "secretFreeProcessDescriptor", "naturalExitReconciled", "desktopSmoke", "durableProjectAcrossRestart", "sessionNameDurableAcrossRestart", "daemonRestartEpochChanged"];
const failedChecks = requiredChecks.filter((name) => evidence.checks[name] !== true);
const status = failedChecks.length === 0 ? "PASS" : "FAIL";
const rows = Object.entries(evidence.checks).map(([name, value]) => `| ${name} | ${String(value)} |`).join("\n");
await writeFile("artifacts/evidence/s0/REPORT.md", `# S0/F0 local acceptance report

- Status: **${status}**
- Captured: ${evidence.capturedAt}
- Execution host: ${evidence.platform}
- Scope: loopback discovery/auth, generated control contract, binary terminal plane, Project creation, Session naming, terminal attach/re-attach, optional real agent spawn, secret-free durable descriptor, sandboxed Electron smoke

| Check | Result |
|---|---|
${rows}

Linux and Windows are covered by the checked-in CI matrix and local Rust all-target type-checks for \`x86_64-unknown-linux-gnu\` and \`x86_64-pc-windows-msvc\`. This report does not claim that hosted Linux/Windows jobs have run; their native runtime evidence remains a CI requirement. See \`CROSS-TARGETS.md\`.
`);
assert.equal(status, "PASS", `acceptance report failed: ${failedChecks.join(", ")}`);
console.log(`S0_ACCEPTANCE_OK: ${Object.keys(evidence.checks).length} checks`);

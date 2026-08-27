import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "termloop-mcp-acceptance-"));
const runtimeDir = path.join(root, "runtime");
const stateDir = path.join(root, "state");
const fakeHome = path.join(root, "home");
const fakeBin = path.join(root, "bin");
const evidenceDir = path.join(root, "evidence");
const repositoryConfigPaths = [path.join(process.cwd(), ".mcp.json"), path.join(process.cwd(), ".codex", "config.toml")];
const repositoryConfigBefore = new Map(await Promise.all(repositoryConfigPaths.map(async (file) => [
  file,
  await readFile(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error)),
])));
await Promise.all([runtimeDir, stateDir, fakeHome, fakeBin, evidenceDir].map((dir) => mkdir(dir, { recursive: true })));
await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
const claudeSentinel = JSON.stringify({ mcpServers: { existing: { command: "existing" } } });
const codexSentinel = "[mcp_servers.existing]\ncommand = \"existing\"\n";
await writeFile(path.join(fakeHome, ".claude.json"), claudeSentinel);
await writeFile(path.join(fakeHome, ".codex", "config.toml"), codexSentinel);

const fakeAgent = path.resolve("tests/e2e/mcp/fake-agent.mjs");
for (const provider of ["claude", "codex"]) {
  const executable = path.join(fakeBin, provider);
  await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAgent)} ${provider} ${JSON.stringify(evidenceDir)} \"$@\"\n`);
  await chmod(executable, 0o755);
}

const build = spawnSync("cargo", ["build", "-p", "termloop-server"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const serverPath = path.resolve("target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
let serverError = "";
function startServer() {
  const child = spawn(serverPath, [], {
    env: {
      ...process.env,
      HOME: fakeHome,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      TERMLOOP_RUNTIME_DIR: runtimeDir,
      TERMLOOP_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
  return child;
}
let server = startServer();

async function waitForJson(file, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error(`timed out waiting for ${file}: ${serverError}`);
}
async function rawCall(record, method, params) {
  const socket = new WebSocket(record.controlUrl);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`control timeout: ${method}`)), 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      id: method,
      protocolVersion: record.protocolVersion,
      token: record.token,
      method,
      params,
    })), { once: true });
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      socket.close();
      const response = JSON.parse(event.data);
      if (!response.ok) reject(new Error(JSON.stringify(response.error)));
      else resolve(response.result);
    }, { once: true });
    socket.addEventListener("error", () => reject(new Error(`control connection failed: ${method}`)), { once: true });
  });
}

try {
  const record = await waitForJson(path.join(runtimeDir, "runtime.json"));
  const configPath = path.join(runtimeDir, "agent-mcp.json");
  const config = await waitForJson(configPath);
  assert.match(config.mcpServers.termloop_next.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(config.mcpServers.termloop_next.headers.Authorization, "Bearer ${TERMLOOP_MCP_TOKEN}");
  if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  const project = await rawCall(record, "project.create", { name: "MCP acceptance", folderPath: process.cwd() });
  const launchParams = { projectId: project.id, cwd: process.cwd(), agentId: "claude" };
  const preview = await rawCall(record, "session.previewAgent", launchParams);
  await rawCall(record, "session.launchAgent", { ...launchParams, launchTicket: preview.launch_ticket });
  const askerBeforeRestart = await waitForJson(path.join(evidenceDir, "asker-pre-restart.json"), 800);
  const helperBeforeRestart = await waitForJson(path.join(evidenceDir, "helper-pre-restart.json"));
  const sessions = await rawCall(record, "session.list", {});
  const helperSession = sessions.find((session) => session.process.template_ref === "builtin.agent.ask-to-helper");
  const sourceSession = helperSession
    ? sessions.find((session) => session.id === helperSession.ask_to_source_session_id)
    : undefined;
  assert.ok(helperSession, "Ask-To helper Session must stay visible");
  assert.ok(sourceSession, "Ask-To helper must project its exact visible source Session");
  assert.equal(sourceSession.ask_to_source_session_id, null);
  assert.equal(askerBeforeRestart.status, "pending");
  assert.deepEqual(helperBeforeRestart.tools, ["ask_to", "send_to_agent", "reply_to_request"]);

  const firstServerExit = new Promise((resolve) => server.once("exit", resolve));
  // Crash the daemon so durable restart reconciliation, rather than an explicit
  // Session exit, owns provider resume and Ask-To recovery.
  server.kill("SIGKILL");
  await firstServerExit;
  await rm(path.join(runtimeDir, "runtime.json"), { force: true });
  serverError = "";
  server = startServer();
  const restartedRecord = await waitForJson(path.join(runtimeDir, "runtime.json"));
  const asker = await waitForJson(path.join(evidenceDir, "asker.json"), 800);
  const helper = await waitForJson(path.join(evidenceDir, "helper.json"), 800);
  const restartedSessions = await rawCall(restartedRecord, "session.list", {});
  const restartedHelper = restartedSessions.find((session) => session.id === helperSession.id);
  const restartedSource = restartedSessions.find((session) => session.id === sourceSession.id);
  assert.ok(restartedHelper, "Ask-To helper Session must survive daemon restart");
  assert.ok(restartedSource, "Ask-To source Session must survive daemon restart");
  assert.equal(restartedHelper.ask_to_source_session_id, restartedSource.id);
  assert.deepEqual(asker.tools, ["ask_to", "send_to_agent"]);
  assert.deepEqual(helper.tools, ["ask_to", "send_to_agent", "reply_to_request"]);
  assert.equal(asker.discoveryFallback, true);
  assert.equal(asker.idempotentRequest, true);
  assert.equal(asker.status, "pending");
  assert.equal(asker.pushedReplyVisible, true);
  assert.equal(asker.followUpStatus, "pending");
  assert.equal(asker.pushedFollowUpVisible, true);
  assert.equal(asker.followUpConversationId, asker.conversationId);
  assert.notEqual(asker.followUpRequestId, null);
  assert.equal(helper.status, "delivered");
  assert.equal(helper.duplicateReplyDeniedAfterDelivery, true);
  assert.equal(helper.followUpStatus, "delivered");
  assert.equal(helper.followUpPromptVisible, true);
  assert.equal(helper.recoveryPromptVisible, true);
  assert.equal(helper.requestMismatchDenied, true);
  assert.equal(asker.initializedBeforeReadiness, true);
  assert.equal(helper.initializedBeforeReadiness, true);
  assert.equal(asker.preCommitCommandDenied, true);
  assert.equal(helper.preCommitCommandDenied, true);
  assert.equal(asker.tokenInArguments, false);
  assert.equal(helper.tokenInArguments, false);
  assert.equal(asker.subprocessBearerVisible, true);
  assert.equal(helper.subprocessBearerVisible, true);
  assert.equal(asker.denialChecks, true);

  assert.equal(await readFile(path.join(fakeHome, ".claude.json"), "utf8"), claudeSentinel);
  assert.equal(await readFile(path.join(fakeHome, ".codex", "config.toml"), "utf8"), codexSentinel);
  await assert.rejects(stat(path.join(fakeHome, ".mcp.json")), { code: "ENOENT" });
  for (const file of repositoryConfigPaths) {
    const after = await readFile(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    assert.deepEqual(after, repositoryConfigBefore.get(file), `repository MCP config changed: ${file}`);
  }
  console.log(JSON.stringify({
    status: "passed",
    checks: {
      oneDaemonEndpoint: true,
      schemaGeneratedRoleScoping: true,
      idempotentLostResponseRecovery: true,
      pushedSingleReplyRoundTrip: true,
      liveHelperFollowUpReuse: true,
      askToCallerProjection: true,
      restartPreservesCallerProjection: true,
      restartPreservesReplyAndFollowUp: true,
      eagerResumeMcpInitialization: true,
      preCommitMcpCommandsDenied: true,
      providerConfigUnchanged: true,
      secretFreePrivateClaudeConfig: true,
      subprocessBearerRadiusRecorded: true,
      authOriginRevisionAndBodyLimits: true,
    },
  }, null, 2));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f1-agent-fork-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const mismatchAgentDirectory = path.join(projectDirectory, "mismatch-agent");
const rejectedCodexDirectory = path.join(projectDirectory, "rejected-codex");
const flakyCodexDirectory = path.join(projectDirectory, "flaky-codex");
const taskWorktreeDirectory = path.join(temporary, "task-worktree");
const testHomeDirectory = path.join(temporary, "home");
const binDirectory = path.join(testHomeDirectory, ".local", "bin");
const tracePath = path.join(temporary, "provider-modes.txt");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const evidencePath = path.join(root, "artifacts/evidence/f1/agent-fork.local.json");
const serverBinary = path.join(root, "target", "debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const wsModule = createRequire(import.meta.url).resolve("ws");

await Promise.all([
  runtimeDirectory,
  stateDirectory,
  projectDirectory,
  mismatchAgentDirectory,
  rejectedCodexDirectory,
  flakyCodexDirectory,
  binDirectory,
  path.dirname(evidencePath),
].map((directory) => mkdir(directory, { recursive: true })));
await installFakeProviders();
git(["init", "--initial-branch=main", projectDirectory]);
git(["-C", projectDirectory, "config", "user.name", "TermLoop Fixture"]);
git(["-C", projectDirectory, "config", "user.email", "fixture@termloop.invalid"]);
git(["-C", projectDirectory, "commit", "--allow-empty", "-m", "fixture"]);

const evidence = {
  schema: "f1-agent-fork-v1",
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

let server;
let serverStderr = () => "";
try {
  let record;
  [server, record, serverStderr] = await startServer();
  const project = await controlCall(record, "project.create", { name: "Fork", folderPath: projectDirectory });
  const task = await controlCall(record, "task.create", {
    projectId: project.id,
    title: "Guarded fork",
    brief: null,
    worktreeIntent: "none",
  });
  await controlCall(record, "task.provisionWorktree", {
    operationId: crypto.randomUUID(),
    taskId: task.id,
    repositoryPath: projectDirectory,
    destinationPath: taskWorktreeDirectory,
    branchName: "feature/guarded-fork",
    branchMode: "create",
    baseRef: "refs/heads/main",
  });
  const claude = await launchAgent(record, { projectId: project.id, cwd: projectDirectory, agentId: "claude" });
  const codex = await launchAgent(record, { projectId: project.id, cwd: projectDirectory, agentId: "codex" });
  const taskClaude = await launchTaskAgent(record, { taskId: task.id, agentId: "claude" });
  const terminal = await controlCall(record, "session.launchTerminal", { projectId: project.id, cwd: projectDirectory });
  await controlCall(record, "session.rename", { sessionId: claude.id, name: "Research" });

  const sources = await waitUntil(async () => {
    const sessions = await controlCall(record, "session.list");
    const privateState = JSON.parse(await readFile(path.join(stateDirectory, "state.v1.json"), "utf8"));
    return [claude.id, codex.id, taskClaude.id].every((id) =>
      sessions.find((session) => session.id === id)?.forkable
      && privateState.sessions.find((session) => session.id === id)?.resume_ref?.nativeSessionId)
      ? sessions
      : undefined;
  }, 8_000, "fresh agent references did not become forkable");
  evidence.checks.onlyRunningAgentsProjectForkable = sources.find((session) => session.id === terminal.id)?.forkable === false;

  const claudeChild = await controlCall(record, "session.forkAgent", { sessionId: claude.id });
  const codexChild = await controlCall(record, "session.forkAgent", { sessionId: codex.id });
  const taskClaudeChild = await controlCall(record, "session.forkAgent", { sessionId: taskClaude.id });
  const forked = await waitUntil(async () => {
    const sessions = await controlCall(record, "session.list");
    return [claudeChild.id, codexChild.id, taskClaudeChild.id].every((id) => sessions.find((session) => session.id === id)?.forkable)
      ? sessions
      : undefined;
  }, 8_000, "fork child references did not become independently forkable");

  const currentClaude = forked.find((session) => session.id === claude.id);
  const currentCodex = forked.find((session) => session.id === codex.id);
  evidence.checks.sourceSessionsRemainRunning = currentClaude?.lifecycle_state === "running"
    && currentCodex?.lifecycle_state === "running"
    && currentClaude.runtime_epoch === claude.runtime_epoch
    && currentCodex.runtime_epoch === codex.runtime_epoch;
  evidence.checks.childrenAreNewSameProviderSessions = claudeChild.id !== claude.id
    && codexChild.id !== codex.id
    && claudeChild.project_id === claude.project_id
    && codexChild.project_id === codex.project_id
    && claudeChild.process.cwd === claude.process.cwd
    && codexChild.process.cwd === codex.process.cwd
    && claudeChild.process.agent_id === "claude"
    && codexChild.process.agent_id === "codex"
    && taskClaudeChild.process.cwd === taskClaude.process.cwd
    && taskClaudeChild.process.agent_id === "claude";
  evidence.checks.childNameUsesSourceNameAndForkSuffix = claudeChild.name === "Research fork-1"
    && codexChild.name === "Codex fork-1"
    && taskClaudeChild.name === "Claude fork-1";
  evidence.checks.taskWorktreeGuardIsInheritedAndFreshlyObserved = taskClaudeChild.process.cwd === taskClaude.process.cwd
    && forked.find((session) => session.id === taskClaude.id)?.lifecycle_state === "running";

  const privateState = JSON.parse(await readFile(path.join(stateDirectory, "state.v1.json"), "utf8"));
  const privateIds = privateState.sessions
    .map((session) => session.resume_ref?.nativeSessionId)
    .filter(Boolean);
  assert.equal(privateIds.length, 6);
  evidence.checks.childrenReceiveDistinctPrivateReferences = new Set(privateIds).size === 6;
  evidence.checks.publicProjectionRedactsReferences = privateIds.every((id) => !JSON.stringify(forked).includes(id))
    && forked.filter((session) => session.kind === "Agent").every((session) => session.process.args.length === 0);
  evidence.checks.noParentOrHistoryPersisted = privateState.sessions.every((session) =>
    !("parent" in session) && !("parent_session_id" in session) && !("fork" in session),
  );

  const mismatchSource = await launchAgent(record, {
    projectId: project.id,
    cwd: mismatchAgentDirectory,
    agentId: "claude",
  });
  await waitUntil(async () => {
    const state = JSON.parse(await readFile(path.join(stateDirectory, "state.v1.json"), "utf8"));
    return state.sessions.find((session) => session.id === mismatchSource.id)?.resume_ref?.nativeSessionId || undefined;
  },
  8_000, "mismatch fixture source did not become forkable");
  const countBeforeMismatch = (await controlCall(record, "session.list")).length;
  const mismatchFailure = await controlFailure(record, "session.forkAgent", { sessionId: mismatchSource.id });
  const afterMismatch = await controlCall(record, "session.list");
  const retainedMismatch = afterMismatch.find((session) => session.id !== mismatchSource.id
    && session.name === "Claude fork-1"
    && session.process.cwd === mismatchSource.process.cwd);
  evidence.checks.claudeEarlyFailureIsTypedAndInspectable =
    mismatchFailure.error?.details?.kind === "agentForkUnavailable"
    && ["conversationUnconfirmed", "startupExited"].includes(mismatchFailure.error.details.reason)
    && afterMismatch.length === countBeforeMismatch + 1
    && retainedMismatch?.lifecycle_state === "exited"
    && afterMismatch.find((session) => session.id === mismatchSource.id)?.lifecycle_state === "running";

  const rejectedCodexSource = await launchAgent(record, {
    projectId: project.id,
    cwd: rejectedCodexDirectory,
    agentId: "codex",
  });
  await waitUntil(async () => {
    const state = JSON.parse(await readFile(path.join(stateDirectory, "state.v1.json"), "utf8"));
    return state.sessions.find((session) => session.id === rejectedCodexSource.id)?.resume_ref?.nativeSessionId || undefined;
  },
  8_000, "rejected Codex fixture source did not become forkable");
  const countBeforeProviderRejection = (await controlCall(record, "session.list")).length;
  const startupExit = await controlFailure(record, "session.forkAgent", { sessionId: rejectedCodexSource.id });
  const afterProviderRejection = await controlCall(record, "session.list");
  const retainedStartupExit = afterProviderRejection.find((session) => session.id !== rejectedCodexSource.id
    && session.name === "Codex fork-1"
    && session.process.cwd === rejectedCodexSource.process.cwd);
  evidence.checks.startupExitIsTypedAndInspectable =
    startupExit.error?.details?.kind === "agentForkUnavailable"
    && startupExit.error.details.reason === "startupExited"
    && afterProviderRejection.length === countBeforeProviderRejection + 1
    && retainedStartupExit?.lifecycle_state === "exited"
    && afterProviderRejection.find((session) => session.id === rejectedCodexSource.id)?.lifecycle_state === "running";

  const flakyCodexSource = await launchAgent(record, {
    projectId: project.id,
    cwd: flakyCodexDirectory,
    agentId: "codex",
  });
  await waitUntil(async () => {
    const state = JSON.parse(await readFile(path.join(stateDirectory, "state.v1.json"), "utf8"));
    return state.sessions.find((session) => session.id === flakyCodexSource.id)?.resume_ref?.nativeSessionId || undefined;
  },
  8_000, "flaky Codex fixture source did not become forkable");
  const countBeforeFlakyFork = (await controlCall(record, "session.list")).length;
  const flakyCodexChild = await controlCall(record, "session.forkAgent", { sessionId: flakyCodexSource.id });
  const afterFlakyFork = await controlCall(record, "session.list");
  evidence.checks.transientStartupExitRetriesAtomically =
    afterFlakyFork.length === countBeforeFlakyFork + 1
    && afterFlakyFork.find((session) => session.id === flakyCodexChild.id)?.lifecycle_state === "running";

  const trace = (await readFile(tracePath, "utf8")).trim().split("\n");
  const claudeForkCount = trace.filter((line) => line === "claude-fork").length;
  evidence.checks.nativeProviderForkPathsUsed = claudeForkCount >= 3
    && claudeForkCount <= 6
    && trace.filter((line) => line === "codex-fork").length === 9;

  git(["-C", taskWorktreeDirectory, "checkout", "--detach"]);
  const countBeforeDetachedFork = (await controlCall(record, "session.list")).length;
  const detachedChild = await controlCall(record, "session.forkAgent", { sessionId: taskClaude.id });
  evidence.checks.detachedTaskWorktreeRemainsForkableUnderManagedProof =
    detachedChild.process.cwd === taskClaude.process.cwd
    && (await controlCall(record, "session.list")).length === countBeforeDetachedFork + 1;

  await controlCall(record, "session.terminate", { sessionId: claude.id });
  const countBeforeExitedFork = (await controlCall(record, "session.list")).length;
  const exitedSourceChild = await controlCall(record, "session.forkAgent", { sessionId: claude.id });
  evidence.checks.exitedSourceRemainsForkable = exitedSourceChild.process.agent_id === "claude"
    && exitedSourceChild.process.cwd === claude.process.cwd
    && (await controlCall(record, "session.list")).length === countBeforeExitedFork + 1;
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (server?.exitCode === null) {
    server.kill("SIGINT");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  evidence.status = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0 ? "PASS" : "FAIL";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.status !== "PASS" && serverStderr()) process.stderr.write(serverStderr());
  await rm(temporary, { recursive: true, force: true });
  if (evidence.status !== "PASS") process.exitCode = 1;
}

async function installFakeProviders() {
  if (process.platform === "win32") throw new Error("deterministic provider adapters are not yet implemented for Windows");
  const claudePath = path.join(binDirectory, "claude");
  await writeFile(claudePath, `#!/bin/sh
case "$1" in
  --help) printf '%s\\n' '  --session-id <uuid>' '  --resume <uuid>' '  --fork-session' '  --settings <file>'; exit 0 ;;
  --version) echo '2.1.fake'; exit 0 ;;
esac
settings=''; previous=''
for argument in "$@"; do
  if [ "$previous" = '--settings' ]; then settings="$argument"; break; fi
  previous="$argument"
done
run_hook() {
  event="$1"; native_id="$2"
  [ -n "$settings" ] || return
  hook_command=$(node -e "const value=JSON.parse(process.argv[1]); process.stdout.write(value.hooks[process.argv[2]][0].hooks[0].command)" "$settings" "$event")
  printf '{"hook_event_name":"%s","session_id":"%s"}' "$event" "$native_id" | sh -c "$hook_command"
}
case " $* " in
  *' --fork-session '*)
    echo claude-fork >> '${tracePath}'
    child_id=$(node -e 'console.log(crypto.randomUUID())')
    attempt=0
    until run_hook SessionStart "$child_id"; do
      attempt=$((attempt + 1))
      [ "$attempt" -lt 20 ] || exit 24
      sleep 0.05
    done
    if [ "$(basename "$PWD")" = 'mismatch-agent' ]; then
      replacement_id=$(node -e 'console.log(crypto.randomUUID())')
      run_hook SessionStart "$replacement_id"
      exit 23
    fi
    ;;
  *' --session-id '*) echo claude-fresh >> '${tracePath}' ;;
esac
while :; do sleep 1; done
`);
  await chmod(claudePath, 0o755);

  const codexPath = path.join(binDirectory, "codex");
  await writeFile(codexPath, `#!/usr/bin/env node
const { WebSocket, WebSocketServer } = require(${JSON.stringify(wsModule)});
const fs = require("node:fs"); const crypto = require("node:crypto"); const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("  --remote <ADDR>"); process.exit(0); }
if (args[0] === "--version") { console.log("codex-cli 0.fake"); process.exit(0); }
if (args[0] === "app-server" && args.includes("--help")) { console.log("  --listen <URL>"); process.exit(0); }
if (args[0] === "resume" && args.includes("--help")) { console.log("Usage: codex resume [OPTIONS] [SESSION_ID]"); console.log("  --remote <ADDR>"); process.exit(0); }
if (args[0] === "fork" && args.includes("--help")) { console.log("Usage: codex fork [OPTIONS] [SESSION_ID]"); console.log("  --remote <ADDR>"); process.exit(0); }
if (args[0] === "app-server") {
  const endpoint = new URL(args[args.indexOf("--listen") + 1]);
  const appServer = new WebSocketServer({ host: endpoint.hostname, port: Number(endpoint.port) });
  appServer.on("connection", (socket) => socket.on("message", (raw) => {
    const initialize = JSON.parse(String(raw));
    socket.send(JSON.stringify({ method: "thread/started", params: { thread: { id: initialize.mode === "resume" ? initialize.sourceId : crypto.randomUUID() } } }));
  }));
  return;
}
fs.appendFileSync(${JSON.stringify(tracePath)}, (args[0] === "fork" ? "codex-fork" : "codex-fresh") + "\\n");
if (args[0] === "fork" && require("node:path").basename(process.cwd()) === "rejected-codex") {
  process.stderr.write("CODEX_FORK_REJECTED_DIAGNOSTIC\\n");
  process.exit(23);
}
if (args[0] === "fork" && require("node:path").basename(process.cwd()) === "flaky-codex") {
  const marker = require("node:path").join(process.cwd(), ".first-fork-exited");
  const exits = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0;
  if (exits < 3) { fs.writeFileSync(marker, String(exits + 1)); process.exit(23); }
}
const endpoint = args[args.indexOf("--remote") + 1];
const connect = () => {
  const socket = new WebSocket(endpoint);
  socket.on("open", () => socket.send(JSON.stringify({ mode: args[0] || "fresh", sourceId: args[1] || null })));
};
if (args[0] === "fork") {
  process.stdout.write("\u001b[6n");
  let input = "";
  const timeout = setTimeout(() => process.exit(24), 2_000);
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.includes("\u001b[1;1R")) {
      clearTimeout(timeout);
      input = "";
      connect();
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
    }
  });
  process.stdin.resume();
} else {
  connect();
}
setInterval(() => {}, 1000);
`);
  await chmod(codexPath, 0o755);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: temporary,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" },
  });
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
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const record = await waitUntil(async () => {
    try {
      const value = JSON.parse(await readFile(runtimeFile, "utf8"));
      return value.pid === child.pid ? value : undefined;
    } catch {
      return undefined;
    }
  }, 10_000, () => `runtime discovery did not appear: ${stderr}`);
  return [child, record, () => stderr.slice(-4_000)];
}

async function controlCall(record, method, params = {}) {
  const response = await controlResponse(record, method, params);
  if (!response.ok) {
    throw new Error(`${method}: ${response.error?.message ?? "failed"} ${JSON.stringify(response.error?.details ?? {})}`);
  }
  return response.result;
}

async function launchAgent(record, params) {
  const preview = await controlCall(record, "session.previewAgent", params);
  return controlCall(record, "session.launchAgent", { ...params, launchTicket: preview.launch_ticket });
}

async function launchTaskAgent(record, params) {
  const preview = await controlCall(record, "task.previewAgent", params);
  return controlCall(record, "task.launchAgent", { ...params, launchTicket: preview.launch_ticket });
}

async function controlFailure(record, method, params = {}) {
  const response = await controlResponse(record, method, params);
  assert.equal(response.ok, false);
  return response;
}

async function controlResponse(record, method, params) {
  const socket = new WebSocket(record.controlUrl);
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 12_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.token, method, params })));
    socket.on("message", (raw) => {
      const response = JSON.parse(String(raw));
      if (response.id !== id) return;
      clearTimeout(timeout); socket.close(); resolve(response);
    });
    socket.once("error", reject);
  });
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

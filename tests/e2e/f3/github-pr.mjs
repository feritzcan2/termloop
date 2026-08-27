import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f3-github-pr-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const repository = path.join(temporary, "repository");
const fakeBin = path.join(temporary, "bin");
const modeFile = path.join(temporary, "gh-mode");
const gitCountFile = path.join(temporary, "git-count");
const ghApiCountFile = path.join(temporary, "gh-api-count");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f3/github-pr.local.json");
const reportPath = path.join(root, "artifacts/evidence/f3/README.md");
const evidence = {
  schema: "f3-github-pr-single-task-smoke-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    readOnlyProjection: false,
    remoteHeadDifferentFromLocal: false,
    multipleMatchesRemainList: false,
    scopedInvalidationDoesNotAdvanceStateRevision: false,
    taskTruthUnchanged: false,
    privateCachePermissions: false,
    cacheWipeRebuilds: false,
    rawProviderFailureRedacted: false,
    freshProjectionAvoidsGitSubprocesses: false,
    concurrentSameKeyProviderDedup: false,
  },
  skipped: {
    liveGitHub: "requires a named disposable GitHub account/repository and authenticated gh",
    windowsLinuxRuntime: process.platform === "darwin" ? "local runtime evidence is macOS only" : "local host only",
    keychainSecretService: "daemon-spawned non-TTY secure-storage retrieval not exercised by the deterministic fake gh",
    offlineProxyCustomCa: "requires named external network fixtures",
    githubEnterprise: "out of F3 scope",
    customGhConfigDir: "out of F3 scope",
    fiftyTaskThreeBatchTwoJobBudget: "the deterministic local acceptance uses one Task; the 50-Task concurrency/latency matrix remains unmeasured",
    aliasVsBatchFailureIsolation: "covered by provider unit fixtures but not repeated in this process-level evidence run",
    slowConsumerByteBudgetClose: "covered by server queue tests; a real slow WebSocket consumer is not exercised here",
    timeoutProcessTreeReaping: "platform fixtures cover bounded children locally; the provider timeout tree is not measured in this acceptance run",
    daemonKillOrphanReconciliation: "requires destructive daemon-kill orchestration and remains an explicit recovery evidence gap",
    idleSixtyFiveSeconds: "the 65-second zero-work/zero-invalidation window remains unmeasured",
    onePatchOneRender: "renderer store tests cover patch dedupe; shown Electron render counts remain unmeasured",
    forkOnlyParentDiscovery: "provider unit fixtures cover parent normalization; no process-level fork-only repository is built here",
    partialDeletedHeadPagination: "provider unit fixtures cover incomplete deleted heads and the seventeenth match; the single-Task process smoke does not",
    timeoutSignalOversizeMatrix: "focused platform/provider tests cover these cases; this acceptance run uses success and classified failure only",
    cacheFreshStaleExpiryMatrix: "store/core unit fixtures cover row semantics; wall-clock 5/30-minute process evidence remains unmeasured",
    daemonClientRestart: "cache wipe plus daemon restart is measured; client reconnect/gap recovery is not",
    gitConfigWatcherChange: "watch classification is unit-tested; a process-level notify event is not measured here",
    shownElectronUi: "desktop build, unit tests, and running-window smoke pass separately; no human-visible Electron capture is claimed",
  },
  failures: [],
};

let server;
let subscription;
try {
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
    mkdir(repository, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(path.dirname(evidencePath), { recursive: true }),
  ]);
  initializeRepository();
  await installFakeGh();
  await writeFile(modeFile, "success");
  server = await startServer();
  let record = await readRecord(server.pid);
  const project = await controlCall(record, "project.create", { name: "F3", folderPath: repository });
  const task = await controlCall(record, "task.create", { projectId: project.id, title: "Projected", brief: null, worktreeIntent: "none" });
  await controlCall(record, "task.bindBranch", { taskId: task.id, repositoryPath: repository, branchName: "main" });
  const stateBefore = await readFile(path.join(stateDirectory, "state.v1.json"));
  const revisionBefore = (await controlCall(record, "control.subscribe", { topics: ["gitHost"] })).stateRevision;
  subscription = await subscribe(record, project.id);
  const [response, duplicateResponse] = await Promise.all([
    rawControlCall(record, record.readOnlyToken, "gitHost.pullRequestList", {
      projectId: project.id,
      taskIds: [task.id],
    }),
    rawControlCall(record, record.readOnlyToken, "gitHost.pullRequestList", {
      projectId: project.id,
      taskIds: [task.id],
    }),
  ]);
  assert.equal(response.ok, true);
  assert.deepEqual(duplicateResponse.result, response.result);
  assert.equal(await invocationCount(ghApiCountFile), 1);
  evidence.checks.concurrentSameKeyProviderDedup = true;
  const projection = response.result[0];
  assert.equal(projection.branch_name, "main");
  assert.equal(projection.freshness, "fresh");
  assert.equal(projection.candidate_truncated, false);
  assert.equal(projection.matches.length, 2);
  assert.deepEqual(projection.matches.map((match) => match.number), [42, 41]);
  assert.ok(projection.matches.every((match) => match.head_branch === "review/42"));
  evidence.checks.readOnlyProjection = true;
  evidence.checks.remoteHeadDifferentFromLocal = true;
  evidence.checks.multipleMatchesRemainList = true;
  const gitCountAfterColdQuery = await invocationCount(gitCountFile);
  const freshAgain = await controlCall(record, "gitHost.pullRequestList", {
    projectId: project.id,
    taskIds: [task.id],
  });
  assert.equal(freshAgain[0].freshness, "fresh");
  assert.equal(await invocationCount(gitCountFile), gitCountAfterColdQuery);
  evidence.checks.freshProjectionAvoidsGitSubprocesses = true;

  const invalidation = await subscription.next();
  assert.deepEqual(invalidation.topics, ["gitHost"]);
  assert.equal(invalidation.stateRevision, revisionBefore);
  assert.deepEqual(invalidation.entityScopes, [{ topic: "gitHost", ids: [task.id] }]);
  evidence.checks.scopedInvalidationDoesNotAdvanceStateRevision = true;
  subscription.close();
  subscription = undefined;

  assert.deepEqual(await readFile(path.join(stateDirectory, "state.v1.json")), stateBefore);
  const durableTask = (await controlCall(record, "task.list", { projectId: project.id }))[0];
  assert.equal("pull_requests" in durableTask || "git_host" in durableTask, false);
  evidence.checks.taskTruthUnchanged = true;

  const cachePath = path.join(stateDirectory, "provider-cache.v1.json");
  await waitUntil(async () => {
    const cache = await readFile(cachePath, "utf8").catch(() => "");
    return cache.includes("Private fixture PR");
  }, 4_000, "provider cache did not flush");
  if (process.platform !== "win32") {
    assert.equal((await stat(cachePath)).mode & 0o077, 0);
  }
  evidence.checks.privateCachePermissions = true;

  await stopServer(server);
  server = undefined;
  await rm(cachePath, { force: true });
  await writeFile(modeFile, "failure");
  server = await startServer();
  record = await readRecord(server.pid);
  const degraded = await controlCall(record, "gitHost.pullRequestList", { projectId: project.id, taskIds: [task.id] });
  assert.equal(degraded[0].freshness, "unavailable");
  assert.equal(degraded[0].reason, "providerFailure");
  assert.equal(JSON.stringify(degraded).includes("SUPERSECRET_PROVIDER_DIAGNOSTIC"), false);
  assert.equal((await readFile(path.join(stateDirectory, "state.v1.json"), "utf8")).includes("SUPERSECRET_PROVIDER_DIAGNOSTIC"), false);
  evidence.checks.cacheWipeRebuilds = true;
  evidence.checks.rawProviderFailureRedacted = true;
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  subscription?.close();
  if (server) await stopServer(server).catch(() => undefined);
  evidence.status = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0
    ? "PASS_SINGLE_TASK_SMOKE_WITH_SKIPS"
    : "FAIL";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(reportPath, renderReport(evidence));
  await rm(temporary, { recursive: true, force: true });
}
assert.notEqual(evidence.status, "FAIL", evidence.failures.join("\n"));
console.log(`F3 GitHub PR acceptance: ${evidence.status}`);

function initializeRepository() {
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "TermLoop Test"]);
  git(["config", "user.email", "test@termloop.invalid"]);
  git(["commit", "--allow-empty", "-m", "fixture"]);
  git(["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  git(["config", "branch.main.remote", "origin"]);
  git(["config", "branch.main.merge", "refs/heads/review/42"]);
}

function git(args) {
  execFileSync("git", args, { cwd: repository, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
}

async function installFakeGh() {
  if (process.platform === "win32") throw new Error("deterministic fake gh fixture is not implemented for Windows");
  const response = JSON.stringify({
    data: {
      q0: {
        isFork: false,
        pullRequests: { pageInfo: { hasNextPage: false }, nodes: [pullRequest(42, "Private fixture PR", false, "2026-08-10T10:00:00Z"), pullRequest(41, "Second matching PR", true, "2026-08-09T10:00:00Z")] },
        parent: null,
      },
      q1: {
        isFork: false,
        pullRequests: { pageInfo: { hasNextPage: false }, nodes: [pullRequest(42, "Private fixture PR", false, "2026-08-10T10:00:00Z"), pullRequest(41, "Second matching PR", true, "2026-08-09T10:00:00Z")] },
        parent: null,
      },
      rateLimit: { remaining: 4999, resetAt: "2026-08-10T11:00:00Z" },
    },
  });
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version fixture"; exit 0; fi\nif [ "$*" != "api --hostname github.com graphql --input -" ]; then echo "SUPERSECRET_PROVIDER_DIAGNOSTIC bad argv" >&2; exit 2; fi\nprintf '1\\n' >> ${shellQuote(ghApiCountFile)}\ncat >/dev/null\nif [ "$(cat ${shellQuote(modeFile)})" = "failure" ]; then echo "SUPERSECRET_PROVIDER_DIAGNOSTIC provider exploded" >&2; exit 2; fi\nprintf '%s\\n' ${shellQuote(response)}\n`;
  const executable = path.join(fakeBin, "gh");
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitWrapper = `#!/bin/sh\nprintf '1\\n' >> ${shellQuote(gitCountFile)}\nexec ${shellQuote(realGit)} "$@"\n`;
  const gitExecutable = path.join(fakeBin, "git");
  await writeFile(gitExecutable, gitWrapper);
  await chmod(gitExecutable, 0o700);
}

function pullRequest(number, title, draft, updatedAt) {
  return {
    number, title, state: "OPEN", isDraft: draft, baseRefName: "main", headRefName: "review/42",
    headRepository: { nameWithOwner: "acme/widget" }, updatedAt, mergeable: "MERGEABLE",
    reviewDecision: number === 42 ? "APPROVED" : "REVIEW_REQUIRED",
    commits: { nodes: [{ commit: { statusCheckRollup: { state: number === 42 ? "SUCCESS" : "PENDING" } } }] },
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("exit", (code) => { if (code && !child.killed) evidence.failures.push(`server exited ${code}: ${stderr}`); });
  await readRecord(child.pid);
  return child;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function readRecord(pid) {
  return waitUntil(async () => {
    const record = await readFile(runtimeFile, "utf8").then(JSON.parse).catch(() => undefined);
    return record?.pid === pid ? record : undefined;
  }, 8_000, `runtime discovery did not appear for pid ${pid}`);
}

async function controlCall(record, method, params = {}) {
  const response = await rawControlCall(record, record.token, method, params);
  if (response.ok) return response.result;
  throw new Error(`${method}: ${response.error?.code ?? "failed"}: ${response.error?.message ?? "failed"}`);
}

async function rawControlCall(record, token, method, params = {}) {
  const socket = new WebSocket(record.controlUrl);
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 15_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token, method, params })));
    socket.once("message", (raw) => { clearTimeout(timeout); socket.close(); resolve(JSON.parse(String(raw))); });
    socket.once("error", reject);
  });
}

async function subscribe(record, projectId) {
  const socket = new WebSocket(record.controlUrl);
  const id = randomUUID();
  const events = [];
  await new Promise((resolve, reject) => {
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.token, method: "control.subscribe", params: { topics: ["gitHost"], projectIds: [projectId] } })));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id === id) message.ok ? resolve() : reject(new Error(message.error?.message));
      else if (message.event === "projection.invalidated") events.push(message.payload);
    });
    socket.once("error", reject);
  });
  return {
    close: () => socket.close(),
    next: () => waitUntil(() => events.shift(), 4_000, "Git-host invalidation not observed"),
  };
}

async function waitUntil(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function invocationCount(file) {
  const contents = await readFile(file, "utf8").catch(() => "");
  return contents.split("\n").filter(Boolean).length;
}

function renderReport(result) {
  const checks = Object.entries(result.checks).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"}: \`${name}\``).join("\n");
  const skipped = Object.entries(result.skipped).map(([name, reason]) => `- \`${name}\`: ${reason}`).join("\n");
  return `# F3 GitHub PR Projection — Single-Task Smoke Evidence\n\nThis artifact is a narrow deterministic smoke, not the F3 packet exit matrix.\n\nStatus: **${result.status}**\nCaptured: ${result.capturedAt}\nHost: ${result.host.platform}/${result.host.arch} (${result.host.release})\n\n## Deterministic checks\n\n${checks}\n\n## Explicit skips\n\n${skipped}\n`;
}

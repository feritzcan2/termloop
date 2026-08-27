import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f3-pr-changes-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const repository = path.join(temporary, "repository");
const fakeBin = path.join(temporary, "bin");
const fixtureDirectory = path.join(temporary, "fixtures");
const apiCountFile = path.join(temporary, "gh-api-count");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f3/pull-request-changes.local.json");
const reportPath = path.join(root, "artifacts/evidence/f3/pull-request-changes.md");
const privatePathMarker = "src/private-fixture-marker.ts";
const privatePatchMarker = "PRIVATE_PATCH_MARKER_8f25";
const evidence = {
  schema: "f3-pull-request-changes-local-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    fullControlOnly: false,
    staleGenerationStartsZeroProcesses: false,
    nonMemberStartsZeroProcesses: false,
    sameKeyListDedup: false,
    bounded257thFile: false,
    lazySelectedFileDiff: false,
    opaqueWireIdentity: false,
    taskTruthUnchanged: false,
    privateContentNotDurableOrEvidence: false,
    taggedSourceAndRendererLru: false,
    structuralProjectionPreservation: false,
    reviewNoteComposition: false,
  },
  skipped: {
    deterministicAzureContent: "fixed Azure command builders, parsers, and suppression scopes have unit fixtures; this process harness uses fake gh and does not exercise the multi-command Azure client flow",
    multipleProviderAndMatchUi: "the tagged source helper is tested, but a shown mixed GitHub/Azure multi-match picker is not measured here",
    patchFailureStateMatrix: "helper fixtures cover binary, non-UTF-8, LFS and oversized states; client-level changed/missing failure paths are not process-measured and this run renders one patch",
    projectFairnessAndTwoJobCap: "the scheduler is structurally bounded; this single-Project process run does not measure two-Project contention",
    corePlanApplyRace: "membership rejection is process-tested and cache bounds are unit-tested; a mid-flight Task branch/projection mutation race is not process-measured here",
    azureCrossProjectContent: "fixed command and parser fixtures cover separate source/target projects; an authenticated cross-Project fork content read remains external",
    shownOverlayInvalidation: "current-membership and LRU helpers are unit-tested; a shown Changes overlay invalidation while a private patch is visible is not measured here",
    logPoisonAbsence: "durable Task, provider cache and evidence bytes are checked; a captured production-log sink is not available in this harness",
    shownElectronTerminalFocus: "desktop running-window smoke passes separately; no shown PR/terminal capture is claimed",
    liveGitHubAndAzure: "requires named authenticated disposable public/private repositories",
    liveForkRenameLargeBinaryLfs: "requires named provider fixtures and remains an external gate",
    liveApiOrderingEncoding: "GitHub REST ordering and Azure iteration/item encoding remain external compatibility gates",
    threeOsAuthAndRecovery: "this report covers only the current host with deterministic fake provider processes",
    proxyCaOffline: "requires named external network fixtures",
  },
  failures: [],
};

let server;
try {
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
    mkdir(repository, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(fixtureDirectory, { recursive: true }),
    mkdir(path.dirname(evidencePath), { recursive: true }),
  ]);
  initializeRepository();
  await installFixtures();
  await installFakeGh();
  execFileSync("pnpm", ["--filter", "@termloop/desktop", "exec", "vitest", "run", "test/change-source.test.ts", "test/task-projection-store.test.ts", "test/changes-review.test.ts"], {
    cwd: root,
    stdio: "pipe",
  });
  evidence.checks.taggedSourceAndRendererLru = true;
  evidence.checks.structuralProjectionPreservation = true;
  evidence.checks.reviewNoteComposition = true;
  server = await startServer();
  const record = await readRecord(server.pid);
  const project = await controlCall(record, "project.create", { name: "F3 changes", folderPath: repository });
  const task = await controlCall(record, "task.create", { projectId: project.id, title: "Projected changes", brief: null, worktreeIntent: "none" });
  await controlCall(record, "task.bindBranch", { taskId: task.id, repositoryPath: repository, branchName: "main" });
  const durableBefore = await readFile(path.join(stateDirectory, "state.v1.json"));
  const [projection] = await controlCall(record, "gitHost.pullRequestList", { projectId: project.id, taskIds: [task.id] });
  const match = projection.matches[0];
  assert.ok(match);
  const identity = {
    provider: match.provider,
    repository_owner: match.repository_owner,
    repository_project: match.repository_project,
    repository_name: match.repository_name,
    number: match.number,
  };
  const listParams = {
    taskId: task.id,
    expectedFreshnessGeneration: projection.freshness_generation,
    pullRequest: identity,
  };

  const deniedCount = await invocationCount(apiCountFile);
  const denied = await rawControlCall(record, record.readOnlyToken, "gitHost.pullRequestChangeList", {
    taskId: task.id,
    expectedFreshnessGeneration: projection.freshness_generation,
    pullRequest: identity,
  });
  assert.equal(denied.ok, false);
  assert.equal(await invocationCount(apiCountFile), deniedCount);
  evidence.checks.fullControlOnly = true;

  const staleCount = await invocationCount(apiCountFile);
  const stale = await controlCall(record, "gitHost.pullRequestChangeList", {
    taskId: task.id,
    expectedFreshnessGeneration: projection.freshness_generation + 1,
    pullRequest: identity,
  });
  assert.equal(stale.state, "unavailable");
  assert.equal(stale.reason, "staleProjection");
  assert.equal(await invocationCount(apiCountFile), staleCount);
  evidence.checks.staleGenerationStartsZeroProcesses = true;

  const nonMemberCount = await invocationCount(apiCountFile);
  const nonMember = await controlCall(record, "gitHost.pullRequestChangeList", {
    ...listParams,
    pullRequest: { ...identity, number: identity.number + 1 },
  });
  assert.equal(nonMember.state, "unavailable");
  assert.equal(nonMember.reason, "staleProjection");
  assert.equal(await invocationCount(apiCountFile), nonMemberCount);
  evidence.checks.nonMemberStartsZeroProcesses = true;

  const beforeList = await invocationCount(apiCountFile);
  const [list, duplicate] = await Promise.all([
    controlCall(record, "gitHost.pullRequestChangeList", listParams),
    controlCall(record, "gitHost.pullRequestChangeList", listParams),
  ]);
  assert.equal(duplicate.state, "available");
  assert.deepEqual(duplicate.entries, list.entries);
  assert.equal(await invocationCount(apiCountFile) - beforeList, 4);
  evidence.checks.sameKeyListDedup = true;
  assert.equal(list.state, "available");
  assert.equal(list.entries.length, 256);
  assert.equal(list.truncated, true);
  assert.equal(list.entries[0].display_path, privatePathMarker);
  assert.match(list.observation_id, /^prc-/);
  evidence.checks.bounded257thFile = true;
  assert.equal(JSON.stringify(list).includes("baseSha"), false);
  assert.equal(JSON.stringify(list).includes("headSha"), false);
  assert.equal(JSON.stringify(list).includes("repos/acme"), false);
  evidence.checks.opaqueWireIdentity = true;

  const beforeDiff = await invocationCount(apiCountFile);
  const diff = await controlCall(record, "gitHost.pullRequestDiff", {
    taskId: task.id,
    observationId: list.observation_id,
    entryId: list.entries[0].entry_id,
  });
  assert.equal(await invocationCount(apiCountFile) - beforeDiff, 2);
  assert.equal(diff.state, "patch");
  assert.ok(diff.patch.includes(privatePatchMarker));
  assert.ok(diff.patch.length < 256 * 1024);
  evidence.checks.lazySelectedFileDiff = true;

  assert.deepEqual(await readFile(path.join(stateDirectory, "state.v1.json")), durableBefore);
  evidence.checks.taskTruthUnchanged = true;
  const cache = await readFile(path.join(stateDirectory, "provider-cache.v1.json"), "utf8").catch(() => "");
  assert.equal(cache.includes(privatePathMarker), false);
  assert.equal(cache.includes(privatePatchMarker), false);
  evidence.checks.privateContentNotDurableOrEvidence = true;
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  evidence.failures.push(detail
    .replaceAll(privatePathMarker, "<redacted-path-marker>")
    .replaceAll(privatePatchMarker, "<redacted-patch-marker>"));
} finally {
  if (server) await stopServer(server).catch(() => undefined);
  evidence.status = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0
    ? "PASS_LOCAL_WITH_SKIPS"
    : "FAIL";
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  assert.equal(encoded.includes(privatePathMarker), false);
  assert.equal(encoded.includes(privatePatchMarker), false);
  await writeFile(evidencePath, encoded);
  await writeFile(reportPath, renderReport(evidence));
  await rm(temporary, { recursive: true, force: true });
}
assert.notEqual(evidence.status, "FAIL", evidence.failures.join("\n"));
console.log(`F3 pull request changes acceptance: ${evidence.status}`);

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

async function installFixtures() {
  const summary = {
    data: {
      q0: {
        isFork: false,
        pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{
          number: 42, title: "Private fixture PR", state: "OPEN", isDraft: false,
          baseRefName: "main", headRefName: "review/42", headRepository: { nameWithOwner: "acme/widget" },
          updatedAt: "2026-08-12T10:00:00Z", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
        }] },
        parent: null,
      },
      rateLimit: { remaining: 4999, resetAt: "2026-08-12T11:00:00Z" },
    },
  };
  await writeFile(path.join(fixtureDirectory, "summary.json"), JSON.stringify(summary));
  await writeFile(path.join(fixtureDirectory, "metadata.json"), JSON.stringify({
    number: 42, owner: "acme", repository: "widget",
    baseSha: "1111111111111111111111111111111111111111",
    headSha: "2222222222222222222222222222222222222222",
  }));
  for (let page = 1; page <= 3; page += 1) {
    const count = page < 3 ? 100 : 57;
    const start = (page - 1) * 100;
    const rows = Array.from({ length: count }, (_, offset) => {
      const ordinal = start + offset;
      return {
        filename: ordinal === 0 ? privatePathMarker : `src/file-${ordinal}.ts`,
        status: "modified",
        sha: String(ordinal + 1).padStart(40, "a").slice(-40),
      };
    });
    await writeFile(path.join(fixtureDirectory, `page-${page}.json`), JSON.stringify(rows));
  }
  await writeFile(path.join(fixtureDirectory, "diff.json"), JSON.stringify([{
    filename: privatePathMarker,
    status: "modified",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    patch: `@@ -1 +1 @@\n-old\n+${privatePatchMarker}`,
  }]));
}

async function installFakeGh() {
  if (process.platform === "win32") throw new Error("deterministic fake gh fixture is not implemented for Windows");
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version fixture"; exit 0; fi
printf '1\\n' >> ${shellQuote(apiCountFile)}
case "$*" in
  "api --hostname github.com graphql --input -") cat >/dev/null; cat ${shellQuote(path.join(fixtureDirectory, "summary.json"))} ;;
  *"repos/acme/widget/pulls/42/files"*"per_page=100"*"page=1"*) cat ${shellQuote(path.join(fixtureDirectory, "page-1.json"))} ;;
  *"repos/acme/widget/pulls/42/files"*"per_page=100"*"page=2"*) cat ${shellQuote(path.join(fixtureDirectory, "page-2.json"))} ;;
  *"repos/acme/widget/pulls/42/files"*"per_page=100"*"page=3"*) cat ${shellQuote(path.join(fixtureDirectory, "page-3.json"))} ;;
  *"repos/acme/widget/pulls/42/files"*"per_page=1"*"page=1"*) cat ${shellQuote(path.join(fixtureDirectory, "diff.json"))} ;;
  *"repos/acme/widget/pulls/42"*) cat ${shellQuote(path.join(fixtureDirectory, "metadata.json"))} ;;
  *) echo "FAKE_PROVIDER_SECRET unexpected argv" >&2; exit 2 ;;
esac
`;
  const executable = path.join(fakeBin, "gh");
  await writeFile(executable, script);
  await chmod(executable, 0o700);
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
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);
  child.once("exit", (code) => { if (code && !child.killed) evidence.failures.push(`server exited ${code}; diagnostics omitted`); });
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
  return `# F3 Pull Request Changes — Local Evidence\n\nStatus: **${result.status}**\nCaptured: ${result.capturedAt}\nHost: ${result.host.platform}/${result.host.arch} (${result.host.release})\n\n## Deterministic checks\n\n${checks}\n\n## Explicit skips\n\n${skipped}\n`;
}

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f3-azure-pr-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const repository = path.join(temporary, "repository");
const worktree = path.join(temporary, "task-worktree");
const fakeBin = path.join(temporary, "bin");
const modeFile = path.join(temporary, "az-mode");
const queryCountFile = path.join(temporary, "az-query-count");
const queryArgvFile = path.join(temporary, "az-query-argv");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f3/azure-devops-pr.local.json");
const reportPath = path.join(root, "artifacts/evidence/f3/azure-devops-pr.local.md");
const evidence = {
  schema: "f3-azure-devops-pr-single-task-smoke-v2",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    officialHttpsRemote: false, fixedAzCommandAndEnvironment: false, multipleMatchesRemainList: false,
    providerDiscriminator: false, concurrentBatchDedup: false, taskTruthUnchanged: false,
    privateDisposableCache: false, cacheWipeRebuilds: false, rawProviderFailureRedacted: false,
    worktreeBranchDiscovery: false,
    progressiveFirstWave: false, branchFamilyDiscovery: false,
  },
  skipped: {
    liveAzureDevOps: "requires a named Azure DevOps organization/project and authenticated az CLI",
    azureCliLoginModes: "neither az login nor az devops login secure-storage behavior is exercised by fake az",
    windowsLinuxRuntime: process.platform === "darwin" ? "local runtime evidence is macOS only" : "local host only",
    tenTaskTargetedProcessBudget: "single-Task smoke; ten-alias process counts and fairness are not measured here",
    emptyForkMetadataFallback: "exact non-fork/fork/partial metadata parsing is covered by provider fixtures, not this process smoke",
    partialAliasTimeoutIsolation: "completed-sibling preservation is covered by a server unit fixture, not this process smoke",
    projectAuthorizationIsolation: "provider unit behavior is not repeated with live project ACLs",
    branchResult17Truncation: "covered by provider unit fixture, not this process smoke",
    incompleteDeletedSource: "covered by provider unit fixture, not this process smoke",
    mixedGitHubAzureCandidates: "covered by contract/core fixtures; one Git remote cannot prove both providers here",
    timeoutProcessTreeReaping: "platform/provider unit fixtures only",
    daemonKillOrphanReconciliation: "destructive daemon kill not exercised",
    idleSixtyFiveSeconds: "not measured",
    shownElectronUi: "desktop running-window smoke and unit tests run separately; no visual capture claimed",
    realRateLimitOfflineProxy: "requires external network fixtures",
    azureDevOpsServerCustomCloud: "out of scope",
  }, failures: [],
};
let server;
try {
  await Promise.all([runtimeDirectory, stateDirectory, repository, fakeBin, path.dirname(evidencePath)].map((p) => mkdir(p, { recursive: true })));
  initializeRepository();
  await installFakeAz();
  await writeFile(modeFile, "success");
  server = await startServer();
  let record = await readRecord(server.pid);
  const project = await call(record, "project.create", { name: "Azure F3", folderPath: repository });
  const task = await call(record, "task.create", { projectId: project.id, title: "Azure projected", brief: null, worktreeIntent: "none" });
  await call(record, "task.provisionWorktree", {
    operationId: randomUUID(), taskId: task.id, repositoryPath: repository,
    destinationPath: worktree, branchName: "termloop/generated", branchMode: "existing",
  });
  gitAt(worktree, ["switch", "-c", "UKIE-803"]);
  gitAt(worktree, ["switch", "-c", "UKIE-804"]);
  gitAt(repository, ["branch", "feature/UKIE-804-MASTER"]);
  const stateBefore = await readFile(path.join(stateDirectory, "state.v1.json"));
  const [one, two] = await Promise.all([
    call(record, "gitHost.pullRequestList", { projectId: project.id, taskIds: [task.id] }, record.readOnlyToken),
    call(record, "gitHost.pullRequestList", { projectId: project.id, taskIds: [task.id] }, record.readOnlyToken),
  ]);
  assert.deepEqual(two, one);
  assert.equal(await invocationCount(queryCountFile), 1);
  assert.deepEqual(
    one[0].matches.map((match) => match.number),
    [13707],
    JSON.stringify({ projection: one[0], queried: await readFile(queryCountFile, "utf8") }),
  );
  evidence.checks.progressiveFirstWave = true;
  const queryArgv = (await readFile(queryArgvFile, "utf8")).trim().split("\n");
  assert.deepEqual(queryArgv.slice(0, 3), ["repos", "pr", "list"]);
  assert.equal(argumentValue(queryArgv, "--organization"), "https://dev.azure.com/fiber-teams");
  assert.equal(argumentValue(queryArgv, "--project"), "Fiber Tests");
  assert.equal(argumentValue(queryArgv, "--source-branch"), "UKIE-804");
  assert.equal(argumentValue(queryArgv, "--status"), "all");
  assert.equal(argumentValue(queryArgv, "--top"), "17");
  assert.equal(queryArgv.includes("--repository"), false);
  evidence.checks.concurrentBatchDedup = true;
  let projection = one[0];
  for (let wave = 0; wave < 3; wave += 1) {
    [projection] = await call(record, "gitHost.pullRequestList", { projectId: project.id, taskIds: [task.id] }, record.readOnlyToken);
  }
  assert.deepEqual(
    (await readFile(queryCountFile, "utf8")).trim().split("\n"),
    ["UKIE-804", "feature/UKIE-804-MASTER", "termloop/generated", "UKIE-803"],
  );
  assert.equal(projection.freshness, "fresh");
  assert.equal(projection.reason, null);
  assert.equal(projection.repository_provider, "azureDevOps");
  assert.equal(projection.repository_host, "dev.azure.com");
  assert.equal(projection.repository_project, "Fiber Tests");
  assert.equal(projection.matches.length, 4);
  assert.deepEqual(projection.matches.map((match) => match.number), [13709, 13707, 13705, 13706]);
  assert.deepEqual(projection.matches.map((match) => match.head_branch), ["feature/UKIE-804-MASTER", "UKIE-804", "termloop/generated", "UKIE-803"]);
  assert.equal(projection.branch_name, "termloop/generated");
  assert.ok(projection.matches.every((match) => match.provider === "azureDevOps" && match.host === "dev.azure.com"));
  const cached = await call(record, "gitHost.pullRequestList", { projectId: project.id, taskIds: [task.id] }, record.readOnlyToken);
  assert.deepEqual(cached[0], projection);
  assert.equal(await invocationCount(queryCountFile), 4);
  evidence.checks.officialHttpsRemote = true;
  evidence.checks.fixedAzCommandAndEnvironment = true;
  evidence.checks.multipleMatchesRemainList = true;
  evidence.checks.providerDiscriminator = true;
  evidence.checks.worktreeBranchDiscovery = true;
  evidence.checks.branchFamilyDiscovery = true;
  assert.deepEqual(await readFile(path.join(stateDirectory, "state.v1.json")), stateBefore);
  evidence.checks.taskTruthUnchanged = true;
  const cachePath = path.join(stateDirectory, "provider-cache.v1.json");
  await waitUntil(async () => (await readFile(cachePath, "utf8").catch(() => "")).includes("Private Azure fixture PR"), 4000, "Azure cache did not flush");
  if (process.platform !== "win32") assert.equal((await stat(cachePath)).mode & 0o077, 0);
  evidence.checks.privateDisposableCache = true;
  await stopServer(server); server = undefined;
  await rm(cachePath, { force: true });
  await writeFile(modeFile, "failure");
  server = await startServer(); record = await readRecord(server.pid);
  const degraded = await call(record, "gitHost.pullRequestList", { projectId: project.id, taskIds: [task.id] });
  assert.equal(degraded[0].freshness, "unavailable");
  assert.equal(JSON.stringify(degraded).includes("SUPERSECRET_AZURE_DIAGNOSTIC"), false);
  assert.equal((await readFile(path.join(stateDirectory, "state.v1.json"), "utf8")).includes("SUPERSECRET_AZURE_DIAGNOSTIC"), false);
  evidence.checks.cacheWipeRebuilds = true;
  evidence.checks.rawProviderFailureRedacted = true;
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (server) await stopServer(server).catch(() => undefined);
  evidence.status = Object.values(evidence.checks).every(Boolean) && evidence.failures.length === 0 ? "PASS_SINGLE_TASK_SMOKE_WITH_SKIPS" : "FAIL";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(reportPath, renderReport(evidence));
  await rm(temporary, { recursive: true, force: true });
}
assert.notEqual(evidence.status, "FAIL", evidence.failures.join("\n"));
console.log(`F3 Azure DevOps PR acceptance: ${evidence.status}`);

function initializeRepository() {
  git(["init", "--initial-branch=main"]); git(["config", "user.name", "TermLoop Test"]); git(["config", "user.email", "test@termloop.invalid"]); git(["commit", "--allow-empty", "-m", "fixture"]);
  git(["branch", "termloop/generated"]);
  git(["remote", "add", "origin", "https://fiber-teams@dev.azure.com/fiber-teams/Fiber%20Tests/_git/Widget"]);
}
function git(args) { execFileSync("git", args, { cwd: repository, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } }); }
function gitAt(cwd, args) { execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } }); }
async function installFakeAz() {
  if (process.platform === "win32") throw new Error("fake az fixture is not implemented for Windows");
  const ukie804 = [azurePr(13707, "Private Azure fixture PR", 10, "UKIE-804")];
  const master = [azurePr(13709, "Temporary worktree branch PR", 10, "feature/UKIE-804-MASTER")];
  const ukie803 = [azurePr(13706, "Historical worktree branch PR", 0, "UKIE-803")];
  const generated = [azurePr(13705, "Durable Task branch PR", 10, "termloop/generated")];
  const script = `#!/bin/sh\nif [ -n "$AZURE_DEVOPS_EXT_PAT" ]; then echo SUPERSECRET_AZURE_DIAGNOSTIC_PAT >&2; exit 2; fi\nif [ "$AZURE_EXTENSION_USE_DYNAMIC_INSTALL" != no ]; then echo SUPERSECRET_AZURE_DIAGNOSTIC_ENV >&2; exit 2; fi\ncase "$1 $2" in\n  "version --output") printf '{}\\n'; exit 0;;\n  "extension show") printf '{"name":"azure-devops"}\\n'; exit 0;;\n  "cloud show") printf 'AzureCloud\\n'; exit 0;;\nesac\nif [ "$1 $2 $3" != "repos pr list" ]; then echo SUPERSECRET_AZURE_DIAGNOSTIC_ARGV >&2; exit 2; fi\nprevious=\nsource_branch=\nfor argument in "$@"; do\n  if [ "$previous" = "--source-branch" ]; then source_branch="$argument"; fi\n  previous="$argument"\ndone\nprintf '%s\\n' "$source_branch" >> ${shellQuote(queryCountFile)}\nprintf '%s\\n' "$@" > ${shellQuote(queryArgvFile)}\nif [ "$(cat ${shellQuote(modeFile)})" = failure ]; then echo SUPERSECRET_AZURE_DIAGNOSTIC provider exploded >&2; exit 2; fi\ncase "$source_branch" in\n  UKIE-804) printf '%s\\n' ${shellQuote(JSON.stringify(ukie804))};;\n  feature/UKIE-804-MASTER) printf '%s\\n' ${shellQuote(JSON.stringify(master))};;\n  UKIE-803) printf '%s\\n' ${shellQuote(JSON.stringify(ukie803))};;\n  termloop/generated) printf '%s\\n' ${shellQuote(JSON.stringify(generated))};;\n  *) printf '[]\\n';;\nesac\n`;
  const executable = path.join(fakeBin, "az"); await writeFile(executable, script); await chmod(executable, 0o700);
}
function azurePr(number, title, vote, branch) { const day = String(branch === "feature/UKIE-804-MASTER" ? 10 : branch === "UKIE-804" ? 9 : branch === "termloop/generated" ? 8 : 7).padStart(2, "0"); return { pullRequestId: number, title, status: "active", isDraft: false, sourceRefName: `refs/heads/${branch}`, targetRefName: "refs/heads/main", mergeStatus: "succeeded", creationDate: `2026-08-${day}T10:00:00+00:00`, closedDate: null, sourceCommitDate: `2026-08-${day}T11:00:00+00:00`, repository: { name: "Widget", project: "Fiber Tests" }, forkSource: { repository: { name: null, project: null } }, reviewers: [{ vote, isRequired: true }] }; }
function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
async function startServer() { const child = spawn(serverBinary, [], { cwd: root, env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`, AZURE_DEVOPS_EXT_PAT: "POISON", TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory }, stdio: ["ignore", "pipe", "pipe"] }); let stderr=""; child.stderr.on("data", c => { stderr += String(c); }); child.once("exit", code => { if (code && !child.killed) evidence.failures.push(`server exited ${code}: ${stderr}`); }); await readRecord(child.pid); return child; }
async function stopServer(child) { if (child.exitCode !== null) return; child.kill("SIGINT"); await new Promise(resolve => child.once("exit", resolve)); }
async function readRecord(pid) { return waitUntil(async () => { const record = await readFile(runtimeFile, "utf8").then(JSON.parse).catch(() => undefined); return record?.pid === pid ? record : undefined; }, 8000, `runtime discovery missing for ${pid}`); }
async function call(record, method, params={}, token=record.token) { const response = await rawCall(record, token, method, params); if (!response.ok) throw new Error(`${method}: ${response.error?.code}: ${response.error?.message}`); return response.result; }
async function rawCall(record, token, method, params) { const socket = new WebSocket(record.controlUrl); const id=randomUUID(); return new Promise((resolve,reject) => { const timeout=setTimeout(() => {socket.close();reject(new Error(`${method} timed out`));},15000); socket.once("open",()=>socket.send(JSON.stringify({id,protocolVersion:record.protocolVersion,token,method,params}))); socket.once("message",raw=>{clearTimeout(timeout);socket.close();resolve(JSON.parse(String(raw)));}); socket.once("error",reject); }); }
async function invocationCount(file) { return (await readFile(file,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).length; }
function argumentValue(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }
async function waitUntil(fn, timeout, message) { const end=Date.now()+timeout; while(Date.now()<end){ const value=await fn(); if(value)return value; await new Promise(r=>setTimeout(r,25)); } throw new Error(message); }

function renderReport(value) {
  const checks = Object.entries(value.checks).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"}: \`${name}\``).join("\n");
  const skips = Object.entries(value.skipped).map(([name, reason]) => `- \`${name}\`: ${reason}`).join("\n");
  return `# F3 Azure DevOps PR Projection — Single-Task Smoke Evidence\n\nThis artifact is a narrow deterministic fake-\`az\` smoke, not the Azure packet exit matrix.\n\nStatus: **${value.status}**\nCaptured: ${value.capturedAt}\nHost: ${value.host.platform}/${value.host.arch} (${value.host.release})\n\n## Deterministic checks\n\n${checks}\n\n## Explicit skips\n\n${skips}\n`;
}

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

if (process.platform === "win32") {
  console.log("PLAYBOOK_EVALUATION_SKIPPED: POSIX deterministic provider fixture; Windows unmeasured");
  process.exit(0);
}
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-playbook-evaluation-"));
const repository = path.join(temporary, "repository");
const runtimeDirectory = path.join(temporary, "runtime");
const evidenceDirectory = path.join(temporary, "evidence");
const home = path.join(temporary, "home");
const bin = path.join(home, ".local", "bin");
const worktree = path.join(temporary, "task");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
await Promise.all([repository, runtimeDirectory, evidenceDirectory, bin].map((directory) => mkdir(directory, { recursive: true })));
const reportStatus = process.argv.includes("--pending") ? "pending" : "satisfied";
const report = { status: reportStatus, evidence: reportStatus === "pending"
  ? "Fixture inspected current Task evidence; no human approval found."
  : "Fixture verified exact Task and scoped native fork." };
await writeFile(path.join(evidenceDirectory, "report.json"), JSON.stringify(report));
await writeFile(path.join(bin, "claude"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("tests/e2e/playbook-evaluation/fake-agent.mjs"))} ${quote(evidenceDirectory)} "$@"\n`);
await chmod(path.join(bin, "claude"), 0o755);
await writeFile(path.join(bin, "codex"), "#!/bin/sh\nexit 1\n");
await chmod(path.join(bin, "codex"), 0o755);
function git(args) { execFileSync("git", args, { cwd: repository, stdio: "pipe" }); }
git(["init", "--initial-branch=main"]);
git(["-c", "user.name=Fixture", "-c", "user.email=fixture@termloop.invalid", "commit", "--allow-empty", "-m", "fixture"]);
git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
const server = spawn(path.resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug", "termloop-server"), [], {
  env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: path.join(temporary, "state") },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
server.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-8_000); });
async function json(file) { return JSON.parse(await readFile(file, "utf8")); }
async function wait(probe, message) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const error = await json(path.join(evidenceDirectory, "error.json")).catch(() => null);
    if (error) throw new Error(`Fake provider: ${error.message}`);
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message}\n${stderr}`);
}
let record;
let project;
async function call(method, params = {}) {
  const socket = new WebSocket(record.controlUrl);
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 15_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token: record.token, method, params })));
    socket.on("message", (data) => {
      const response = JSON.parse(String(data));
      if (response.id !== id) return;
      clearTimeout(timeout); socket.close();
      if (response.ok) resolve(response.result); else reject(new Error(`${method}: ${JSON.stringify(response.error)}`));
    });
    socket.once("error", reject);
  });
}
try {
  record = await wait(() => json(path.join(runtimeDirectory, "runtime.json")).catch(() => null), "Daemon did not start");
  project = await call("project.create", { name: "Evaluation", folderPath: repository });
  const task = await call("task.create", { projectId: project.id, title: "Evaluate my task", worktreeIntent: "none", worktreePrefix: null, baseRef: null, agentId: null, model: null, permission: null, reasoning: null, kickoffMessage: null });
  await call("task.provisionWorktree", { operationId: crypto.randomUUID(), taskId: task.id, repositoryPath: repository,
    destinationPath: worktree, branchName: "task/evaluation", branchMode: "create", baseRef: "refs/remotes/origin/main" });
  const params = { taskId: task.id, agentId: "claude" };
  const preview = await call("task.previewAgent", params);
  const source = await call("task.launchAgent", { ...params, launchTicket: preview.launch_ticket });
  await wait(() => json(path.join(evidenceDirectory, "source.json")).catch(() => null), "Source Agent did not initialize");
  let configuration = await call("steward.configurationGet", { projectId: project.id });
  await call("steward.configurationSet", { projectId: project.id, agentId: "claude", model: "default", permission: "bypassPermissions", reasoning: "default", enabled: false, systemPrompt: "", expectedRevision: configuration.stateRevision });
  const playbook = await call("playbook.get", { projectId: project.id });
  await call("playbook.update", { projectId: project.id, activePipelineName: "Delivery", milestones: [{ id: "verified", title: "Verified", gate: "automatic",
    completeWhen: "Verify the exact Task with current evidence.", whileWaiting: { mode: "off", instructions: "" }, retryDelaySeconds: 60, approver: null }],
    savedPipelines: [], expectedPlaybookRevision: 0, expectedRevision: playbook.stateRevision });
  const evaluated = await wait(() => json(path.join(evidenceDirectory, "evaluation.json")).catch(() => null), "Evaluation fork did not run");
  assert.equal(evaluated.taskId, task.id);
  assert.equal(evaluated.sourceSessionId, source.id);
  const checking = await wait(async () => {
    const result = await call("playbook.runtime", { projectId: project.id });
    return result.evaluation?.mode === "taskAgentFork" ? result.evaluation : null;
  }, "Confirmed evaluation terminal was not projected");
  assert.equal(checking.sessionId, evaluated.sessionId);
  assert.equal(checking.sourceSessionId, source.id);
  assert.equal(checking.taskId, task.id);
  await writeFile(path.join(evidenceDirectory, "inspection-complete"), "ok");
  const completed = await wait(async () => {
    const result = await call("playbook.runtime", { projectId: project.id });
    const verdict = reportStatus === "pending" ? "waiting" : "passed";
    return result.steps?.[0]?.progress?.some((row) => row.taskId === task.id && row.verdict === verdict) ? result : null;
  }, "Corrected fork verdict was not recorded");
  assert.ok(completed);
  assert.equal(completed.evaluation, null);
  assert.equal(completed.steps[0].progress.find((row) => row.taskId === task.id).evidence, report.evidence);
  assert.equal(completed.doneTaskIds.includes(task.id), reportStatus === "satisfied");
  await wait(async () => {
    const sessions = await call("session.list");
    assert.equal(sessions.find((session) => session.id === source.id)?.lifecycle_state, "running");
    return !sessions.some((session) => session.id === evaluated.sessionId);
  }, "Temporary evaluator was not retired");
  console.log(`PLAYBOOK_EVALUATION_OK: native Task fork, scoped tools, preserved source, rejected oversize reports, corrected ${reportStatus} verdict, temporary Session cleanup`);
} catch (error) {
  console.error(JSON.stringify({
    sessions: await call("session.list").catch(() => []),
    playbook: project ? await call("playbook.runtime", { projectId: project.id }).catch(() => null) : null,
    steward: await json(path.join(evidenceDirectory, "steward.json")).catch(() => null),
  }));
  throw error;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => { server.once("exit", resolve); setTimeout(resolve, 3_000); });
  await rm(temporary, { recursive: true, force: true });
}

// Files acceptance over an isolated real daemon, including managed Task roots.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-files-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const worktreeDirectory = path.join(temporary, "worktree");
const binary = path.resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug",
  process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
let server;
let record;
let serverError;
let serverStderr = "";
let checks = 0;

try {
  await Promise.all([runtimeDirectory, stateDirectory, projectDirectory].map((dir) => mkdir(dir, { recursive: true })));
  git("init", "--initial-branch=main");
  await writeFile(path.join(projectDirectory, "sample.txt"), "committed version\n");
  await writeFile(path.join(projectDirectory, ".gitignore"), "ignored/\n");
  git("add", ".");
  git("commit", "-m", "Files acceptance fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  server = spawn(binary, [], {
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.once("error", (error) => { serverError = error; });
  server.stderr.on("data", (chunk) => { serverStderr = (serverStderr + String(chunk)).slice(-6000); });
  record = await readRecord();
  const project = await call("project.create", { name: "Files acceptance", folderPath: projectDirectory });
  const other = await call("project.create", { name: "Other", folderPath: temporary });
  const params = { projectId: project.id, taskId: null, path: "" };
  const task = await call("task.create", {
    projectId: project.id, title: "Files Task", worktreeIntent: "none", worktreePrefix: null,
    baseRef: null, agentId: null, model: null, permission: null, reasoning: null, kickoffMessage: null,
  });
  await denied("workspace.directoryList", { ...params, taskId: task.id }, "conflict");
  await call("task.provisionWorktree", {
    operationId: crypto.randomUUID(), taskId: task.id, repositoryPath: projectDirectory,
    destinationPath: worktreeDirectory, branchName: "feature/files", branchMode: "create",
    baseRef: "refs/remotes/origin/main",
  });
  await mkdir(path.join(projectDirectory, "ignored"));
  await writeFile(path.join(projectDirectory, "ignored", "untracked.txt"), "ignored file\n");
  await writeFile(path.join(projectDirectory, ".hidden"), "hidden file\n");
  await writeFile(path.join(projectDirectory, "sample.txt"), "PROJECT_CURRENT_CONTENT\n");
  await writeFile(path.join(worktreeDirectory, "sample.txt"), "TASK_CURRENT_CONTENT\n");
  await writeFile(path.join(projectDirectory, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(projectDirectory, "large"), "x".repeat(262145));

  const before = await readFile(path.join(stateDirectory, "state.v1.json"), "utf8");
  const listing = await call("workspace.directoryList", params);
  assert.equal(listing.path, "");
  assert.equal(listing.truncated, false);
  assert.equal(listing.entries[0].name, "ignored", "directories sort first");
  assert.ok(listing.entries.some((entry) => entry.name === ".hidden"));
  assert.ok(!listing.entries.some((entry) => entry.name === ".git"));
  assert.ok(!listing.entries.some((entry) => entry.path.includes("/")), "root listing is shallow");
  checks += 6;
  const nested = await call("workspace.directoryList", { ...params, path: "ignored" });
  assert.deepEqual(nested.entries, [{ name: "untracked.txt", path: "ignored/untracked.txt", kind: "file" }]);
  checks++;
  const taskListing = await call("workspace.directoryList", { ...params, taskId: task.id });
  assert.ok(!taskListing.entries.some((entry) => entry.name === ".git"), "linked worktree gitfile is hidden");
  checks++;
  const [projectRead, taskRead] = await Promise.all([
    call("workspace.fileRead", { ...params, path: "sample.txt" }),
    call("workspace.fileRead", { ...params, taskId: task.id, path: "sample.txt" }),
  ]);
  assert.deepEqual(projectRead, { path: "sample.txt", state: "text", content: "PROJECT_CURRENT_CONTENT\n" });
  assert.deepEqual(taskRead, { path: "sample.txt", state: "text", content: "TASK_CURRENT_CONTENT\n" });
  checks += 2;
  for (const [file, expected] of [["binary", "binary"], ["large", "tooLarge"]]) {
    assert.deepEqual(await call("workspace.fileRead", { ...params, path: file }), { path: file, state: expected, content: null });
    checks++;
  }
  for (const method of ["workspace.directoryList", "workspace.fileRead"]) {
    await denied(method, { ...params, path: "../outside" }, "invalidMessage");
    await denied(method, { ...params, projectId: other.id, taskId: task.id }, "notFound");
    assert.ok(record.readOnlyToken, "fixture must expose the read-only credential");
    await denied(method, params, "capabilityDenied", record.readOnlyToken);
  }
  await mkdir(path.join(projectDirectory, "many"));
  await Promise.all(Array.from({ length: 2010 }, (_, i) => writeFile(path.join(projectDirectory, "many", `Subscription-${String(i).padStart(4, "0")}.cs`), "")));
  const firstPage = await call("workspace.directoryList", { ...params, path: "many" });
  const secondPage = await call("workspace.directoryList", { ...params, path: "many", afterName: firstPage.next_name });
  assert.equal(firstPage.entries.length, 2000);
  assert.equal(secondPage.entries.length, 10);
  assert.equal(secondPage.truncated, false);
  assert.equal(new Set([...firstPage.entries, ...secondPage.entries].map((entry) => entry.path)).size, 2010);
  await denied("workspace.directoryList", { ...params, afterName: "../escape" }, "invalidMessage");
  checks += 4;
  const after = await readFile(path.join(stateDirectory, "state.v1.json"), "utf8");
  assert.equal(after, before, "file observations never mutate the durable store");
  assert.ok(!after.includes("CURRENT_CONTENT"));
  checks += 2;
  console.log(`FILES_ACCEPTANCE_OK: ${checks} checks (Project/Task roots, lazy listing, current content, refusals, scopes, ephemeral reads)`);
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGINT");
    const force = setTimeout(() => server.kill("SIGKILL"), 8_000);
    try { await exited; } finally { clearTimeout(force); }
  }
  await rm(temporary, { recursive: true, force: true });
}

function git(...args) {
  execFileSync("git", args, {
    cwd: projectDirectory, stdio: "pipe", timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: "Files Acceptance", GIT_AUTHOR_EMAIL: "acceptance@termloop.invalid",
      GIT_COMMITTER_NAME: "Files Acceptance", GIT_COMMITTER_EMAIL: "acceptance@termloop.invalid" },
  });
}

async function readRecord() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error(`Fixture daemon exited ${server.exitCode}: ${serverStderr}`);
    try {
      const value = JSON.parse(await readFile(path.join(runtimeDirectory, "runtime.json"), "utf8"));
      if (value.pid === server.pid) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fixture daemon discovery timed out: ${serverStderr}`);
}

async function call(method, params = {}) {
  const response = await rawCall(method, params, record.token);
  assert.equal(response.ok, true, `${method}: ${response.error?.code} ${response.error?.message}`);
  return response.result;
}

async function denied(method, params, code, token = record.token) {
  const response = await rawCall(method, params, token);
  assert.equal(response.ok, false, method);
  assert.equal(response.error?.code, code, method);
  checks++;
}

async function rawCall(method, params, token) {
  const socket = new WebSocket(record.controlUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error(`${method} timed out`)); }, 15_000);
      socket.once("open", () => socket.send(JSON.stringify({ id: crypto.randomUUID(), protocolVersion: record.protocolVersion, token, method, params })));
      socket.once("message", (raw) => { clearTimeout(timeout); resolve(JSON.parse(String(raw))); });
      socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
  } finally { socket.close(); }
}

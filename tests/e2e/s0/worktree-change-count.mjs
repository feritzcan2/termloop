import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// No Project subscription is opened: this reproduces a stale health cache
// independently of filesystem watcher timing and the periodic integrity pass.
export async function verifyWorktreeChangeCount(call, temporary) {
  const repository = path.join(temporary, "change-count-repository");
  const worktree = path.join(temporary, "change-count-worktree");
  const gitHome = path.join(temporary, "change-count-git-home");
  await mkdir(repository);
  await mkdir(gitHome);
  const git = (cwd, ...args) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      HOME: gitHome,
      XDG_CONFIG_HOME: gitHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "TermLoop Acceptance",
      GIT_AUTHOR_EMAIL: "acceptance@termloop.invalid",
      GIT_COMMITTER_NAME: "TermLoop Acceptance",
      GIT_COMMITTER_EMAIL: "acceptance@termloop.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      LC_ALL: "C",
      LANG: "C",
    },
  });
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "core.hooksPath", gitHome);
  const tracked = ["first.txt", "second.txt", "third.txt"];
  for (const name of tracked) await writeFile(path.join(repository, name), "baseline\n");
  git(repository, "add", "--", ...tracked);
  git(repository, "commit", "-m", "baseline");
  git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");

  const project = await call("project.create", { name: "Change count", folderPath: repository });
  const task = await call("task.create", {
    projectId: project.id,
    title: "Refresh a stale change count",
    brief: null,
    worktreeIntent: "none",
    worktreePrefix: null,
    baseRef: null,
    agentId: null,
    model: null,
    permission: null,
    reasoning: null,
    kickoffMessage: null,
  });
  await call("task.provisionWorktree", {
    operationId: crypto.randomUUID(),
    taskId: task.id,
    repositoryPath: repository,
    destinationPath: worktree,
    branchName: "feature/change-count",
    branchMode: "create",
    baseRef: "refs/remotes/origin/main",
  });
  const health = async () => {
    const page = await call("task.list", { projectId: project.id, taskIds: [task.id], archiveScope: "active" });
    return page.items.find((item) => item.id === task.id)?.worktree_health;
  };
  const waitForCount = async (expected) => {
    const deadline = Date.now() + 10_000;
    let latest;
    do {
      latest = await health();
      if (latest?.change_count === expected) return latest;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(latest?.change_count, expected, "reading changes must refresh the cached Task count");
  };

  await writeFile(path.join(worktree, tracked[0]), "first change\n");
  await call("task.inspectWorktreeCleanup", { taskId: task.id });
  const initial = await health();
  assert.equal(initial?.change_count, 1);

  for (const name of tracked.slice(1)) await writeFile(path.join(worktree, name), "changed\n");
  const untracked = ["new-1.txt", "new-2.txt", "new-3.txt", "new-4.txt"];
  for (const name of untracked) await writeFile(path.join(worktree, name), "new\n");
  assert.equal((await health())?.change_count, 1, "fixture must retain the stale one-file observation");
  const index = git(worktree, "rev-parse", "--git-path", "index").trim();
  const indexPath = path.resolve(worktree, index);
  const indexBefore = await readFile(indexPath);
  const changes = await call("task.worktreeChangeList", { taskId: task.id });
  assert.equal(changes.truncated, false);
  assert.equal(changes.entries.length, 7);
  assert.equal(changes.entries.filter((entry) => entry.side === "unstaged").length, 3);
  assert.equal(changes.entries.filter((entry) => entry.side === "untracked").length, 4);
  const refreshed = await waitForCount(7);
  assert.ok(refreshed.observation_sequence > initial.observation_sequence);
  assert.deepEqual(await readFile(indexPath), indexBefore, "review reads must preserve the index");
  await assert.rejects(readFile(`${indexPath}.lock`), { code: "ENOENT" });

  // A file can have two review entries but remains one changed file.
  git(worktree, "restore", "--", ...tracked);
  for (const name of untracked) await rm(path.join(worktree, name));
  await writeFile(path.join(worktree, tracked[0]), "staged\n");
  git(worktree, "add", "--", tracked[0]);
  await writeFile(path.join(worktree, tracked[0]), "unstaged\n");
  const twoSides = await call("task.worktreeChangeList", { taskId: task.id });
  assert.deepEqual(twoSides.entries.map((entry) => entry.side).sort(), ["staged", "unstaged"]);
  await waitForCount(1);

  git(worktree, "restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked);
  const clean = await call("task.worktreeChangeList", { taskId: task.id });
  assert.equal(clean.entries.length, 0);
  await waitForCount(0);
}

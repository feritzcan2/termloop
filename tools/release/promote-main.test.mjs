import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const versionFiles = ["package.json", "clients/desktop/package.json", "clients/cli/package.json", "contract/generated/typescript/package.json"];

async function fixture(t, { tagged = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-promote-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, "repo");
  const remote = path.join(directory, "origin.git");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(directory, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await mkdir(repo);
  execFileSync("git", ["init", "--bare", remote], { env, stdio: "ignore" });
  git("init", "-b", "develop");
  git("config", "user.name", "Promotion test");
  git("config", "user.email", "promotion@example.test");
  git("config", "commit.gpgsign", "false");
  for (const relative of ["RaycastScripts/termloop-promote-main.sh", "RaycastScripts/termloop-release.sh", "tools/release/promotion-version.mjs", "tools/release/set-version.mjs", "tools/release/check-version-sync.mjs", "tools/server/server-release.mjs"]) {
    await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
    await copyFile(path.join(root, relative), path.join(repo, relative));
  }
  for (const relative of versionFiles) {
    await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
    await writeFile(path.join(repo, relative), JSON.stringify({ name: "promotion-fixture", version: "2.0.3" }, null, 2) + "\n");
  }
  await mkdir(path.join(repo, "fixture"));
  await writeFile(path.join(repo, "Cargo.toml"), '[workspace]\nmembers = ["fixture"]\nresolver = "2"\n[workspace.package]\nversion = "2.0.3"\n');
  await writeFile(path.join(repo, "fixture/Cargo.toml"), '[package]\nname = "termloop-promotion-fixture"\nversion.workspace = true\nedition = "2021"\n[lib]\npath = "lib.rs"\n');
  await writeFile(path.join(repo, "fixture/lib.rs"), "");
  execFileSync("cargo", ["generate-lockfile", "--offline"], { cwd: repo, env, stdio: "pipe" });
  git("add", ".");
  git("commit", "-m", "Initial release");
  git("branch", "main");
  if (tagged) git("tag", "v2.0.3");
  git("remote", "add", "origin", remote);
  git("push", "--all", "origin");
  if (tagged) git("push", "--tags", "origin");
  await writeFile(path.join(repo, "feature.txt"), "new feature\n");
  git("add", "feature.txt");
  git("commit", "-m", "Implement feature");
  git("push", "origin", "develop");

  const calls = path.join(directory, "gh-calls.jsonl");
  const fakeGh = path.join(directory, "gh.mjs");
  await writeFile(fakeGh, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const repo = process.env.PROMOTION_TEST_REPO;
const dispatched = process.env.PROMOTION_TEST_CALLS + '.dispatched';
const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'origin/develop'], { encoding: 'utf8' }).trim();
appendFileSync(process.env.PROMOTION_TEST_CALLS, JSON.stringify({ args, sha }) + '\\n');
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'workflow' && args[1] === 'run') { writeFileSync(dispatched, sha); process.exit(0); }
if (args[0] === 'run' && args[1] === 'watch') process.exit(process.env.PROMOTION_TEST_CI === 'failed' ? 1 : 0);
if (args[0] === 'run' && args[1] === 'list') {
  const format = args[args.indexOf('--json') + 1];
  if (format === 'databaseId') process.exit(0);
  if (format === 'databaseId,headSha') { console.log('123'); process.exit(0); }
  const mode = process.env.PROMOTION_TEST_CI;
  if (format === 'databaseId,headSha,event,status,conclusion') { if (mode !== 'failed') console.log('123'); process.exit(0); }
  if (format === 'databaseId,headSha,event,status') { console.log('123'); process.exit(0); }
  const runs = mode === 'dispatch' && !existsSync(dispatched) ? [] : [{ databaseId: 123, headSha: sha, status: 'completed', conclusion: mode === 'failed' ? 'failure' : 'success', url: 'https://example.test/ci/123' }];
  console.log(JSON.stringify(runs)); process.exit(0);
}
throw Error('Unexpected GitHub call: ' + args.join(' '));
`);
  const bashEnv = path.join(directory, "bash-env");
  await writeFile(bashEnv, 'gh() { node "$PROMOTION_TEST_GH" "$@"; }\n');
  const runScript = (script, mode = "success") => spawnSync("/bin/bash", [path.join(repo, "RaycastScripts", script)], {
    cwd: repo, encoding: "utf8", timeout: 30_000,
    env: { ...env, BASH_ENV: bashEnv, TMPDIR: directory + path.sep, TERMLOOP_NO_OPEN: "1", PROMOTION_TEST_GH: fakeGh, PROMOTION_TEST_REPO: repo, PROMOTION_TEST_CALLS: calls, PROMOTION_TEST_CI: mode },
  });
  return { directory, repo, git, run: (mode) => runScript("termloop-promote-main.sh", mode), release: (mode) => runScript("termloop-release.sh", mode), calls: async () => (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse) };
}

test("promote bumps and pushes all versions before CI, then fast-forwards main exactly once", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { tagged: false });
  const original = f.git("rev-parse", "HEAD");
  const result = f.run("dispatch");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const candidate = f.git("rev-parse", "HEAD");
  assert.notEqual(candidate, original);
  for (const relative of versionFiles) assert.equal(JSON.parse(await readFile(path.join(f.repo, relative), "utf8")).version, "2.0.4");
  assert.match(await readFile(path.join(f.repo, "Cargo.lock"), "utf8"), /version = "2.0.4"/);
  assert.equal(f.git("rev-parse", "main"), candidate);
  assert.equal(f.git("rev-parse", "origin/main"), candidate);
  assert.equal(f.git("rev-parse", "origin/develop"), candidate);
  assert.equal(f.git("status", "--porcelain"), "");
  const calls = await f.calls();
  assert.equal(calls.find(({ args }) => args[0] === "workflow")?.sha, candidate);
  assert.ok(calls.every(({ args }) => !args.includes("release.yml")));
  const again = f.run();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), candidate);
});

test("failed CI leaves main unchanged and retry reuses the prepared version", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const main = f.git("rev-parse", "main");
  const failed = f.run("failed");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /failed native CI/);
  const candidate = f.git("rev-parse", "HEAD");
  assert.equal(JSON.parse(await readFile(path.join(f.repo, "package.json"), "utf8")).version, "2.0.4");
  assert.equal(f.git("rev-parse", "main"), main);
  assert.equal(f.git("rev-parse", "origin/main"), main);
  const retried = f.run();
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), candidate);
  assert.equal(f.git("rev-parse", "main"), candidate);
});

test("uncommitted work stops promotion before version writes or CI", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const original = f.git("rev-parse", "HEAD");
  await writeFile(path.join(f.repo, "feature.txt"), "in progress\n");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncommitted work/);
  assert.equal(f.git("rev-parse", "HEAD"), original);
  assert.equal(JSON.parse(await readFile(path.join(f.repo, "package.json"), "utf8")).version, "2.0.3");
  assert.ok((await f.calls()).every(({ args }) => args[0] === "auth"));
});

test("promotion can prepare develop in a temporary worktree without changing a detached checkout", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const original = f.git("rev-parse", "HEAD");
  f.git("switch", "--detach");
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), original);
  assert.equal(JSON.parse(f.git("show", "develop:package.json")).version, "2.0.4");
  assert.equal(f.git("rev-parse", "main"), f.git("rev-parse", "origin/develop"));
  assert.equal(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("Cargo lockfile failure cannot create or publish a version commit", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const manifest = path.join(f.repo, "Cargo.toml");
  await writeFile(manifest, await readFile(manifest, "utf8") + "invalid TOML\n");
  f.git("add", "Cargo.toml");
  f.git("commit", "-m", "Broken manifest fixture");
  f.git("push", "origin", "develop");
  const original = f.git("rev-parse", "HEAD");
  const main = f.git("rev-parse", "main");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cargo lockfile sync failed/);
  assert.equal(f.git("rev-parse", "HEAD"), original);
  assert.equal(f.git("rev-parse", "origin/develop"), original);
  assert.equal(f.git("rev-parse", "origin/main"), main);
  assert.ok((await f.calls()).every(({ args }) => args[0] === "auth"));
});

test("a rejected version push leaves main unchanged and starts no CI", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const original = f.git("rev-parse", "origin/develop");
  const main = f.git("rev-parse", "main");
  await writeFile(path.join(f.directory, "origin.git/hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pre-receive hook declined/);
  assert.notEqual(f.git("rev-parse", "HEAD"), original);
  assert.equal(f.git("rev-parse", "origin/develop"), original);
  assert.equal(f.git("rev-parse", "origin/main"), main);
  assert.ok((await f.calls()).every(({ args }) => args[0] === "auth"));
});

for (const script of ["promote", "release"]) {
  test(`${script} ignores a moving nightly tag and fetches version tags without overwriting them`, { skip: process.platform === "win32" }, async (t) => {
    const f = await fixture(t);
    const localNightly = f.git("rev-parse", "HEAD");
    const published = f.git("rev-parse", "v2.0.3");
    f.git("tag", "nightly", localNightly);
    f.git("push", "origin", "refs/heads/main:refs/tags/nightly", "refs/heads/main:refs/tags/v2.0.7");
    const result = script === "promote" ? f.run() : f.release();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.git("rev-parse", "nightly"), localNightly);
    assert.equal(f.git("ls-remote", "origin", "refs/tags/nightly").split(/\s/)[0], published);
    assert.equal(f.git("rev-parse", "v2.0.3"), published);
    assert.equal(f.git("rev-parse", "v2.0.7"), published);
    if (script === "promote") {
      assert.equal(JSON.parse(f.git("show", "main:package.json")).version, "2.0.8");
    } else {
      assert.match(result.stdout, /Release already completed for exact candidate/);
      assert.ok((await f.calls()).every(({ args }) => args[0] === "auth" || args[0] === "run" && args[1] === "list"));
    }
  });

  test(`${script} still rejects a conflicting stable version tag before publishing anything`, { skip: process.platform === "win32" }, async (t) => {
    const f = await fixture(t);
    const original = f.git("rev-parse", "HEAD");
    const published = f.git("rev-parse", "main");
    f.git("tag", "--force", "v2.0.3", original);
    const result = script === "promote" ? f.run() : f.release();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /would clobber existing tag/);
    assert.equal(f.git("rev-parse", "v2.0.3"), original);
    assert.equal(f.git("ls-remote", "origin", "refs/tags/v2.0.3").split(/\s/)[0], published);
    assert.equal(f.git("rev-parse", "HEAD"), original);
    assert.equal(f.git("rev-parse", "origin/main"), published);
    assert.ok((await f.calls()).every(({ args }) => args[0] === "auth"));
  });
}

test("release publishes the verified main tag without permission to list repository secrets", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { tagged: false });
  const main = f.git("rev-parse", "origin/main");
  const result = f.release();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git("rev-parse", "v2.0.3"), main);
  assert.equal(f.git("ls-remote", "origin", "refs/tags/v2.0.3").split(/\s/)[0], main);
  assert.ok((await f.calls()).every(({ args }) => args[0] !== "secret" && args[0] !== "variable"));
  const ci = (await f.calls()).find(({ args }) => args.includes("ci.yml"));
  assert.equal(ci.args[ci.args.indexOf("--commit") + 1], main);
});

test("release still refuses to create a tag when exact-candidate CI fails", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { tagged: false });
  const result = f.release("failed");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CI did not pass; release was not started/);
  assert.equal(f.git("tag", "--list", "v2.0.3"), "");
  assert.equal(f.git("ls-remote", "origin", "refs/tags/v2.0.3"), "");
  assert.ok((await f.calls()).every(({ args }) => !args.includes("release.yml")));
});

test("promotion removes only the missing main worktree registration and creates a new checkout", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.directory, "missing main");
  const unrelated = path.join(f.directory, "missing unrelated");
  f.git("worktree", "add", missing, "main");
  f.git("worktree", "add", "--detach", unrelated);
  await rm(missing, { recursive: true });
  await rm(unrelated, { recursive: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Removing missing main worktree registration/);
  assert.equal(f.git("rev-parse", "main"), f.git("rev-parse", "origin/develop"));
  const worktrees = f.git("worktree", "list", "--porcelain");
  assert.ok(!worktrees.includes("missing main"));
  assert.ok(worktrees.includes("missing unrelated"));
});

for (const state of ["missing .git", "corrupt index", "dirty", "locked and missing"]) {
  test(`a ${state} main checkout stops before version preparation or CI and preserves local work`, { skip: process.platform === "win32" }, async (t) => {
    const f = await fixture(t);
    const checkout = path.join(f.directory, "existing main");
    f.git("worktree", "add", checkout, "main");
    const original = f.git("rev-parse", "HEAD");
    const main = f.git("rev-parse", "main");
    if (state === "locked and missing") {
      f.git("worktree", "lock", checkout);
      await rm(checkout, { recursive: true });
    } else {
      await writeFile(path.join(checkout, "local-work.txt"), "preserve me\n");
      if (state === "missing .git") await rm(path.join(checkout, ".git"));
      if (state === "corrupt index") await writeFile(f.git("-C", checkout, "rev-parse", "--git-path", "index"), "broken index\n");
    }
    const result = f.run();
    assert.notEqual(result.status, 0);
    const diagnostic = { "missing .git": /missing or broken \.git/, "corrupt index": /index file/, dirty: /uncommitted work/, "locked and missing": /locked working tree/ }[state];
    assert.match(result.stderr, diagnostic);
    assert.ok(!result.stdout.includes("Preparing the release version"));
    assert.equal(f.git("rev-parse", "HEAD"), original);
    assert.equal(f.git("rev-parse", "origin/develop"), original);
    assert.equal(f.git("rev-parse", "origin/main"), main);
    assert.ok(f.git("worktree", "list", "--porcelain").includes("existing main"));
    if (state !== "locked and missing") assert.equal(await readFile(path.join(checkout, "local-work.txt"), "utf8"), "preserve me\n");
    assert.ok((await f.calls()).every(({ args }) => args[0] === "auth"));
  });
}

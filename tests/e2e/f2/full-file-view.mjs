// F2-19 acceptance: full-file mode over the real control plane.
//
// This drives an actual `termloop-server` daemon: it creates a Project, provisions
// a managed worktree, produces real staged/unstaged/added/binary changes, and then
// calls `task.worktreePreImage` for each. It asserts daemon facts over the wire and
// what the real Electron window shows; line-for-line expansion exactness is a pure
// function proven in `clients/desktop/test/changes-full-file.test.ts`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";
import { _electron as electron } from "playwright";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f2-full-file-view-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const projectDirectory = path.join(temporary, "project");
const worktreeDirectory = path.join(temporary, "worktree");
const electronUserDataDirectory = path.join(temporary, "electron-user-data");
const screenshotDirectory = path.join(root, "artifacts/evidence/f2/full-file-view");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f2/full-file-view.local.json");
const reportPath = path.join(root, "artifacts/evidence/f2/FULL-FILE-VIEW.md");
await Promise.all([
  mkdir(runtimeDirectory, { recursive: true }),
  mkdir(stateDirectory, { recursive: true }),
  mkdir(projectDirectory, { recursive: true }),
  mkdir(path.dirname(evidencePath), { recursive: true }),
  mkdir(screenshotDirectory, { recursive: true }),
]);

const evidence = {
  schema: "f2-full-file-view-v1",
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  checks: {
    patchAloneIsIncomplete: false,
    unstagedPreImageIsTheIndexSide: false,
    stagedPreImageIsTheHeadSide: false,
    neitherPreImageIsTheWorkingTree: false,
    addedFileReportsAbsent: false,
    binaryFileIsRefused: false,
    untrackedFileIsNotShown: false,
    oversizedFileIsTruncated: false,
    staleObservationIsRefused: false,
    shownChangeFocusModeIsTheDefault: false,
    shownFullFileModeRevealsMoreLines: false,
    shownToggleIsReversible: false,
  },
  measurements: {},
  failures: [],
  unmeasured: [
    "Electron paint cost with a full 20,000-line file mounted.",
    "Branch-commit and pull request sources: no pre-image method exists for them.",
  ],
};

let server;
let app;
try {
  git(projectDirectory, "init", "--initial-branch=main");
  git(projectDirectory, "config", "user.email", "acceptance@termloop.invalid");
  git(projectDirectory, "config", "user.name", "F2 Acceptance");

  // A 200-line file with one edit in the middle: the patch will show ~7 lines.
  const headLines = Array.from({ length: 200 }, (_unused, index) => `const line${index + 1} = ${index + 1};`);
  await writeFile(path.join(projectDirectory, "sample.ts"), `${headLines.join("\n")}\n`);
  git(projectDirectory, "add", "--", "sample.ts");
  git(projectDirectory, "commit", "-m", "baseline");
  git(projectDirectory, "update-ref", "refs/remotes/origin/main", "HEAD");

  server = await startServer();
  const record = await readRecord(server.pid);
  const project = await controlCall(record, "project.create", { name: "Full File", folderPath: projectDirectory });
  const task = await controlCall(record, "task.create", {
    projectId: project.id,
    title: "Change viewer acceptance",
    worktreeIntent: "none",
    worktreePrefix: null,
    baseRef: null,
    agentId: null,
    model: null,
    permission: null,
    reasoning: null,
    kickoffMessage: null,
  });
  await controlCall(record, "task.provisionWorktree", {
    operationId: crypto.randomUUID(),
    taskId: task.id,
    repositoryPath: projectDirectory,
    destinationPath: worktreeDirectory,
    branchName: "feature/full-file-view",
    branchMode: "create",
    baseRef: "refs/remotes/origin/main",
  });

  // Commit the binary and oversized baselines first. Anything staged before a
  // commit would be swallowed by it, so the staged/unstaged state comes last.
  await writeFile(path.join(worktreeDirectory, "blob.bin"), Buffer.from([0, 1, 2, 0, 4]));
  await writeFile(path.join(worktreeDirectory, "large.ts"), "x".repeat(300_000));
  git(worktreeDirectory, "add", "--", "blob.bin", "large.ts");
  git(worktreeDirectory, "commit", "-m", "binary and oversized baselines");

  // Three different versions of one file at once: HEAD, index, working tree.
  const indexLines = [...headLines];
  indexLines[99] = "const line100 = 10000; // staged edit";
  await writeFile(path.join(worktreeDirectory, "sample.ts"), `${indexLines.join("\n")}\n`);
  git(worktreeDirectory, "add", "--", "sample.ts");
  const workingLines = [...indexLines];
  workingLines[149] = "const line150 = 15000; // working edit";
  await writeFile(path.join(worktreeDirectory, "sample.ts"), `${workingLines.join("\n")}\n`);

  // An added file, an untracked file, a modified binary, and a shrunk oversized file.
  await writeFile(path.join(worktreeDirectory, "added.ts"), "export const fresh = true;\n");
  git(worktreeDirectory, "add", "--", "added.ts");
  await writeFile(path.join(worktreeDirectory, "untracked.ts"), "not shown\n");
  await writeFile(path.join(worktreeDirectory, "blob.bin"), Buffer.from([9, 8, 0, 7]));
  await writeFile(path.join(worktreeDirectory, "large.ts"), "small now\n");

  const list = await controlCall(record, "task.worktreeChangeList", { taskId: task.id });
  const find = (displayPath, side) => {
    const entry = list.entries.find((candidate) => candidate.display_path === displayPath
      && (side === undefined || candidate.side === side));
    if (!entry) throw new Error(`no entry for ${displayPath}${side ? ` (${side})` : ""}`);
    return entry;
  };

  const stagedEntry = find("sample.ts", "staged");
  const unstagedEntry = find("sample.ts", "unstaged");

  // --- The bounded patch alone cannot show the file ---------------------------
  const unstagedDiff = await controlCall(record, "task.worktreeDiff", {
    taskId: task.id, observationId: list.observation_id, entryId: unstagedEntry.entry_id,
  });
  assert.equal(unstagedDiff.state, "patch");
  const visibleInPatch = oldSideLinesInPatch(unstagedDiff.patch);
  assert.ok(visibleInPatch < 200, "the patch must not already show the whole file");
  evidence.measurements.oldLinesVisibleInPatch = visibleInPatch;
  evidence.measurements.totalOldLines = 200;
  evidence.checks.patchAloneIsIncomplete = true;

  // --- Unstaged pre-image is the index side ----------------------------------
  const unstagedPreImage = await controlCall(record, "task.worktreePreImage", {
    taskId: task.id, observationId: list.observation_id, entryId: unstagedEntry.entry_id,
  });
  assert.equal(unstagedPreImage.state, "content");
  assert.equal(unstagedPreImage.revision, "index");
  assert.equal(unstagedPreImage.content, `${indexLines.join("\n")}\n`);
  evidence.checks.unstagedPreImageIsTheIndexSide = true;

  // --- Staged pre-image is the HEAD side ------------------------------------
  const stagedPreImage = await controlCall(record, "task.worktreePreImage", {
    taskId: task.id, observationId: list.observation_id, entryId: stagedEntry.entry_id,
  });
  assert.equal(stagedPreImage.state, "content");
  assert.equal(stagedPreImage.revision, "head");
  assert.equal(stagedPreImage.content, `${headLines.join("\n")}\n`);
  evidence.checks.stagedPreImageIsTheHeadSide = true;

  const workingTree = `${workingLines.join("\n")}\n`;
  assert.notEqual(unstagedPreImage.content, workingTree);
  assert.notEqual(stagedPreImage.content, workingTree);
  evidence.checks.neitherPreImageIsTheWorkingTree = true;

  // --- Explicit refusals ----------------------------------------------------
  const refusals = {
    addedFileReportsAbsent: [find("added.ts"), "absent"],
    binaryFileIsRefused: [find("blob.bin"), "binary"],
    untrackedFileIsNotShown: [find("untracked.ts"), "notShown"],
    oversizedFileIsTruncated: [find("large.ts"), "truncated"],
  };
  for (const [check, [entry, expectedState]] of Object.entries(refusals)) {
    const result = await controlCall(record, "task.worktreePreImage", {
      taskId: task.id, observationId: list.observation_id, entryId: entry.entry_id,
    });
    assert.equal(result.state, expectedState, `${entry.display_path} state`);
    assert.equal(result.content, null, `${entry.display_path} content`);
    evidence.checks[check] = true;
  }

  // --- A stale observation is refused --------------------------------------
  const stale = await rawControlCall(record, record.token, "task.worktreePreImage", {
    taskId: task.id, observationId: "changes-does-not-exist", entryId: unstagedEntry.entry_id,
  });
  assert.equal(stale.ok, false);
  evidence.measurements.staleRefusal = stale.error?.message ?? "refused";
  evidence.checks.staleObservationIsRefused = true;

  // --- The narrow read-only scope cannot read whole-file content ------------
  if (record.readOnlyToken) {
    const denied = await rawControlCall(record, record.readOnlyToken, "task.worktreePreImage", {
      taskId: task.id, observationId: list.observation_id, entryId: unstagedEntry.entry_id,
    });
    assert.equal(denied.ok, false, "read-only scope must not read pre-image content");
    evidence.measurements.readOnlyRefusal = denied.error?.message ?? "refused";
    evidence.checks.readOnlyScopeCannotReadPreImage = true;
  } else {
    evidence.unmeasured.push(
      "readOnlyScopeCannotReadPreImage: the runtime record exposes no read-only token, so scope exclusion is covered by the contract and server unit tests instead.",
    );
  }
  // --- Shown: both modes in the real Electron window -----------------------
  ({ app } = await launchDesktop());
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /Review \d+ changed files/ }).first().click();
  const overlay = page.locator(".changes-overlay");
  await overlay.waitFor();
  await page.locator(`[data-change-entry-id="${unstagedEntry.entry_id}"]`).click();
  await page.locator(".diff").waitFor();

  const diffRows = () => page.locator(".diff tbody tr").count();
  const changeFocusButton = overlay.getByRole("button", { name: "Change focus", exact: true });
  const fullFileButton = overlay.getByRole("button", { name: "Full file", exact: true });
  const rowsInChangeFocus = await diffRows();
  assert.equal(await changeFocusButton.getAttribute("aria-pressed"), "true");
  assert.equal(await fullFileButton.getAttribute("aria-pressed"), "false");
  evidence.measurements.shownRowsInChangeFocus = rowsInChangeFocus;
  evidence.checks.shownChangeFocusModeIsTheDefault = true;
  await page.screenshot({ path: path.join(screenshotDirectory, "01-change-focus.png") });

  await fullFileButton.click();
  await page.waitForFunction(
    () => document.querySelector(".changes-full-file-status")?.textContent?.includes("Showing all") === true,
    undefined,
    { timeout: 15_000 },
  );
  const rowsInFullFile = await diffRows();
  const shownStatus = (await page.locator(".changes-full-file-status").textContent())?.trim() ?? "";
  assert.ok(rowsInFullFile > rowsInChangeFocus, "full-file mode must render more rows");
  assert.match(shownStatus, /Showing all 200 lines; 193 were not in the patch\./);
  assert.ok(
    (await overlay.textContent())?.includes("const line1 = 1;"),
    "content outside the patch must become visible",
  );
  evidence.measurements.shownRowsInFullFile = rowsInFullFile;
  evidence.measurements.shownFullFileStatus = shownStatus;
  evidence.checks.shownFullFileModeRevealsMoreLines = true;
  await page.screenshot({ path: path.join(screenshotDirectory, "02-full-file.png") });

  await changeFocusButton.click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".diff tbody tr").length === expected,
    rowsInChangeFocus,
    { timeout: 10_000 },
  );
  assert.equal(await diffRows(), rowsInChangeFocus);
  evidence.checks.shownToggleIsReversible = true;
  evidence.measurements.screenshots = [
    "artifacts/evidence/f2/full-file-view/01-change-focus.png",
    "artifacts/evidence/f2/full-file-view/02-full-file.png",
  ];
} catch (error) {
  evidence.failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  if (app) await app.close().catch(() => {});
  if (server) await stopServer(server);
}

// Every key present was actually measured: an unmeasurable check is never seeded,
// it is recorded under `unmeasured` instead.
evidence.status = evidence.failures.length === 0 && Object.values(evidence.checks).every(Boolean)
  ? "PASS_LOCAL"
  : "FAIL";
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(reportPath, report(evidence));
console.log(`F2-19 full-file view: ${evidence.status}`);
for (const [name, passed] of Object.entries(evidence.checks)) {
  console.log(`  ${passed ? "pass" : "----"} ${name}`);
}
for (const failure of evidence.failures) console.error(failure);
if (evidence.status !== "PASS_LOCAL") process.exitCode = 1;

/**
 * How many old-side lines the unified patch itself shows: context and deleted
 * lines inside its hunks. Counted from the patch text so this stays a wire-level
 * assertion with no dependency on the renderer's diff library.
 */
function oldSideLinesInPatch(patch) {
  let inHunk = false;
  let lines = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith(" ") || line.startsWith("-")) lines += 1;
  }
  return lines;
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "F2 Acceptance",
      GIT_AUTHOR_EMAIL: "acceptance@termloop.invalid",
      GIT_COMMITTER_NAME: "F2 Acceptance",
      GIT_COMMITTER_EMAIL: "acceptance@termloop.invalid",
      LC_ALL: "C",
      LANG: "C",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function launchDesktop() {
  const launched = await electron.launch({
    args: [path.join(root, "clients/desktop")],
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_FILE: runtimeFile, TERMLOOP_DESKTOP_USER_DATA_DIR: electronUserDataDirectory },
  });
  const page = await launched.firstWindow();
  await page.locator("[aria-label='Projects and sessions']").waitFor();
  return { app: launched, page };
}

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory },
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
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(runtimeFile, "utf8"));
      if (record.pid === pid) return record;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime discovery did not appear for pid ${pid}`);
}

async function controlCall(record, method, params = {}) {
  const response = await rawControlCall(record, record.token, method, params);
  if (response.ok) return response.result;
  throw new Error(`${method}: ${response.error?.message ?? "failed"}`);
}

async function rawControlCall(record, token, method, params = {}) {
  const socket = new WebSocket(record.controlUrl);
  const id = crypto.randomUUID();
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 15_000);
    socket.once("open", () => socket.send(JSON.stringify({ id, protocolVersion: record.protocolVersion, token, method, params })));
    socket.once("message", (raw) => {
      clearTimeout(timeout); socket.close();
      resolve(JSON.parse(String(raw)));
    });
    socket.once("error", reject);
  });
}

function report(value) {
  const rows = Object.entries(value.checks)
    .map(([name, passed]) => `| ${name} | ${passed ? "PASS" : "FAIL"} |`)
    .join("\n");
  return `# F2-19 Full File View Evidence

Captured: ${value.capturedAt}

Status: **${value.status}**

Generated by \`pnpm acceptance:f2-full-file-view\` against a real
\`termloop-server\` daemon and a real managed worktree. Do not edit by hand.

Host: ${value.host.platform} ${value.host.arch} (${value.host.release})

| Check | Result |
|---|---|
${rows}

## Measurements

\`\`\`json
${JSON.stringify(value.measurements, null, 2)}
\`\`\`

## Not measured

${value.unmeasured.map((item) => `- ${item}`).join("\n")}
${value.failures.length ? `\n## Failures\n\n\`\`\`text\n${value.failures.join("\n\n")}\n\`\`\`\n` : ""}`;
}

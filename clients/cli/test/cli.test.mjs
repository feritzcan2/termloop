import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { TermLoopControlError } from "@termloop/contract/current";
import { controlErrorMessage, formatHumanOutput, methodFor, parseArgs } from "../dist/index.js";
import { defaultRuntimeFile } from "../dist/platform/discovery.js";
import {
  daemonServicePaths,
  launchAgentDefinition,
  systemdUserDefinition,
  windowsInstallScript,
} from "../dist/platform/daemon-service.js";

test("parses generated command without reading filesystem", () => {
  const options = parseArgs(["ping", "--json"], { TERMLOOP_CONTROL_URL: "ws://127.0.0.1:1/control", TERMLOOP_TOKEN: "x".repeat(64) });
  assert.equal(methodFor(options.command), "system.ping");
  assert.equal(options.json, true);
  assert.deepEqual(options.params, {});
});

test("maps nested access lifecycle and pairing commands", () => {
  const enabled = parseArgs(["access", "enable", "--port", "44001"], {});
  assert.equal(methodFor(enabled.command), "access.enable");
  assert.deepEqual(enabled.params, { port: 44001 });
  const pairing = parseArgs(["access", "pair", "--name", "Travel laptop", "--scope", "readOnly"], {});
  assert.equal(methodFor(pairing.command), "access.pairCreate");
  assert.deepEqual(pairing.params, { name: "Travel laptop", scope: "readOnly" });
  const revoked = parseArgs(["access", "revoke", "--device", "a".repeat(32)], {});
  assert.equal(methodFor(revoked.command), "access.deviceRevoke");
  assert.deepEqual(revoked.params, { deviceId: "a".repeat(32) });
  assert.equal(methodFor(parseArgs(["access", "status"], {}).command), "access.status");
  assert.equal(methodFor(parseArgs(["access", "disable"], {}).command), "access.disable");
  assert.throws(() => parseArgs(["access", "enable", "--port", "80"], {}), /between 1024 and 65535/);
});

test("parses local daemon service commands without control credentials", () => {
  const installed = parseArgs(["service", "install", "--server", "/opt/TermLoop/bin/termloop-server", "--json"], {});
  assert.equal(installed.command, "service-install");
  assert.equal(installed.json, true);
  assert.deepEqual(installed.params, { serverBinary: "/opt/TermLoop/bin/termloop-server" });
  assert.deepEqual(parseArgs(["service", "status"], {}).params, {});
  assert.equal(parseArgs(["service", "uninstall"], {}).command, "service-uninstall");
  assert.throws(() => parseArgs(["service", "start", "--server", "/tmp/server"], {}), /only for service install/);
  assert.throws(() => methodFor(installed.command), /local service command/);
});

test("renders transport guidance only in human access output", () => {
  const output = formatHumanOutput("access-enable", {
    enabled: true,
    listening: true,
    port: 43717,
    server_fingerprint: `sha256:${"a".repeat(64)}`,
    error: null,
  });
  assert.match(output, /Tailscale.*Serve.*wss:\/\//);
  assert.match(output, /SSH.*43717/);
  assert.doesNotMatch(output, /token|secret/i);

  const pairing = formatHumanOutput("access-pair", {
    pairing_code: "ABCD-EFGH",
    server_fingerprint: `sha256:${"b".repeat(64)}`,
    expires_at_epoch_ms: 123,
    access_url: "ws://127.0.0.1:43717",
  });
  assert.match(pairing, /Verify the fingerprint/);
});

test("renders user-scoped service definitions for all release platforms", () => {
  assert.deepEqual(
    daemonServicePaths("darwin", "/Users/demo", {}),
    {
      configuration: "/Users/demo/Library/LaunchAgents/dev.termloop.next.server.plist",
      logDirectory: "/Users/demo/Library/Application Support/termloop-next/logs",
    },
  );
  assert.deepEqual(
    daemonServicePaths("linux", "/home/demo", { XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state" }),
    { configuration: "/config/systemd/user/termloop-next.service", logDirectory: "/state/termloop-next/logs" },
  );
  assert.deepEqual(
    daemonServicePaths("win32", "C:\\Users\\demo", { LOCALAPPDATA: "D:\\Local" }),
    { logDirectory: "D:\\Local\\termloop-next\\logs" },
  );

  const launchd = launchAgentDefinition("/Applications/A&B/termloop-server", "/tmp/TermLoop Logs", "/opt/bin:/usr/bin");
  assert.match(launchd, /A&amp;B/);
  assert.match(launchd, /SuccessfulExit/);
  assert.doesNotMatch(launchd, /<key>KeepAlive<\/key><true\/>/);

  const systemd = systemdUserDefinition("/opt/Term Loop/%server", "/opt/bin:/usr/bin");
  assert.match(systemd, /ExecStart="\/opt\/Term Loop\/%%server"/);
  assert.match(systemd, /Restart=on-failure/);

  const windows = windowsInstallScript("C:\\TermLoop\\O'Brien\\termloop-server.exe");
  assert.match(windows, /LogonType Interactive/);
  assert.match(windows, /O''Brien/);
  assert.doesNotMatch(windows, /New-Service|sc\.exe/i);
});

test("requires an explicit bounded acknowledgement for destructive cleanup", () => {
  const cleanup = parseArgs([
    "task-cleanup",
    "--operation", "11111111-1111-4111-8111-111111111111",
    "--task", "task-1", "--proof", "proof-1", "--generation", "3",
    "--discard-content", "--acknowledge", "untrackedContent,ignoredContent",
  ], {});
  assert.equal(cleanup.command, "task-cleanup");
  assert.equal(cleanup.params.cleanupMode, "discardCheckoutContent");
  assert.deepEqual(cleanup.params.acknowledgedContentBlockers, ["untrackedContent", "ignoredContent"]);
  assert.throws(
    () => parseArgs(["task-cleanup", "--operation", "op", "--task", "task-1", "--proof", "proof-1", "--generation", "3", "--discard-content"], {}),
    /requires --acknowledge/,
  );
});

test("maps project creation parameters", () => {
  const options = parseArgs(["project-create", "--name", "Demo", "--folder", "/tmp/demo"], { TERMLOOP_CONTROL_URL: "ws://127.0.0.1:1/control", TERMLOOP_TOKEN: "x".repeat(64) });
  assert.equal(methodFor(options.command), "project.create");
  assert.deepEqual(options.params, { name: "Demo", folderPath: "/tmp/demo" });
});

test("maps Project update and delete parameters", () => {
  const updated = parseArgs(["project-update", "--project", "project-1", "--name", "Renamed", "--folder", "/tmp/renamed"], {});
  assert.equal(methodFor(updated.command), "project.updateDetails");
  assert.deepEqual(updated.params, { projectId: "project-1", name: "Renamed", folderPath: "/tmp/renamed" });

  const deleted = parseArgs(["project-delete", "--project", "project-1"], {});
  assert.equal(methodFor(deleted.command), "project.delete");
  assert.deepEqual(deleted.params, { projectId: "project-1" });
});

test("maps bounded pull-request projection parameters", () => {
  const options = parseArgs(["pr-list", "--project", "project-1", "--tasks", "task-1,task-2"], {});
  assert.equal(methodFor(options.command), "gitHost.pullRequestList");
  assert.deepEqual(options.params, { projectId: "project-1", taskIds: ["task-1", "task-2"] });
  assert.throws(
    () => parseArgs(["pr-list", "--project", "project-1", "--tasks", "task-1,task-1"], {}),
    /require unique Task IDs/,
  );
  assert.deepEqual(parseArgs(["pr-list", "--project", "project-1"], {}).params, { projectId: "project-1" });
  assert.deepEqual(
    parseArgs(["pr-list", "--project", "project-1", "--task", "task-1", "--task", "task-2"], {}).params,
    { projectId: "project-1", taskIds: ["task-1", "task-2"] },
  );
});

test("maps explicit Task branch binding parameters", () => {
  const options = parseArgs([
    "task-bind-branch",
    "--task", "task-1",
    "--repository", "/tmp/demo",
    "--branch", "feature/api",
  ], {});
  assert.equal(methodFor(options.command), "task.bindBranch");
  assert.deepEqual(options.params, {
    taskId: "task-1",
    repositoryPath: "/tmp/demo",
    branchName: "feature/api",
  });
});

test("maps explicit Task archive lifecycle parameters", () => {
  const listed = parseArgs(["task-list", "--project", "project-1", "--archive-scope", "archived"], {});
  assert.equal(methodFor(listed.command), "task.list");
  assert.deepEqual(listed.params, { projectId: "project-1", archiveScope: "archived" });
  const inspected = parseArgs(["task-inspect-archive", "--task", "task-1"], {});
  assert.equal(methodFor(inspected.command), "task.inspectArchive");
  assert.deepEqual(inspected.params, { taskId: "task-1" });
  const archived = parseArgs([
    "task-archive", "--task", "task-1", "--operation", "operation-1", "--ticket", "ticket-1",
  ], {});
  assert.equal(methodFor(archived.command), "task.archive");
  assert.deepEqual(archived.params, { taskId: "task-1", operationId: "operation-1", archiveTicket: "ticket-1" });
  assert.equal(methodFor(parseArgs(["task-restore", "--task", "task-1"], {}).command), "task.restore");
  assert.equal(methodFor(parseArgs(["task-archived-context", "--task", "task-1"], {}).command), "task.archivedContext");
});

test("maps explicit Agent Session archive lifecycle parameters", () => {
  const listed = parseArgs(["session-list-archived", "--project", "project-1"], {});
  assert.equal(methodFor(listed.command), "session.listArchived");
  assert.deepEqual(listed.params, { projectId: "project-1" });
  assert.equal(methodFor(parseArgs(["session-inspect-archive", "--session", "session-1"], {}).command), "session.inspectArchive");
  const archived = parseArgs([
    "session-archive", "--session", "session-1", "--operation", "operation-1", "--ticket", "ticket-1",
  ], {});
  assert.equal(methodFor(archived.command), "session.archive");
  assert.deepEqual(archived.params, { sessionId: "session-1", operationId: "operation-1", archiveTicket: "ticket-1" });
  assert.equal(methodFor(parseArgs(["session-restore-archived", "--session", "session-1"], {}).command), "session.restoreArchived");
  assert.equal(methodFor(parseArgs(["session-delete-archived", "--session", "session-1"], {}).command), "session.deleteArchived");
});

test("maps explicit Task worktree provisioning parameters", () => {
  const options = parseArgs([
    "task-provision-worktree",
    "--operation", "11111111-1111-4111-8111-111111111111",
    "--task", "task-1",
    "--repository", "/tmp/demo",
    "--destination", "/tmp/demo-feature",
    "--branch", "feature/api",
    "--mode", "create",
    "--base-ref", "refs/remotes/origin/main",
  ], {});
  assert.equal(methodFor(options.command), "task.provisionWorktree");
  assert.deepEqual(options.params, {
    operationId: "11111111-1111-4111-8111-111111111111",
    taskId: "task-1",
    repositoryPath: "/tmp/demo",
    destinationPath: "/tmp/demo-feature",
    branchName: "feature/api",
    branchMode: "create",
    baseRef: "refs/remotes/origin/main",
  });
});

test("maps cleanup inspection and generation/proof CAS parameters", () => {
  const inspect = parseArgs(["task-inspect-cleanup", "--task", "task-1"], {});
  assert.equal(methodFor(inspect.command), "task.inspectWorktreeCleanup");
  assert.deepEqual(inspect.params, { taskId: "task-1" });
  const cleanup = parseArgs([
    "task-cleanup",
    "--operation", "11111111-1111-4111-8111-111111111111",
    "--task", "task-1",
    "--proof", "proof-1",
    "--generation", "3",
  ], {});
  assert.equal(methodFor(cleanup.command), "task.cleanupWorktree");
  assert.deepEqual(cleanup.params, {
    operationId: "11111111-1111-4111-8111-111111111111",
    taskId: "task-1",
    expectedManagedWorktreeOperationId: "proof-1",
    expectedWorktreeGeneration: 3,
    cleanupMode: "safe",
    acknowledgedContentBlockers: [],
  });
});

test("renders typed Task conflict details without parsing the message", () => {
  assert.equal(
    controlErrorMessage(new TermLoopControlError(
      "opaque server message",
      "conflict",
      { kind: "branchHeldByTask", taskId: "task-holder" },
    )),
    "opaque server message (held by Task task-holder)",
  );
  assert.equal(
    controlErrorMessage(new TermLoopControlError(
      "opaque server message",
      "conflict",
      { kind: "taskBranchAlreadyBound", taskId: "task-target" },
    )),
    "opaque server message (Task task-target)",
  );
  assert.equal(
    controlErrorMessage(new TermLoopControlError(
      "opaque server message",
      "conflict",
      { kind: "worktreeRecoveryAttention", operationId: "operation-1" },
    )),
    "opaque server message (operation operation-1)",
  );
  assert.equal(
    controlErrorMessage(new TermLoopControlError(
      "opaque server message",
      "conflict",
      { kind: "branchCheckedOutElsewhere", worktreePath: "/tmp/other" },
    )),
    "opaque server message (checkout /tmp/other)",
  );
});

test("maps Session rename and explicit clear parameters", () => {
  const renamed = parseArgs(["session-rename", "--session", "session-1", "--name", "API shell"], {});
  assert.equal(methodFor(renamed.command), "session.rename");
  assert.deepEqual(renamed.params, { sessionId: "session-1", name: "API shell" });

  const cleared = parseArgs(["session-rename", "--session", "session-1", "--clear"], {});
  assert.deepEqual(cleared.params, { sessionId: "session-1", name: null });
});

test("maps ticketed Session resume, fork, and close without provider metadata", () => {
  const resumed = parseArgs(["session-resume", "--session", "session-1", "--ticket", "a".repeat(64)], {});
  assert.equal(methodFor(resumed.command), "session.resumeAgent");
  assert.deepEqual(resumed.params, { sessionId: "session-1", launchTicket: "a".repeat(64) });
  const forked = parseArgs(["session-fork", "--session", "session-1"], {});
  assert.equal(methodFor(forked.command), "session.forkAgent");
  assert.deepEqual(forked.params, { sessionId: "session-1" });
  const closed = parseArgs(["session-close", "--session", "session-1"], {});
  assert.equal(methodFor(closed.command), "session.close");
  assert.deepEqual(closed.params, { sessionId: "session-1" });
});

test("uses a runtime discovery file instead of a token argv", () => {
  const options = parseArgs(["ping", "--runtime", "/tmp/termloop-runtime.json"], {});
  assert.equal(options.runtimeFile, "/tmp/termloop-runtime.json");
  assert.equal(options.token, undefined);
});

test("default discovery paths match each daemon platform adapter", () => {
  assert.equal(defaultRuntimeFile({ LOCALAPPDATA: "C:\\Local" }, "win32", "C:\\Users\\me", "/tmp", "42"), path.join("C:\\Local", "termloop-next", "runtime.json"));
  assert.equal(defaultRuntimeFile({}, "win32", "C:\\Users\\me", "/tmp", "42"), path.join("C:\\Users\\me", "AppData/Local", "termloop-next", "runtime.json"));
  assert.equal(defaultRuntimeFile({}, "darwin", "/Users/me", "/tmp", "42"), path.join("/Users/me", "Library/Application Support/termloop-next/runtime.json"));
  assert.equal(defaultRuntimeFile({ XDG_RUNTIME_DIR: "/run/user/42" }, "linux", "/home/me", "/tmp", "42"), path.join("/run/user/42", "termloop-next", "runtime.json"));
  assert.equal(defaultRuntimeFile({}, "linux", "/home/me", "/tmp", "42"), path.join("/tmp", "termloop-next-42", "termloop-next", "runtime.json"));
});

import assert from "node:assert/strict";
import test from "node:test";
import { ACCESS_PROTOCOL_IDENTITY, EVENTS, METHODS, CONTRACT_IDENTITY, READ_ONLY_METHODS, COMPANION_METHODS, MCP_TOOL_DEFINITIONS, MCP_INTERACTIVE_TOOLS, MCP_IMPROVER_TOOLS, MCP_STEWARD_TOOLS, MCP_HELPER_TOOLS, TermLoopControlClient, TermLoopControlError, controlRequestTimeoutMs, validateMethodResult } from "../dist/current.js";

test("generated validator rejects cross-provider Git-host identities", () => {
  const result = [{
    usage: "displayOnly",
    task_id: "task", branch_name: "feature", repository_provider: "azureDevOps",
    repository_host: "dev.azure.com", repository_owner: "fiber-teams",
    repository_project: "Fiber Tests", repository_name: "widget", quality: "matches",
    freshness: "fresh", reason: null, truncated: false, candidate_truncated: false,
    freshness_generation: 1, last_success_observed_at_epoch_ms: 1,
    last_attempt_observed_at_epoch_ms: 1,
    matches: [{
      provider: "azureDevOps", host: "dev.azure.com", repository_owner: "fiber-teams",
      repository_project: "Fiber Tests", repository_name: "widget", number: 42,
      title: "Safe", url: "https://dev.azure.com/fiber-teams/Fiber%20Tests/_git/widget/pullrequest/42",
      state: "open", merge_commit_oid: null, base_branch: "main", head_branch: "feature",
      head_repository_owner: "fiber-teams", head_repository_project: "Forks",
      head_repository_name: "widget-fork", check_rollup: "unsupported",
      check_rollup_source: "unsupported", review_signal: "reviewRequired",
      review_signal_source: "azureRequiredReviewerVotes", merge_conflict: "unknown",
      merge_conflict_source: "azureMergeStatus", activity_at_epoch_ms: 1,
      activity_at_source: "azureLifecycleApproximation",
    }],
  }];
  assert.equal(validateMethodResult("gitHost.pullRequestList", result), true);
  for (const mutate of [
    (copy) => { copy[0].matches[0].host = "github.com"; },
    (copy) => { copy[0].matches[0].repository_project = null; },
    (copy) => { copy[0].matches[0].url = "https://github.com/acme/widget/pull/42"; },
    (copy) => { copy[0].repository_host = "github.com"; },
    (copy) => { copy[0].matches[0].check_rollup = "passing"; },
    (copy) => { copy[0].matches[0].review_signal_source = "githubReviewDecision"; },
  ]) {
    const copy = structuredClone(result);
    mutate(copy);
    assert.equal(validateMethodResult("gitHost.pullRequestList", copy), false);
  }
});

test("session image paste result is strict and full-control only", () => {
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal(validateMethodResult("session.pasteImage", { sessionId, status: "delivered" }), true);
  assert.equal(validateMethodResult("session.pasteImage", { sessionId, status: "queued" }), false);
  assert.equal(validateMethodResult("session.pasteImage", { sessionId, status: "delivered", provider: "codex" }), false);
  assert.ok(METHODS.includes("session.pasteImage"));
  assert.ok(!READ_ONLY_METHODS.includes("session.pasteImage"));
  assert.ok(!COMPANION_METHODS.includes("session.pasteImage"));
});

test("generated current contract surface is stable", () => {
  assert.match(CONTRACT_IDENTITY, /^sha256:[0-9a-f]{64}$/);
  assert.match(ACCESS_PROTOCOL_IDENTITY, /^sha256:[0-9a-f]{64}$/);
  const contextBankMethods = METHODS.filter((method) => method.startsWith("contextBank."));
  assert.deepEqual(METHODS.filter((method) => !method.startsWith("contextBank.")), ["system.version","system.capabilities","system.ping","system.defaultProjectsRoot","system.browseDirectory","attachment.beginUpload","system.shutdown","system.keepAwake.get","system.keepAwake.set","access.status","access.enable","access.disable","access.pairCreate","access.deviceList","access.deviceRevoke","control.subscribe","control.cancel","mcp.toolSettingsGet","mcp.toolDescriptionUpdate","mcp.toolDescriptionReset","skill.catalogGet","skill.deploymentSet","skill.definitionGet","skill.definitionSave","skill.definitionCreate","project.create","project.list","project.taskAutomationGet","project.taskAutomationSet","project.worktreeSummary","project.worktreeChangeList","project.worktreeDiff","project.worktreePreImage","project.listLocalBranches","project.updateDetails","project.delete","task.create","task.list","task.inspectArchive","task.archive","task.abandonArchive","task.restore","task.archivedContext","task.worktreeChangeList","task.worktreeDiff","task.worktreePreImage","task.branchCommitSummaryList","task.branchCommitList","task.branchCommitChangeList","task.branchCommitDiff","task.bindBranch","task.provisionWorktree","task.inspectWorktreeRepair","task.inspectWorktreeCleanup","task.repairWorktree","task.cleanupWorktree","task.forgetStaleWorktree","task.discardStaleWorktree","task.dismissWorktreeRepair","task.dismissWorktreeProvisioning","task.rename","task.updateBrief","task.updateDeveloperNotes","task.close","task.finalizeClosedWorktreeRemoval","task.reopen","task.delete","task.deleteArchived","task.launchTerminal","task.previewAgent","task.launchAgent","task.startRun","task.restartRun","project.startRun","project.restartRun","session.launchTerminal","session.previewAgent","session.launchAgent","session.forkAgent","session.repairProviderHistory","session.historyList","session.historyPreview","session.previewHistoryResumeAgent","session.resumeHistoryAgent","session.requestAskTo","session.requestHandoverTo","session.pasteImage","quickAction.preview","quickAction.launch","session.list","session.listArchived","session.listDeleted","session.inspectArchive","session.archive","session.restoreArchived","session.deleteArchived","session.restoreDeleted","session.rename","session.terminate","session.previewResumeAgent","session.resumeAgent","session.restartAgent","session.previewRelocateAgentToTask","session.relocateAgentToTask","session.previewRelocateAgentToProject","session.relocateAgentToProject","session.restartAgentsForClientLaunch","session.close","agent.capabilityList","agent.profileList","agent.statusList","agent.observe","steward.configurationGet","steward.configurationSet","steward.configurationDelete","runConfiguration.list","runConfiguration.create","runConfiguration.update","runConfiguration.delete","runConfiguration.improvePreview","runConfiguration.improveLaunch","assistantPrompt.improvePreview","assistantPrompt.improveLaunch","settings.improvePreview","settings.improveLaunch","configuration.versionList","configuration.versionRestore","run.runtimeList","routine.configurationList","routine.configurationCreate","routine.configurationUpdate","routine.contextUpdate","routine.configurationDelete","routine.runtimeList","routine.runNow","taskSource.list","taskSource.boardList","taskSource.boardListStored","taskSource.statusList","taskSource.statusListStored","taskSource.create","taskSource.update","taskSource.credentialsSet","taskSource.delete","taskSource.refresh","taskSource.candidateList","taskSource.candidateImport","taskSource.candidateIgnore","taskSource.candidateUnignore","playbook.get","playbook.update","playbook.taskPositionSet","playbook.runtime","companion.transcriptAppend","companion.proposalRespond","companion.suggestionAccept","companion.transcriptList","companion.transcriptClear","companion.wakeNext","companion.stewardWake","voice.settingsGet","voice.credentialsSet","gitHost.pullRequestList","gitHost.pullRequestChangeList","gitHost.pullRequestDiff"]);
  assert.deepEqual(contextBankMethods, ["contextBank.catalogGet", "contextBank.fileGet", "contextBank.fileSave", "contextBank.siblingConflictResolve"]);
  assert.deepEqual(METHODS.slice(25, 29), contextBankMethods);
  assert.deepEqual(EVENTS, ["projection.invalidated"]);
  assert.ok(READ_ONLY_METHODS.includes("control.subscribe"));
  assert.ok(READ_ONLY_METHODS.includes("control.cancel"));
  assert.ok(COMPANION_METHODS.includes("control.cancel"));
  assert.ok(READ_ONLY_METHODS.includes("mcp.toolSettingsGet"));
  assert.ok(!READ_ONLY_METHODS.includes("mcp.toolDescriptionUpdate"));
  assert.ok(!READ_ONLY_METHODS.includes("mcp.toolDescriptionReset"));
  assert.ok(READ_ONLY_METHODS.includes("skill.catalogGet"));
  assert.ok(!READ_ONLY_METHODS.includes("skill.deploymentSet"));
  assert.ok(!READ_ONLY_METHODS.includes("skill.definitionGet"));
  assert.ok(!READ_ONLY_METHODS.includes("skill.definitionSave"));
  assert.ok(!READ_ONLY_METHODS.includes("skill.definitionCreate"));
  assert.ok(!READ_ONLY_METHODS.includes("settings.improveLaunch"));
  assert.ok(!COMPANION_METHODS.includes("skill.catalogGet"));
  assert.ok(!COMPANION_METHODS.includes("skill.deploymentSet"));
  assert.ok(!COMPANION_METHODS.includes("skill.definitionGet"));
  assert.ok(!COMPANION_METHODS.includes("skill.definitionSave"));
  assert.ok(!COMPANION_METHODS.includes("skill.definitionCreate"));
  assert.ok(!COMPANION_METHODS.includes("settings.improveLaunch"));
  assert.equal(CONTRACT_IDENTITY.length, 71);
  assert.ok(READ_ONLY_METHODS.includes("project.list"));
  assert.ok(READ_ONLY_METHODS.includes("project.taskAutomationGet"));
  assert.ok(!READ_ONLY_METHODS.includes("project.taskAutomationSet"));
  assert.ok(READ_ONLY_METHODS.includes("task.list"));
  assert.ok(READ_ONLY_METHODS.includes("runConfiguration.list"));
  assert.ok(READ_ONLY_METHODS.includes("run.runtimeList"));
  assert.ok(!READ_ONLY_METHODS.includes("runConfiguration.create"));
  assert.ok(!READ_ONLY_METHODS.includes("task.startRun"));
  assert.ok(READ_ONLY_METHODS.includes("gitHost.pullRequestList"));
  assert.ok(!READ_ONLY_METHODS.includes("project.create"));
  assert.ok(!READ_ONLY_METHODS.includes("project.listLocalBranches"));
  assert.ok(!READ_ONLY_METHODS.includes("task.create"));
  assert.ok(!READ_ONLY_METHODS.includes("task.bindBranch"));
  assert.ok(!READ_ONLY_METHODS.includes("task.provisionWorktree"));
  assert.ok(COMPANION_METHODS.includes("companion.transcriptAppend"));
  assert.ok(!COMPANION_METHODS.includes("companion.proposalRespond"));
  assert.ok(!COMPANION_METHODS.includes("companion.suggestionAccept"));
  assert.ok(COMPANION_METHODS.includes("companion.transcriptList"));
  assert.ok(!COMPANION_METHODS.includes("companion.transcriptClear"));
  assert.ok(!READ_ONLY_METHODS.includes("steward.taskCreateConfirmationGet"));
  assert.ok(!METHODS.includes("steward.taskCreateRequest"));
  assert.ok(!COMPANION_METHODS.includes("steward.taskCreateResolve"));
  assert.ok(COMPANION_METHODS.includes("companion.wakeNext"));
  assert.ok(COMPANION_METHODS.includes("companion.stewardWake"));
  assert.ok(READ_ONLY_METHODS.includes("steward.configurationGet"));
  assert.ok(COMPANION_METHODS.includes("steward.configurationGet"));
  assert.ok(!COMPANION_METHODS.includes("steward.configurationSet"));
  assert.ok(!READ_ONLY_METHODS.includes("steward.configurationDelete"));
  assert.ok(!COMPANION_METHODS.includes("steward.configurationDelete"));
  assert.ok(!METHODS.includes("worker.ready"));
  assert.ok(!METHODS.includes("worker.taskBoard"));
  assert.ok(!READ_ONLY_METHODS.includes("routine.runNow"));
  assert.ok(READ_ONLY_METHODS.includes("routine.configurationList"));
  assert.ok(COMPANION_METHODS.includes("routine.configurationList"));
  assert.ok(!READ_ONLY_METHODS.includes("routine.configurationCreate"));
  assert.ok(!COMPANION_METHODS.includes("routine.configurationUpdate"));
  assert.ok(!METHODS.includes("routine.sourceProbe"));
  assert.ok(!METHODS.includes("routine.sourceRead"));
  assert.ok(READ_ONLY_METHODS.includes("routine.runtimeList"));
  assert.ok(COMPANION_METHODS.includes("routine.runtimeList"));
  assert.ok(!METHODS.includes("steward.report"));
  assert.ok(!READ_ONLY_METHODS.includes("task.worktreeChangeList"));
  assert.ok(!READ_ONLY_METHODS.includes("task.worktreeDiff"));
  assert.ok(!READ_ONLY_METHODS.includes("task.worktreePreImage"));
  assert.ok(!COMPANION_METHODS.includes("task.worktreePreImage"));
  assert.ok(!READ_ONLY_METHODS.includes("task.branchCommitSummaryList"));
  assert.ok(!READ_ONLY_METHODS.includes("task.branchCommitList"));
  assert.ok(!READ_ONLY_METHODS.includes("task.branchCommitChangeList"));
  assert.ok(!READ_ONLY_METHODS.includes("task.branchCommitDiff"));
  assert.ok(!READ_ONLY_METHODS.includes("gitHost.pullRequestChangeList"));
  assert.ok(!READ_ONLY_METHODS.includes("gitHost.pullRequestDiff"));
  // Graceful daemon shutdown is a Full-scope command; narrow scopes never
  // gain the authority to stop the daemon.
  assert.ok(METHODS.includes("system.shutdown"));
  assert.ok(METHODS.includes("session.restartAgent"));
  assert.ok(!READ_ONLY_METHODS.includes("session.restartAgent"));
  assert.ok(!COMPANION_METHODS.includes("session.restartAgent"));
  assert.ok(!READ_ONLY_METHODS.includes("system.shutdown"));
  assert.ok(!COMPANION_METHODS.includes("system.shutdown"));
  for (const method of ["access.status", "access.enable", "access.disable", "access.pairCreate", "access.deviceList", "access.deviceRevoke"]) {
    assert.ok(!READ_ONLY_METHODS.includes(method));
    assert.ok(!COMPANION_METHODS.includes(method));
  }
  assert.equal(validateMethodResult("system.shutdown", { accepted: true }), true);
  assert.equal(validateMethodResult("system.shutdown", { accepted: false }), false);
  // Reading the keep-awake state is harmless, so it joins the read-only scope.
  // Changing it alters the host's power behavior and stays Full-scope only.
  assert.ok(READ_ONLY_METHODS.includes("system.keepAwake.get"));
  assert.ok(!READ_ONLY_METHODS.includes("system.keepAwake.set"));
  assert.ok(!COMPANION_METHODS.includes("system.keepAwake.get"));
  assert.ok(!COMPANION_METHODS.includes("system.keepAwake.set"));
  const keepAwakeStatus = {
    mode: "whileAgentsRun",
    keepDisplayAwake: false,
    state: "active",
    eligibleAgentCount: 1,
    reason: null,
    expiresAtEpochMs: null,
    limitations: ["lidClose"],
  };
  assert.equal(validateMethodResult("system.keepAwake.get", keepAwakeStatus), true);
  // `reason` is required-nullable: omitting it entirely is not the same as
  // reporting "no reason", so the DTO must reject the missing field.
  const { reason: _omitted, ...withoutReason } = keepAwakeStatus;
  assert.equal(validateMethodResult("system.keepAwake.get", withoutReason), false);
  assert.equal(
    validateMethodResult("system.keepAwake.set", { ...keepAwakeStatus, state: "unsupported", reason: "unsupportedPlatform" }),
    true,
  );
  assert.equal(validateMethodResult("system.keepAwake.set", { ...keepAwakeStatus, mode: "sometimes" }), false);
});

test("remote skill creation is bounded and full-control only", () => {
  assert.ok(READ_ONLY_METHODS.includes("skill.catalogGet"));
  assert.ok(!READ_ONLY_METHODS.includes("skill.definitionCreate"));
  assert.equal(validateMethodResult("skill.definitionCreate", {
    skills: [], warnings: [], projectIncluded: false, projectName: null,
    providerSnapshotIncluded: false, managerAvailable: true,
  }), true);
});

test("Context Bank projections are strict, bounded, and full-control only", () => {
  const catalog = {
    projectName: "TermLoop",
    truncated: false,
    warnings: [],
    siblingConflicts: [{
      id: "c".repeat(64),
      directoryPath: "apps/server",
      fileIds: ["a".repeat(64), "d".repeat(64)],
    }],
    files: [{
      id: "a".repeat(64),
      relativePath: "apps/server/AGENTS.md",
      kind: "agents",
      lineCount: 42,
      lineLimit: 100,
      overLimit: false,
      isSymlink: false,
      symlinkTargetPath: null,
    }],
  };
  assert.equal(validateMethodResult("contextBank.catalogGet", catalog), true);
  assert.equal(validateMethodResult("contextBank.catalogGet", {
    ...catalog,
    files: [{ ...catalog.files[0], id: "/project/AGENTS.md" }],
  }), false);
  assert.equal(validateMethodResult("contextBank.siblingConflictResolve", catalog), true);
  assert.equal(validateMethodResult("contextBank.catalogGet", {
    ...catalog,
    siblingConflicts: [{ ...catalog.siblingConflicts[0], fileIds: ["a".repeat(64)] }],
  }), false);
  assert.equal(validateMethodResult("contextBank.catalogGet", {
    ...catalog,
    files: [{ ...catalog.files[0], unknown: true }],
  }), false);

  const file = {
    fileId: "a".repeat(64),
    relativePath: "apps/server/AGENTS.md",
    path: "/project/apps/server/AGENTS.md",
    kind: "agents",
    content: "# Server rules\n",
    contentSha256: "b".repeat(64),
    lineCount: 2,
    lineLimit: 100,
    isSymlink: false,
    symlinkTargetPath: null,
    editable: true,
  };
  assert.equal(validateMethodResult("contextBank.fileGet", file), true);
  assert.equal(validateMethodResult("contextBank.fileSave", file), true);
  assert.equal(validateMethodResult("contextBank.fileGet", { ...file, kind: "cursor" }), false);
  assert.equal(validateMethodResult("contextBank.fileSave", { ...file, content: "x".repeat(524289) }), false);
  for (const method of ["contextBank.catalogGet", "contextBank.fileGet", "contextBank.fileSave", "contextBank.siblingConflictResolve"]) {
    assert.ok(!READ_ONLY_METHODS.includes(method));
    assert.ok(!COMPANION_METHODS.includes(method));
  }
});

test("MCP tool settings projection is closed, bounded, and revisioned", () => {
  const roleSets = [
    [new Set(MCP_INTERACTIVE_TOOLS), "interactive"],
    [new Set(MCP_IMPROVER_TOOLS), "improver"],
    [new Set(MCP_HELPER_TOOLS), "helper"],
    [new Set(MCP_STEWARD_TOOLS), "steward"],
  ];
  const result = {
    stateRevision: 7,
    tools: MCP_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      title: tool.annotations.title,
      canonicalDescription: tool.description,
      effectiveDescription: tool.name === "ask_to" ? "Customized description" : tool.description,
      customized: tool.name === "ask_to",
      roles: roleSets.filter(([names]) => names.has(tool.name)).map(([, role]) => role),
    })),
  };
  assert.equal(validateMethodResult("mcp.toolSettingsGet", result), true);
  assert.equal(validateMethodResult("mcp.toolDescriptionUpdate", result), true);
  assert.equal(validateMethodResult("mcp.toolSettingsGet", {
    ...result,
    tools: [{ ...result.tools[0], name: "unknown" }, ...result.tools.slice(1)],
  }), false);
  assert.equal(validateMethodResult("mcp.toolSettingsGet", {
    ...result,
    tools: [{ ...result.tools[0], effectiveDescription: "x".repeat(4097) }, ...result.tools.slice(1)],
  }), false);
});

test("Quick Action contract is strict, versioned, and full-control only", () => {
  const digest = `sha256:${"0".repeat(64)}`;
  const preview = {
    agent_id: "codex", model: "gpt-5.6-sol", permission: "plan", reasoning: "high",
    template_ref: "builtin.quick-action.free-prompt",
    template_version: 2, delivery: "terminalInput", delivered_preview: "Review this diff",
    launch_ticket: "a".repeat(64),
    manifest: {
      digest,
      target: { agent_id: "codex", executable: "codex", model: "gpt-5.6-sol", permission: "plan", reasoning: "high", cwd: "/tmp/project", conversation: "fresh" },
      provenance: { template_ref: "builtin.quick-action.free-prompt", template_version: 2, authored_digest: digest, delivered_digest: digest },
      content_parts: [{ id: "first-message", kind: "firstMessage", source: "template", scope: "launch", delivery: "terminalInput", content: "Review this diff", byte_length: 16, digest }],
      transport: { kind: "terminalInput", delivered_content: "Review this diff", byte_length: 16, digest },
      arguments: [], environment: [], generated_files: [], limitations: [],
    },
  };
  assert.equal(validateMethodResult("quickAction.preview", preview), true);
  assert.equal(validateMethodResult("quickAction.preview", {
    ...preview,
    manifest: {
      ...preview.manifest,
      arguments: [{
        position: 1,
        display: "<redacted Quick Action image path>",
        visibility: "redacted",
        classification: "sensitivePath",
        purpose: "Quick Action image attachment",
      }],
    },
  }), true);
  assert.equal(validateMethodResult("quickAction.preview", { ...preview, delivery: "initialArgument" }), false);
  assert.ok(!READ_ONLY_METHODS.includes("quickAction.preview"));
  assert.ok(!READ_ONLY_METHODS.includes("quickAction.launch"));
});

test("assistant prompt previews accept large Routine Builder content and remain bounded", () => {
  const digest = `sha256:${"0".repeat(64)}`;
  const delivered = "x".repeat(256 * 1024);
  const preview = {
    agent_id: "codex", model: "gpt-5.6-sol", permission: "plan", reasoning: "high",
    template_ref: "builtin.builder.routine",
    template_version: 1, delivery: "terminalInput", delivered_preview: delivered,
    launch_ticket: "a".repeat(64),
    manifest: {
      digest,
      target: { agent_id: "codex", executable: "codex", model: "gpt-5.6-sol", permission: "plan", reasoning: "high", cwd: "/tmp/project", conversation: "fresh" },
      provenance: { template_ref: "builtin.builder.routine", template_version: 1, authored_digest: digest, delivered_digest: digest },
      content_parts: [{ id: "first-message", kind: "firstMessage", source: "resources/prompts/builtin.builder.routine", scope: "launch", delivery: "terminalInput", content: delivered, byte_length: delivered.length, digest }],
      transport: { kind: "terminalInput", delivered_content: delivered, byte_length: delivered.length, digest },
      arguments: [], environment: [], generated_files: [], limitations: [],
    },
  };
  assert.equal(validateMethodResult("assistantPrompt.improvePreview", preview), true);

  const oversized = "x".repeat(256 * 1024 + 1);
  assert.equal(validateMethodResult("assistantPrompt.improvePreview", {
    ...preview,
    manifest: {
      ...preview.manifest,
      content_parts: [{ ...preview.manifest.content_parts[0], content: oversized }],
    },
  }), false);
  assert.equal(validateMethodResult("assistantPrompt.improvePreview", {
    ...preview,
    manifest: {
      ...preview.manifest,
      transport: { ...preview.manifest.transport, delivered_content: oversized },
    },
  }), false);
});

test("PR change content is strict, provider-discriminated, and full-control only", () => {
  const githubParams = {
    taskId: "task-1", expectedFreshnessGeneration: 7,
    pullRequest: { provider: "github", repository_owner: "acme", repository_project: null, repository_name: "widget", number: 42 },
  };
  const azureParams = {
    ...githubParams,
    pullRequest: { provider: "azureDevOps", repository_owner: "valuespaces", repository_project: "Nucleus", repository_name: "Nucleus", number: 13632 },
  };
  const available = {
    task_id: "task-1", pull_request: githubParams.pullRequest, state: "available", reason: null,
    observation_id: "prc-1-1", truncated: false,
    entries: [{ entry_id: "e-0", display_path: "src/main.rs", original_display_path: null, path_encoding: "utf8", kind: "modified", render_state: "available" }],
  };
  assert.equal(validateMethodResult("gitHost.pullRequestChangeList", available), true);
  assert.equal(validateMethodResult("gitHost.pullRequestChangeList", { ...available, pull_request: azureParams.pullRequest }), true);
  assert.equal(validateMethodResult("gitHost.pullRequestChangeList", { ...available, pull_request: { ...githubParams.pullRequest, repository_project: "wrong" } }), false);
  assert.equal(validateMethodResult("gitHost.pullRequestChangeList", { ...available, pull_request: { ...azureParams.pullRequest, repository_project: null } }), false);
  assert.equal(validateMethodResult("gitHost.pullRequestDiff", {
    task_id: "task-1", observation_id: "prc-1-1", entry_id: "e-0", state: "patch", reason: null,
    patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
  }), true);
  assert.equal(validateMethodResult("gitHost.pullRequestDiff", {
    task_id: "task-1", observation_id: "prc-1-1", entry_id: "e-0", state: "unavailable", reason: "changed", patch: null,
  }), true);
});

test("branch commit summaries are strict, bounded, and full-control only", () => {
  const result = [{
    task_id: "task-1", count: 6, base_ref: "refs/remotes/origin/main",
    not_in_base: { count: 2, base_ref: "refs/remotes/origin/main", freshness: "fresh", reason: null },
    freshness: "fresh", reason: null,
  }];
  assert.equal(validateMethodResult("task.branchCommitSummaryList", result), true);
  assert.equal(validateMethodResult("task.branchCommitSummaryList", [{ ...result[0], count: -1 }]), false);
  assert.equal(validateMethodResult("task.branchCommitSummaryList", [{ ...result[0], not_in_base: { ...result[0].not_in_base, count: -1 } }]), false);
  assert.equal(validateMethodResult("task.branchCommitSummaryList", [{ ...result[0], observed_at_epoch_ms: 1 }]), false);
  assert.equal(validateMethodResult("task.branchCommitSummaryList", [{
    task_id: "task-2", count: null, base_ref: null,
    not_in_base: { count: null, base_ref: null, freshness: "unavailable", reason: "ambiguousRemote" },
    freshness: "unavailable", reason: "ambiguousRemote",
  }]), true);
});

test("generated client preserves provisioning recovery details", async () => {
  const listeners = new Map();
  const client = new TermLoopControlClient("ws://127.0.0.1/control", "x".repeat(64), () => {
    const socket = {
      addEventListener(type, listener) { listeners.set(type, listener); },
      send(raw) {
        const request = JSON.parse(raw);
        queueMicrotask(() => listeners.get("message")?.({ data: JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: "conflict", message: "opaque", details: { kind: "worktreeRecoveryAttention", operationId: "operation-1" } },
        }) }));
      },
      close() {},
    };
    queueMicrotask(() => listeners.get("open")?.({}));
    return socket;
  });
  await assert.rejects(
    client.call("task.provisionWorktree", {
      operationId: "11111111-1111-4111-8111-111111111111",
      taskId: "task-1",
      repositoryPath: "/repo",
      destinationPath: "/repo-feature",
      branchName: "feature/api",
      branchMode: "existing",
    }),
    (error) => error instanceof TermLoopControlError
      && error.details?.kind === "worktreeRecoveryAttention"
      && error.details.operationId === "operation-1",
  );
});

test("destructive cleanup requests outlive the bounded Git mutation", () => {
  assert.equal(controlRequestTimeoutMs("task.cleanupWorktree"), 300_000);
  assert.equal(controlRequestTimeoutMs("task.discardStaleWorktree"), 300_000);
  assert.equal(controlRequestTimeoutMs("task.inspectWorktreeCleanup"), 12_000);
  assert.equal(controlRequestTimeoutMs("project.list"), 12_000);
});

test("Jira provider requests outlive their bounded HTTP timeout", () => {
  assert.equal(controlRequestTimeoutMs("taskSource.boardList"), 300_000);
  assert.equal(controlRequestTimeoutMs("taskSource.boardListStored"), 300_000);
  assert.equal(controlRequestTimeoutMs("taskSource.statusList"), 300_000);
  assert.equal(controlRequestTimeoutMs("taskSource.statusListStored"), 300_000);
  assert.equal(controlRequestTimeoutMs("taskSource.refresh"), 300_000);
});

test("atomic Playbook replacement outlives routine reconciliation and durable commit", () => {
  assert.equal(controlRequestTimeoutMs("playbook.update"), 300_000);
  assert.equal(controlRequestTimeoutMs("playbook.get"), 12_000);
});

test("Session relocation is strict, full-control, and long-running", () => {
  assert.ok(METHODS.includes("session.previewRelocateAgentToTask"));
  assert.ok(METHODS.includes("session.relocateAgentToTask"));
  assert.ok(!READ_ONLY_METHODS.includes("session.previewRelocateAgentToTask"));
  assert.ok(!READ_ONLY_METHODS.includes("session.relocateAgentToTask"));
  assert.equal(controlRequestTimeoutMs("session.previewRelocateAgentToTask"), 12_000);
  assert.equal(controlRequestTimeoutMs("session.relocateAgentToTask"), 300_000);
  assert.ok(METHODS.includes("session.previewRelocateAgentToProject"));
  assert.ok(METHODS.includes("session.relocateAgentToProject"));
  assert.ok(!READ_ONLY_METHODS.includes("session.previewRelocateAgentToProject"));
  assert.ok(!READ_ONLY_METHODS.includes("session.relocateAgentToProject"));
  assert.equal(controlRequestTimeoutMs("session.previewRelocateAgentToProject"), 12_000);
  assert.equal(controlRequestTimeoutMs("session.relocateAgentToProject"), 300_000);
});

test("generated client preserves typed conflict details", async () => {
  const socketFactory = () => {
    const listeners = new Map();
    const socket = {
      addEventListener(type, listener) { listeners.set(type, listener); },
      send(raw) {
        const request = JSON.parse(raw);
        queueMicrotask(() => listeners.get("message")?.({
          data: JSON.stringify({
            id: request.id,
            ok: false,
            error: {
              code: "conflict",
              message: "branch held",
              details: { kind: "branchHeldByTask", taskId: "holder-task" },
            },
          }),
        }));
      },
      close() {},
    };
    queueMicrotask(() => listeners.get("open")?.({}));
    return socket;
  };
  const client = new TermLoopControlClient("ws://127.0.0.1/control", "x".repeat(64), socketFactory);
  await assert.rejects(
    client.call("task.bindBranch", { taskId: "target", repositoryPath: "/repo", branchName: "main" }),
    (error) => error instanceof TermLoopControlError
      && error.code === "conflict"
      && error.details?.kind === "branchHeldByTask"
      && error.details.taskId === "holder-task",
  );
});

test("generated client maps a method to its params and result", async () => {
  let sent;
  const socketFactory = () => {
    const listeners = new Map();
    const socket = {
      addEventListener(type, listener) { listeners.set(type, listener); },
      send(raw) {
        sent = JSON.parse(raw);
        queueMicrotask(() => listeners.get("message")?.({
          data: JSON.stringify({
            id: sent.id,
            ok: true,
            result: { id: "p1", name: sent.params.name, folder_path: sent.params.folderPath },
          }),
        }));
      },
      close() {},
    };
    queueMicrotask(() => listeners.get("open")?.({}));
    return socket;
  };
  const client = new TermLoopControlClient("ws://127.0.0.1/control", "x".repeat(64), socketFactory);
  const result = await client.call("project.create", { name: "Demo", folderPath: "/tmp/demo" });
  assert.deepEqual(sent.params, { name: "Demo", folderPath: "/tmp/demo" });
  assert.deepEqual(result, { id: "p1", name: "Demo", folder_path: "/tmp/demo" });
});

test("generated client multiplexes concurrent calls over one socket", async () => {
  const listeners = new Map();
  const sent = [];
  let sockets = 0;
  const client = new TermLoopControlClient(
    "ws://127.0.0.1/control",
    "x".repeat(64),
    () => {
      sockets += 1;
      const socket = {
        addEventListener(type, listener) { listeners.set(type, listener); },
        send(raw) { sent.push(JSON.parse(raw)); },
        close() {},
      };
      queueMicrotask(() => listeners.get("open")?.({}));
      return socket;
    },
  );
  const version = client.call("system.version");
  const ping = client.call("system.ping");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets, 1);
  assert.equal(sent.length, 2);
  const versionRequest = sent.find((request) => request.method === "system.version");
  const pingRequest = sent.find((request) => request.method === "system.ping");
  listeners.get("message")?.({ data: JSON.stringify({ id: pingRequest.id, ok: true, result: { pong: true } }) });
  listeners.get("message")?.({ data: JSON.stringify({
    id: versionRequest.id,
    ok: true,
    result: { product: "TermLoop", version: "1", protocolVersion: CONTRACT_IDENTITY },
  }) });
  assert.deepEqual(await ping, { pong: true });
  assert.equal((await version).version, "1");
  client.close();
});

test("generated client rejects malformed frames and reconnects cleanly", async () => {
  const sockets = [];
  const client = new TermLoopControlClient(
    "ws://127.0.0.1/control",
    "x".repeat(64),
    () => {
      const listeners = new Map();
      const socket = {
        addEventListener(type, listener) { listeners.set(type, listener); },
        send(raw) { socket.sent.push(JSON.parse(raw)); },
        close() {},
        listeners,
        sent: [],
      };
      sockets.push(socket);
      queueMicrotask(() => listeners.get("open")?.({}));
      return socket;
    },
  );

  const malformed = client.call("system.ping");
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0].listeners.get("message")?.({ data: "null" });
  await assert.rejects(malformed, /invalid control response/);

  const recovered = client.call("system.ping");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2);
  const request = sockets[1].sent[0];
  sockets[1].listeners.get("message")?.({
    data: JSON.stringify({ id: request.id, ok: true, result: { pong: true } }),
  });
  await assert.doesNotReject(recovered);
  client.close();
});

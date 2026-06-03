// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct TermLoopWorkspaceWorktreeBinding: Sendable {
    let projectId: UUID
    let expectation: TermLoopWorktreeExpectation
    let baselineHead: String?

    var branch: String { expectation.branch }
    var path: String { expectation.path }
    var environment: [String: String] { expectation.environment }
}

struct TermLoopWorkspaceCreateContext: Sendable {
    let projectId: UUID?
    let launchEnvironment: [String: String]
    let worktreeBinding: TermLoopWorkspaceWorktreeBinding?
}

/// Hook file for TermLoop-owned fields that need to be merged into upstream
/// `TerminalController` payloads. Keeps the fork's socket customizations out
/// of `TerminalController.swift` so upstream diffs stay minimal.
extension TerminalController {
    /// Extra fields that TermLoop contributes to the v2 workspace summary
    /// payload. Called from a marker-wrapped one-liner in
    /// `v2WorkspaceSummaryPayload` via `payload.merge(...)`.
    @MainActor
    func termLoopWorkspaceSummaryFields(for workspace: Workspace) -> [String: Any] {
        termLoopScheduleWorkspaceWorktreeBindingRepairIfNeeded(for: workspace)

        var fields: [String: Any] = [
            "project_id": workspace.projectId?.uuidString as Any? ?? NSNull()
        ]
        if let claude = WorkspaceMetadataStore.shared.claudeSession(workspaceId: workspace.id.uuidString) {
            fields["claude_session_id"] = claude.sessionId
            fields["claude_cwd"] = claude.cwd ?? NSNull()
            fields["claude_running"] = TerminalAgentActivityStore.shared.isAgentRunning(
                forWorkspace: workspace,
                agentId: "claude"
            )
        } else {
            fields["claude_session_id"] = NSNull()
            fields["claude_cwd"] = NSNull()
            fields["claude_running"] = NSNull()
        }
        ClaudeHooksStatus.shared.refreshIfStale()
        fields["claude_hooks_installed"] = ClaudeHooksStatus.shared.installed

        let branch = WorkspaceMetadataStore.shared.branch(for: workspace)
        fields["branch"] = branch as Any? ?? NSNull()
        if branch != nil,
           let path = workspace.termLoopPresentationCwd() {
            fields["worktree_path"] = path
        } else {
            fields["worktree_path"] = NSNull()
        }
        let gitChanges = workspace.aggregatedGitChanges()
        fields["git_dirty"] = (gitChanges?.count ?? 0) > 0
        fields["git_change_count"] = gitChanges?.count ?? 0
        fields["pull_requests"] = TermLoopMobilePullRequestPayloads.openPayloads(
            workspace: workspace,
            directory: workspace.termLoopPresentationCwd(),
            branch: branch,
            reason: "mobile.workspace.summary"
        )
        let md = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspace.id)
        fields["terminal_agent_id"] = md.terminalAgentId as Any? ?? NSNull()
        fields["permission_mode"] = md.permissionMode as Any? ?? NSNull()
        fields["awaiting_input_since"] = md.awaitingInputSince as Any? ?? NSNull()
        fields["last_message_preview"] = md.lastMessagePreview as Any? ?? NSNull()
        fields["last_attention_kind"] = md.lastAttentionKindRaw as Any? ?? NSNull()
        if let activity = TerminalAgentActivityStore.shared.state(forWorkspaceId: workspace.id) {
            fields["agent_activity_phase"] = activity.phase.rawValue
            fields["agent_attention_kind"] = activity.attentionKind?.rawValue as Any? ?? NSNull()
            fields["agent_activity_preview"] = activity.preview as Any? ?? NSNull()
            fields["agent_activity_updated_at"] = activity.updatedAt.timeIntervalSince1970
        } else {
            fields["agent_activity_phase"] = NSNull()
            fields["agent_attention_kind"] = NSNull()
            fields["agent_activity_preview"] = NSNull()
            fields["agent_activity_updated_at"] = NSNull()
        }
        return fields
    }

    func termLoopWorkspaceCreateContext(
        cwd: String?,
        projectId explicitProjectId: UUID?,
        initialEnv: [String: String]
    ) -> TermLoopWorkspaceCreateContext {
        let binding = self.termLoopWorkspaceWorktreeBinding(
            cwd: cwd,
            projectId: explicitProjectId
        )
        let launchEnvironment = binding.map { binding in
            initialEnv.merging(binding.environment) { current, _ in current }
        } ?? initialEnv
        return TermLoopWorkspaceCreateContext(
            projectId: binding?.projectId,
            launchEnvironment: launchEnvironment,
            worktreeBinding: binding
        )
    }

    func termLoopPrepareWorkspaceAgentLaunch(
        terminalAgentId: String?,
        cwd: String?,
        context: TermLoopWorkspaceCreateContext,
        promptText: String? = nil,
        permissionModeRaw: String? = nil
    ) throws -> TerminalAgentLifecycle.PreparedFreshWorkspaceLaunch? {
        guard let id = terminalAgentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty,
              let agent = TerminalAgentRegistry.shared.agent(id: id) else {
            return nil
        }
        let permissionMode = try TermLoopSocketAgentLaunchInput.permissionMode(rawValue: permissionModeRaw)
        let plan = try TermLoopSocketAgentLaunchInput.invocationPlan(
            agentId: agent.id,
            promptText: promptText,
            projectId: context.projectId,
            cwd: cwd,
            branch: context.worktreeBinding?.branch,
            permissionMode: permissionMode,
            reasonTag: "mobile.workspace.create"
        )
        if let plan {
            ProjectSkillMaterializer.materializeForLaunch(plan)
        }
        return try TerminalAgentLifecycle.prepareFreshWorkspaceLaunch(
            agent: agent,
            cwd: cwd,
            worktreeExpectation: context.worktreeBinding?.expectation,
            baselineHead: context.worktreeBinding?.baselineHead,
            baseEnv: context.launchEnvironment,
            initialPrompt: plan?.resolvedPromptBody ?? "",
            permission: plan?.resolvedPermission,
            systemPrompt: plan?.launchSystemInstructions,
            model: plan?.resolvedModel,
            reasoning: plan?.resolvedReasoning,
            launchProvidedFullContext: plan?.launchProvidedFullContext ?? false
        )
    }

    @MainActor
    func termLoopApplyWorkspaceCreateContext(
        _ context: TermLoopWorkspaceCreateContext,
        to workspace: Workspace
    ) {
        guard let binding = context.worktreeBinding else { return }
        termLoopApplyWorkspaceWorktreeBinding(binding, to: workspace)
    }

    @MainActor
    func termLoopFinishWorkspaceAgentLaunch(
        _ launch: TerminalAgentLifecycle.PreparedFreshWorkspaceLaunch,
        workspace: Workspace
    ) {
        TerminalAgentLifecycle.attachFreshLaunchToCreatedWorkspace(
            launch,
            to: workspace
        )
    }

    @MainActor
    func termLoopFinishWorkspaceCreate(
        launch: TerminalAgentLifecycle.PreparedFreshWorkspaceLaunch?,
        context: TermLoopWorkspaceCreateContext,
        workspace: Workspace
    ) {
        if let launch {
            termLoopFinishWorkspaceAgentLaunch(launch, workspace: workspace)
        } else {
            termLoopApplyWorkspaceCreateContext(context, to: workspace)
        }
    }

    func termLoopWorkspaceWorktreeBinding(
        cwd: String?,
        projectId explicitProjectId: UUID?
    ) -> TermLoopWorkspaceWorktreeBinding? {
        guard let rawCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawCwd.isEmpty else {
            return nil
        }
        let normalizedCwd = URL(fileURLWithPath: rawCwd)
            .standardizedFileURL.path
        let projectStore = ProjectStore.shared
        let project = explicitProjectId.flatMap { projectStore.project(id: $0) }
            ?? projectStore.project(containingPath: normalizedCwd)
        guard let project else { return nil }
        let worktreeRoot = WorktreeResolver.worktreeRoot(
            containing: normalizedCwd,
            projectFolder: project.folderPath
        )
        guard let worktreeRoot else { return nil }

        if let snapshot = WorktreeRegistry.shared.cachedSnapshot(
            projectFolder: project.folderPath,
            maximumAge: 60
        ) {
            if let binding = TermLoopWorkspaceWorktreeBindingResolver.resolve(
                worktreeRoot: worktreeRoot,
                projectId: project.id,
                projectFolder: project.folderPath,
                entries: snapshot.entries
            ) {
                return binding
            }
        }

        // Socket-driven workspace creation runs off the main thread before the
        // `v2MainSync` workspace mutation. Warm the registry synchronously
        // here when the cache is cold or stale for this path, so the agent
        // process gets TERMLOOP_WORKTREE_* on its first launch instead of
        // relying on the later summary repair pass. Never shell out on the
        // main thread; UI callers get an async refresh and a conservative nil
        // binding until the cache is warm.
        guard !Thread.isMainThread else {
            WorktreeRegistry.shared.refresh(
                projectFolder: project.folderPath,
                reason: "workspaceCreateBinding"
            )
            return nil
        }

        do {
            let entries = try GitWorktreeService().list(in: project.folderPath)
            WorktreeRegistry.shared.record(projectFolder: project.folderPath, entries: entries)
            return TermLoopWorkspaceWorktreeBindingResolver.resolve(
                worktreeRoot: worktreeRoot,
                projectId: project.id,
                projectFolder: project.folderPath,
                entries: entries
            )
        } catch {
            WorktreeRegistry.shared.refresh(
                projectFolder: project.folderPath,
                reason: "workspaceCreateBinding.retry"
            )
            return nil
        }
    }

    @MainActor
    func termLoopScheduleWorkspaceWorktreeBindingRepairIfNeeded(
        for workspace: Workspace
    ) {
        guard WorkspaceMetadataStore.shared.branch(for: workspace) == nil else {
            return
        }
        let cwd = workspace.currentDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard WorktreeResolver.worktreeRoot(containing: cwd) != nil else {
            return
        }
        let projectStore = ProjectStore.shared
        let project = workspace.projectId.flatMap { projectStore.project(id: $0) }
            ?? projectStore.project(containingPath: cwd)
        guard let project else {
            return
        }
        TermLoopWorkspaceWorktreeBindingRepairScheduler.schedule(
            workspaceId: workspace.id,
            cwd: cwd,
            projectId: project.id,
            projectFolder: project.folderPath
        )
    }

    @MainActor
    func termLoopApplyWorkspaceWorktreeBinding(
        _ binding: TermLoopWorkspaceWorktreeBinding,
        to workspace: Workspace
    ) {
        let metadata = WorkspaceMetadataStore.shared
        metadata.setProjectId(binding.projectId, for: workspace)
        metadata.setBranch(binding.branch, worktreePath: binding.path, for: workspace)
        metadata.setWorktreeBaselineHead(
            binding.baselineHead,
            forWorkspaceId: workspace.id
        )
    }

    @MainActor
    func termLoopWorkspaceGitChangesPayload(for workspace: Workspace) -> [String: Any] {
        let branch = WorkspaceMetadataStore.shared.branch(for: workspace)
        let worktreePath: String? = {
            guard branch != nil else {
                return nil
            }
            return workspace.termLoopPresentationCwd()
        }()
        let changes = workspace.aggregatedGitChanges()
        return [
            "workspace_id": workspace.id.uuidString,
            "title": workspace.title,
            "branch": branch as Any? ?? NSNull(),
            "worktree_path": worktreePath as Any? ?? NSNull(),
            "git_dirty": (changes?.count ?? 0) > 0,
            "git_change_count": changes?.count ?? 0,
            "files": changes?.files.map { file in
                [
                    "path": file.path,
                    "status": file.status.rawValue
                ]
            } ?? []
        ]
    }

    func termLoopWorkspaceGitChangesPayload(
        worktreePath: String,
        title: String?,
        branch: String?
    ) -> [String: Any] {
        let normalizedPath = URL(fileURLWithPath: worktreePath).standardizedFileURL.path
        let files = GitWorktreePresentationStore.shared.files(for: normalizedPath)
        let trimmedBranch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedBranch = (trimmedBranch?.isEmpty == true ? nil : trimmedBranch)
            ?? GitWorktreePresentationStore.shared.branch(for: normalizedPath)
        return [
            "workspace_id": NSNull(),
            "title": title as Any? ?? NSNull(),
            "branch": resolvedBranch as Any? ?? NSNull(),
            "worktree_path": normalizedPath,
            "git_dirty": !files.isEmpty,
            "git_change_count": files.count,
            "files": files.map { file in
                [
                    "path": file.path,
                    "status": file.status.rawValue
                ]
            }
        ]
    }

    @MainActor
    func termLoopWorkspaceMatchingWorktreePath(
        _ worktreePath: String,
        tabManager: TabManager
    ) -> Workspace? {
        let requested = URL(fileURLWithPath: worktreePath).standardizedFileURL.path
        return tabManager.tabs.first { workspace in
            [
                WorkspaceMetadataStore.shared.worktreePath(forWorkspaceId: workspace.id),
                workspace.termLoopPresentationCwd(),
                workspace.currentDirectory
            ]
            .compactMap { $0 }
            .map { URL(fileURLWithPath: $0).standardizedFileURL.path }
            .contains(requested)
        }
    }

    func termLoopWorkspaceGitChangesPayloadAddingPatches(
        _ payload: [String: Any],
        filePath: String?,
        maxPatchBytes: Int?
    ) -> [String: Any] {
        TermLoopMobileGitDiffPayload.addPatches(
            to: payload,
            filePath: filePath,
            maxPatchBytes: maxPatchBytes
        )
    }
}

@MainActor
enum TermLoopMobilePullRequestPayloads {
    static func openPayloads(
        workspace: Workspace? = nil,
        directory: String?,
        branch: String?,
        reason: String
    ) -> [[String: Any]] {
        guard let normalized = normalizedInput(directory: directory, branch: branch) else { return [] }
        WorktreeBranchPullRequestStore.shared.ensureLookup(
            directory: normalized.directory,
            branch: normalized.branch,
            reason: reason
        )
        let branchPullRequests = WorktreeBranchPullRequestStore.shared.cachedPullRequests(
            directory: normalized.directory,
            branch: normalized.branch
        )
        let workspacePullRequests = workspace?.sidebarPullRequestsInDisplayOrder() ?? []
        return WorktreeAgentsPullRequestSummary
            .orderedUniquePullRequests(from: workspacePullRequests + branchPullRequests)
            .filter { $0.status == .open }
            .map(payload(for:))
    }

    private static func normalizedInput(
        directory: String?,
        branch: String?
    ) -> (directory: String, branch: String)? {
        guard let branch else { return nil }
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBranch.isEmpty else { return nil }
        guard let resolved = TaskPathNormalization.resolveDisplayAndKey(directory) else { return nil }
        return (resolved.displayPath, trimmedBranch)
    }

    private static func payload(for pullRequest: SidebarPullRequestState) -> [String: Any] {
        [
            "number": pullRequest.number,
            "label": pullRequest.label,
            "url": pullRequest.url.absoluteString,
            "status": pullRequest.status.rawValue,
            "display_status": pullRequest.displayStatus,
            "status_detail": pullRequest.statusDetail as Any? ?? NSNull(),
            "branch": pullRequest.branch as Any? ?? NSNull(),
            "base_branch": pullRequest.baseBranch as Any? ?? NSNull(),
            "stale": pullRequest.isStale
        ]
    }
}

private enum TermLoopMobileGitDiffPayload {
    private static let defaultMaxPatchBytes = 200_000
    private static let hardMaxPatchBytes = 1_000_000

    static func addPatches(
        to payload: [String: Any],
        filePath: String?,
        maxPatchBytes requestedMaxPatchBytes: Int?
    ) -> [String: Any] {
        guard let worktreePath = payload["worktree_path"] as? String,
              !worktreePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let files = payload["files"] as? [[String: Any]] else {
            return payload
        }
        let requestedFilePath = filePath?.trimmingCharacters(in: .whitespacesAndNewlines)
        let maxPatchBytes = min(
            max(requestedMaxPatchBytes ?? defaultMaxPatchBytes, 16_000),
            hardMaxPatchBytes
        )
        let nextFiles = files.compactMap { file -> [String: Any]? in
            guard let path = file["path"] as? String, !path.isEmpty else {
                return file
            }
            if let requestedFilePath, !requestedFilePath.isEmpty, requestedFilePath != path {
                return nil
            }
            var next = file
            let status = (file["status"] as? String).flatMap(GitFileStatus.init(rawValue:))
            let patch = unifiedDiff(
                directory: worktreePath,
                relativePath: path,
                status: status,
                maxPatchBytes: maxPatchBytes
            )
            next["binary"] = patch.binary
            next["patch_truncated"] = patch.truncated
            next["additions"] = patch.additions
            next["deletions"] = patch.deletions
            next["hunks"] = patch.hunks
            return next
        }
        var nextPayload = payload
        nextPayload["files"] = nextFiles
        return nextPayload
    }

    private static func unifiedDiff(
        directory: String,
        relativePath: String,
        status: GitFileStatus?,
        maxPatchBytes: Int
    ) -> PatchPayload {
        let output: String?
        if status == .untracked {
            output = synthesizeAdditionPatch(
                directory: directory,
                relativePath: relativePath,
                maxPatchBytes: maxPatchBytes
            )
        } else {
            output = gitDiff(directory: directory, relativePath: relativePath)
        }
        guard let output else { return .empty }
        let truncated = output.utf8.count > maxPatchBytes
        let limited = truncated ? byteLimitedPrefix(output, maxBytes: maxPatchBytes) : output
        let parsed = parseUnifiedDiff(limited)
        return PatchPayload(
            binary: parsed.binary,
            truncated: truncated,
            additions: parsed.additions,
            deletions: parsed.deletions,
            hunks: parsed.hunks
        )
    }

    private static func gitDiff(directory: String, relativePath: String) -> String? {
        for arguments in [
            ["diff", "--no-ext-diff", "--find-renames", "HEAD", "--", relativePath],
            ["diff", "--no-ext-diff", "--find-renames", "--", relativePath],
            ["diff", "--no-ext-diff", "--find-renames", "--cached", "--", relativePath]
        ] {
            guard let output = try? GitCommandRunner.runThrowing(
                arguments,
                in: directory,
                kind: .diff,
                caller: "TermLoopMobileGitDiffPayload"
            ) else {
                continue
            }
            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return output
            }
        }
        return nil
    }

    private static func synthesizeAdditionPatch(
        directory: String,
        relativePath: String,
        maxPatchBytes: Int
    ) -> String? {
        let fileURL = URL(fileURLWithPath: directory).appendingPathComponent(relativePath)
        guard let contents = try? String(contentsOf: fileURL, encoding: .utf8) else {
            return "Binary file: \(relativePath)"
        }
        let limitedContents = contents.utf8.count > maxPatchBytes
            ? byteLimitedPrefix(contents, maxBytes: maxPatchBytes)
            : contents
        let lines = limitedContents.components(separatedBy: "\n")
        let body = lines.map { "+" + $0 }.joined(separator: "\n")
        return """
        diff --git a/\(relativePath) b/\(relativePath)
        new file mode 100644
        --- /dev/null
        +++ b/\(relativePath)
        @@ -0,0 +1,\(lines.count) @@
        \(body)
        """
    }

    private static func byteLimitedPrefix(_ value: String, maxBytes: Int) -> String {
        var bytes = 0
        var end = value.startIndex
        while end < value.endIndex {
            let next = value[end]
            let count = String(next).utf8.count
            guard bytes + count <= maxBytes else { break }
            bytes += count
            end = value.index(after: end)
        }
        return String(value[..<end])
    }

    private static func parseUnifiedDiff(_ diff: String) -> ParsedPatch {
        if diff.hasPrefix("Binary file:") || diff.contains("\nBinary files ") {
            return ParsedPatch(binary: true, additions: 0, deletions: 0, hunks: [])
        }
        var hunks: [[String: Any]] = []
        var current: HunkBuilder?
        var additions = 0
        var deletions = 0
        for line in diff.components(separatedBy: "\n") {
            if let header = HunkHeader.parse(line) {
                if let built = current?.build() {
                    hunks.append(built)
                }
                current = HunkBuilder(header: header)
                continue
            }
            guard var builder = current else {
                continue
            }
            if line.hasPrefix("+"), !line.hasPrefix("+++") {
                builder.append(kind: "add", text: String(line.dropFirst()))
                additions += 1
            } else if line.hasPrefix("-"), !line.hasPrefix("---") {
                builder.append(kind: "delete", text: String(line.dropFirst()))
                deletions += 1
            } else if line.hasPrefix(" ") {
                builder.append(kind: "context", text: String(line.dropFirst()))
            } else if line.hasPrefix("\\") {
                builder.append(kind: "meta", text: line)
            }
            current = builder
        }
        if let built = current?.build() {
            hunks.append(built)
        }
        return ParsedPatch(binary: false, additions: additions, deletions: deletions, hunks: hunks)
    }

    private struct PatchPayload {
        let binary: Bool
        let truncated: Bool
        let additions: Int
        let deletions: Int
        let hunks: [[String: Any]]

        static let empty = PatchPayload(
            binary: false,
            truncated: false,
            additions: 0,
            deletions: 0,
            hunks: []
        )
    }

    private struct ParsedPatch {
        let binary: Bool
        let additions: Int
        let deletions: Int
        let hunks: [[String: Any]]
    }

    private struct HunkHeader {
        let oldStart: Int
        let oldLines: Int
        let newStart: Int
        let newLines: Int

        static func parse(_ line: String) -> HunkHeader? {
            guard line.hasPrefix("@@ ") else { return nil }
            let parts = line.split(separator: " ")
            guard parts.count >= 3,
                  let oldRange = parseRange(String(parts[1]).dropFirst()),
                  let newRange = parseRange(String(parts[2]).dropFirst()) else {
                return nil
            }
            return HunkHeader(
                oldStart: oldRange.start,
                oldLines: oldRange.lines,
                newStart: newRange.start,
                newLines: newRange.lines
            )
        }

        private static func parseRange(_ value: Substring) -> (start: Int, lines: Int)? {
            let pieces = value.split(separator: ",", maxSplits: 1, omittingEmptySubsequences: false)
            guard let first = pieces.first,
                  let start = Int(first) else { return nil }
            let lines = pieces.count > 1 ? Int(pieces[1]) ?? 1 : 1
            return (start, lines)
        }
    }

    private struct HunkBuilder {
        let header: HunkHeader
        var oldLine: Int
        var newLine: Int
        var lines: [[String: Any]] = []

        init(header: HunkHeader) {
            self.header = header
            self.oldLine = header.oldStart
            self.newLine = header.newStart
        }

        mutating func append(kind: String, text: String) {
            switch kind {
            case "add":
                lines.append(["kind": kind, "new_line": newLine, "text": text])
                newLine += 1
            case "delete":
                lines.append(["kind": kind, "old_line": oldLine, "text": text])
                oldLine += 1
            case "context":
                lines.append(["kind": kind, "old_line": oldLine, "new_line": newLine, "text": text])
                oldLine += 1
                newLine += 1
            default:
                lines.append(["kind": kind, "text": text])
            }
        }

        func build() -> [String: Any] {
            [
                "old_start": header.oldStart,
                "old_lines": header.oldLines,
                "new_start": header.newStart,
                "new_lines": header.newLines,
                "lines": lines
            ]
        }
    }
}

private enum TermLoopWorkspaceWorktreeBindingResolver {
    static func resolve(
        worktreeRoot: String,
        projectId: UUID,
        projectFolder: String,
        entries: [GitWorktreeService.ListEntry]
    ) -> TermLoopWorkspaceWorktreeBinding? {
        guard let normalizedRoot = WorktreeResolver.worktreeRoot(
            containing: worktreeRoot,
            projectFolder: projectFolder
        ) else {
            return nil
        }

        guard let entry = entries.first(where: { entry in
            URL(fileURLWithPath: entry.path).standardizedFileURL.path == normalizedRoot
        }), !entry.isMain else {
            return nil
        }

        let branch = entry.branch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !branch.isEmpty else { return nil }
        let head = entry.head.trimmingCharacters(in: .whitespacesAndNewlines)

        return TermLoopWorkspaceWorktreeBinding(
            projectId: projectId,
            expectation: TermLoopWorktreeExpectation(path: normalizedRoot, branch: branch),
            baselineHead: head.isEmpty ? nil : head
        )
    }
}

private enum TermLoopWorkspaceWorktreeBindingRepairScheduler {
    private static let lock = NSLock()
    private static var lastAttemptByKey: [String: Date] = [:]
    private static let retryInterval: TimeInterval = 30

    static func schedule(
        workspaceId: UUID,
        cwd: String,
        projectId: UUID,
        projectFolder: String
    ) {
        guard let worktreeRoot = WorktreeResolver.worktreeRoot(
            containing: cwd,
            projectFolder: projectFolder
        ) else {
            return
        }
        let key = "\(workspaceId.uuidString)|\(worktreeRoot)|\(projectId.uuidString)"
        let now = Date()
        lock.lock()
        if let last = lastAttemptByKey[key],
           now.timeIntervalSince(last) < retryInterval {
            lock.unlock()
            return
        }
        lastAttemptByKey[key] = now
        lock.unlock()

        DispatchQueue.global(qos: .utility).async {
            let entries: [GitWorktreeService.ListEntry]
            do {
                entries = try GitWorktreeService().list(in: projectFolder)
                WorktreeRegistry.shared.record(projectFolder: projectFolder, entries: entries)
            } catch {
                return
            }
            guard let binding = TermLoopWorkspaceWorktreeBindingResolver.resolve(
                worktreeRoot: worktreeRoot,
                projectId: projectId,
                projectFolder: projectFolder,
                entries: entries
            ) else {
                return
            }
            Task { @MainActor in
                let metadata = WorkspaceMetadataStore.shared
                guard metadata.metadata(forWorkspaceId: workspaceId).branch == nil else {
                    return
                }
                metadata.setProjectId(binding.projectId, forWorkspaceId: workspaceId)
                metadata.setBranch(
                    binding.branch,
                    worktreePath: binding.path,
                    forWorkspaceId: workspaceId
                )
                metadata.setWorktreeBaselineHead(
                    binding.baselineHead,
                    forWorkspaceId: workspaceId
                )
            }
        }
    }
}

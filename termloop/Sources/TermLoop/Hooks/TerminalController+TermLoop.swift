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

    @MainActor
    func termLoopApplyWorkspaceCreateContext(
        _ context: TermLoopWorkspaceCreateContext,
        to workspace: Workspace
    ) {
        guard let binding = context.worktreeBinding else { return }
        termLoopApplyWorkspaceWorktreeBinding(binding, to: workspace)
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

        return TermLoopWorkspaceWorktreeBindingResolver.resolve(
            worktreeRoot: worktreeRoot,
            projectId: project.id,
            projectFolder: project.folderPath
        )
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
}

private enum TermLoopWorkspaceWorktreeBindingResolver {
    static func resolve(
        worktreeRoot: String,
        projectId: UUID,
        projectFolder: String
    ) -> TermLoopWorkspaceWorktreeBinding? {
        guard let normalizedRoot = WorktreeResolver.worktreeRoot(
            containing: worktreeRoot,
            projectFolder: projectFolder
        ) else {
            return nil
        }
        guard let gitDirectory = gitDirectory(forWorktreeRoot: normalizedRoot),
              let head = headReference(in: gitDirectory),
              let branch = branchName(fromHead: head) else {
            return nil
        }
        return TermLoopWorkspaceWorktreeBinding(
            projectId: projectId,
            expectation: TermLoopWorktreeExpectation(path: normalizedRoot, branch: branch),
            baselineHead: headRevision(branch: branch, gitDirectory: gitDirectory)
        )
    }

    private static func gitDirectory(forWorktreeRoot root: String) -> URL? {
        let rootURL = URL(fileURLWithPath: root).standardizedFileURL
        let dotGit = rootURL.appendingPathComponent(".git")
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(
            atPath: dotGit.path,
            isDirectory: &isDirectory
        ), isDirectory.boolValue {
            return dotGit.standardizedFileURL
        }

        guard let text = try? String(contentsOf: dotGit, encoding: .utf8),
              let firstLine = text.split(whereSeparator: \.isNewline).first else {
            return nil
        }
        let line = String(firstLine)
        guard line.hasPrefix("gitdir:") else { return nil }
        let rawPath = String(line.dropFirst("gitdir:".count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawPath.isEmpty else { return nil }
        if rawPath.hasPrefix("/") {
            return URL(fileURLWithPath: rawPath).standardizedFileURL
        }
        return rootURL.appendingPathComponent(rawPath).standardizedFileURL
    }

    private static func headReference(in gitDirectory: URL) -> String? {
        let headURL = gitDirectory.appendingPathComponent("HEAD")
        let raw = (try? String(contentsOf: headURL, encoding: .utf8)) ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func branchName(fromHead head: String) -> String? {
        let prefix = "ref: refs/heads/"
        guard head.hasPrefix(prefix) else { return nil }
        let branch = String(head.dropFirst(prefix.count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return branch.isEmpty ? nil : branch
    }

    private static func headRevision(
        branch: String,
        gitDirectory: URL
    ) -> String? {
        let commonDirectory = commonGitDirectory(from: gitDirectory)
        let looseRef = commonDirectory
            .appendingPathComponent("refs/heads")
            .appendingPathComponent(branch)
        if let raw = try? String(contentsOf: looseRef, encoding: .utf8) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return packedRef(
            named: "refs/heads/\(branch)",
            commonDirectory: commonDirectory
        )
    }

    private static func commonGitDirectory(from gitDirectory: URL) -> URL {
        let commonDirURL = gitDirectory.appendingPathComponent("commondir")
        guard let raw = try? String(contentsOf: commonDirURL, encoding: .utf8) else {
            return gitDirectory
        }
        let path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return gitDirectory }
        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path).standardizedFileURL
        }
        return gitDirectory.appendingPathComponent(path).standardizedFileURL
    }

    private static func packedRef(
        named refName: String,
        commonDirectory: URL
    ) -> String? {
        let packedRefsURL = commonDirectory.appendingPathComponent("packed-refs")
        guard let text = try? String(contentsOf: packedRefsURL, encoding: .utf8) else {
            return nil
        }
        for rawLine in text.split(whereSeparator: \.isNewline) {
            if rawLine.hasPrefix("#") || rawLine.hasPrefix("^") { continue }
            let parts = rawLine.split(separator: " ", maxSplits: 1)
            guard parts.count == 2, String(parts[1]) == refName else { continue }
            return String(parts[0])
        }
        return nil
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
            guard let binding = TermLoopWorkspaceWorktreeBindingResolver.resolve(
                worktreeRoot: worktreeRoot,
                projectId: projectId,
                projectFolder: projectFolder
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

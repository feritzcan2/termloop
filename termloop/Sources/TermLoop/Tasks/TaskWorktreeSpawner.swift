// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Atomically prepares a worktree on disk and spawns a fresh workspace
/// rooted at that worktree path. Used by the Tasks UI so task creation
/// never goes through `WorktreeCoordinator.attach`, whose
/// main-to-worktree guard (a protection for already-running main-checkout
/// terminals) would otherwise fire on a freshly-spawned seed workspace.
///
/// The three-step dance — resolve path, create dir, spawn workspace —
/// keeps ghostty happy (it can `cd` to the new path because it already
/// exists) and leaves `WorkspaceMetadataStore` in the same state
/// `WorktreeCoordinator.attach` would.
@MainActor
struct TaskWorktreeSpawner {
    private static let logger = Logger(subsystem: "com.termloop.fork", category: "task-worktree-spawner")

    let tabManager: TabManager
    let service: GitWorktreeService
    let metadata: WorkspaceMetadataStore

    init(
        tabManager: TabManager,
        service: GitWorktreeService = GitWorktreeService(),
        metadata: WorkspaceMetadataStore = .shared
    ) {
        self.tabManager = tabManager
        self.service = service
        self.metadata = metadata
    }

    struct SpawnResult {
        let workspaceId: UUID
        let worktreePath: String
        let createdWorktree: Bool
        let createdBranch: Bool
    }

    enum SpawnError: Error, LocalizedError {
        case invalidBranch
        case pathResolutionFailed
        case missingBaseRef

        var errorDescription: String? {
            switch self {
            case .invalidBranch:
                return "Branch name is empty."
            case .pathResolutionFailed:
                return "Could not resolve worktree path for branch."
            case .missingBaseRef:
                return "Base ref is required when creating a new branch."
            }
        }
    }

    /// Creates (or reuses) a worktree on disk for `branch`, spawns a fresh
    /// workspace with cwd = worktree path, writes metadata, and returns
    /// the new workspace id + resolved worktree path. Skips
    /// `WorktreeCoordinator.attach` so the main-to-worktree guard does
    /// not fire for seed workspaces.
    func spawn(
        project: Project,
        title: String,
        branch: String,
        baseRef: String?,
        createIfMissing: Bool,
        terminalAgentId: String?
    ) throws -> SpawnResult {
        let trimmed = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw SpawnError.invalidBranch }

        // Resolve target worktree path via the same helper the coordinator
        // uses, so sanitization rules stay identical.
        guard let resolvedPath = WorktreeResolver.path(
            projectFolder: project.folderPath,
            branch: trimmed
        ) else {
            throw SpawnError.pathResolutionFailed
        }

        let worktrees = try service.list(in: project.folderPath)
        let effectivePath: String
        let createdWorktree: Bool
        let createdBranch: Bool

        if let main = worktrees.first(where: { $0.isMain }),
           main.branch == trimmed {
            // Branch is the main checkout itself — spawn workspace at the
            // main folder. Main-to-worktree guard is inapplicable because
            // the workspace will be born on main, no transition needed.
            effectivePath = main.path
            createdWorktree = false
            createdBranch = false
        } else if let existing = worktrees.first(where: { $0.branch == trimmed }) {
            // Reuse an existing worktree for this branch.
            effectivePath = existing.path
            createdWorktree = false
            createdBranch = false
        } else {
            let branchExists = try service.branches(in: project.folderPath)
                .contains(where: { $0.name == trimmed })
            if branchExists {
                try service.add(
                    folder: project.folderPath,
                    path: resolvedPath,
                    branch: trimmed
                )
                effectivePath = resolvedPath
                createdWorktree = true
                createdBranch = false
            } else {
                guard createIfMissing else {
                    throw WorktreeError.notFound(what: "branch \(trimmed)")
                }
                try service.addCreatingBranch(
                    folder: project.folderPath,
                    path: resolvedPath,
                    branch: trimmed,
                    baseRef: baseRef ?? "HEAD"
                )
                effectivePath = resolvedPath
                createdWorktree = true
                createdBranch = true
            }
        }

        // Spawn workspace directly at the worktree path. Ghostty can `cd`
        // there cleanly because the directory now exists.
        let ws = tabManager.addWorkspace(
            title: title,
            workingDirectory: effectivePath,
            select: true,
            eagerLoadTerminal: false,
            projectId: project.id,
            taskId: nil,
            terminalAgentId: terminalAgentId
        )

        // Mirror WorktreeCoordinator.attach metadata flips: set branch
        // first (this clears baseline), then set the baseline to the
        // current worktree HEAD so `WorkspaceMetadataStore` ends up in
        // the same state as an attached workspace.
        metadata.setBranch(trimmed, worktreePath: effectivePath, for: ws)
        let head = try? service.headRevision(worktreePath: effectivePath)
        metadata.setWorktreeBaselineHead(head, forWorkspaceId: ws.id)

        // Best-effort: seed Claude session history from the main checkout
        // into the new worktree so any resumed session can find its file.
        // Matches the pattern in WorktreeCoordinator.attach.
        let projectNormalized = URL(fileURLWithPath: project.folderPath)
            .standardizedFileURL.path
        let effectiveNormalized = URL(fileURLWithPath: effectivePath)
            .standardizedFileURL.path
        if projectNormalized != effectiveNormalized {
            let outcome = ClaudeProjectFiles.seedAllSessions(
                fromCwd: project.folderPath,
                toCwd: effectivePath
            )
            if case .failed(let reason) = outcome {
                Self.logger.warning(
                    "TaskWorktreeSpawner: history seed failed ws=\(ws.id.uuidString, privacy: .public) path=\(effectivePath, privacy: .public) reason=\(reason, privacy: .public)"
                )
            }
        }

        return SpawnResult(
            workspaceId: ws.id,
            worktreePath: effectivePath,
            createdWorktree: createdWorktree,
            createdBranch: createdBranch
        )
    }

    /// Best-effort rollback: close the workspace, then remove the worktree
    /// directory if we created it. Matches the recovery path in
    /// `TaskCreationCoordinator.create` when scratchpad seeding or task
    /// persistence fails after a successful spawn.
    func rollback(
        project: Project,
        result: SpawnResult
    ) {
        if let ws = tabManager.tabs.first(where: { $0.id == result.workspaceId }) {
            tabManager.closeWorkspace(ws)
        }
        if result.createdWorktree {
            try? service.remove(
                folder: project.folderPath,
                path: result.worktreePath,
                force: true
            )
        }
    }
}

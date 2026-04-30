// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
final class TaskCreationCoordinator {
    struct Input {
        let projectId: UUID
        let title: String
        let branchMode: BranchMode
        let externalLinkURL: String?
        let helperAgentId: String?
        let terminalAgentId: String?

        enum BranchMode {
            case new(name: String, base: String)
            case existing(name: String)

            var branch: String {
                switch self {
                case .new(let n, _): return n
                case .existing(let n): return n
                }
            }
            var baseRef: String? {
                if case .new(_, let base) = self { return base }
                return nil
            }
            var createIfMissing: Bool {
                if case .new = self { return true }
                return false
            }
        }
    }

    struct PreparedWorkspace {
        let workspaceId: UUID
        let worktreePath: String
        /// True iff the worktree directory was created by this prepare call
        /// (vs. reused because it already existed). Rollback uses this to
        /// decide whether to delete the worktree after a downstream failure.
        let createdWorktree: Bool
    }

    /// Prepares the task workspace atomically: creates/reuses the worktree
    /// on disk AND spawns the seed workspace rooted at the resulting path.
    /// Throws on any failure (partial state must be rolled back by the
    /// implementer before throwing). Replaces the old
    /// `spawnSeedWorkspace` + `attachWorktree` pair so the seed workspace
    /// is never born on the main checkout — which dodges
    /// `WorktreeCoordinator.attach`'s main-to-worktree transition guard.
    typealias PrepareWorkspace = (_ projectId: UUID, _ title: String, _ branch: String, _ baseRef: String?, _ createIfMissing: Bool, _ terminalAgentId: String?) throws -> PreparedWorkspace
    typealias RollbackWorkspace = (_ projectId: UUID, _ prepared: PreparedWorkspace) -> Void
    typealias SetTaskIdOnWorkspace = (_ workspaceId: UUID, _ taskId: UUID) -> Void
    typealias DirtyCheck = (_ projectId: UUID) -> Bool

    private let store: TaskStore
    private let projectRootProvider: (UUID) -> URL
    private let prepareWorkspace: PrepareWorkspace
    private let rollbackWorkspace: RollbackWorkspace
    private let setTaskIdOnWorkspace: SetTaskIdOnWorkspace
    private let dirtyCheck: DirtyCheck

    init(
        store: TaskStore,
        projectRootProvider: @escaping (UUID) -> URL,
        prepareWorkspace: @escaping PrepareWorkspace,
        rollbackWorkspace: @escaping RollbackWorkspace,
        setTaskIdOnWorkspace: @escaping SetTaskIdOnWorkspace,
        dirtyCheck: @escaping DirtyCheck
    ) {
        self.store = store
        self.projectRootProvider = projectRootProvider
        self.prepareWorkspace = prepareWorkspace
        self.rollbackWorkspace = rollbackWorkspace
        self.setTaskIdOnWorkspace = setTaskIdOnWorkspace
        self.dirtyCheck = dirtyCheck
    }

    enum CreationError: Error, LocalizedError {
        case dirtyWorkingTree
        var errorDescription: String? {
            switch self {
            case .dirtyWorkingTree:
                return "Working tree has uncommitted changes. Commit or stash them, then try again."
            }
        }
    }

    func create(input: Input) async throws -> TermLoopTask {
        guard !dirtyCheck(input.projectId) else { throw CreationError.dirtyWorkingTree }

        let taskId = UUID()
        let branch = input.branchMode.branch

        // Atomically create the worktree on disk and spawn the seed
        // workspace rooted at the resulting path. If this throws, nothing
        // to roll back — the implementer is responsible for cleanup.
        let prepared = try prepareWorkspace(
            input.projectId,
            input.title,
            branch,
            input.branchMode.baseRef,
            input.branchMode.createIfMissing,
            input.terminalAgentId
        )

        let scratchpadDir = projectRootProvider(input.projectId)
            .appendingPathComponent(".termloop/tasks/\(taskId.uuidString)")
        do {
            try seedScratchpad(at: scratchpadDir, title: input.title, branch: branch,
                               linkURL: input.externalLinkURL)
        } catch {
            rollbackWorkspace(input.projectId, prepared)
            throw error
        }

        setTaskIdOnWorkspace(prepared.workspaceId, taskId)

        let task = TermLoopTask(
            id: taskId,
            projectId: input.projectId,
            title: input.title,
            branch: branch,
            worktreePath: prepared.worktreePath,
            status: .idle,
            createdAt: Date(),
            updatedAt: Date(),
            externalLink: input.externalLinkURL.flatMap { ExternalLinkParser.parse($0) },
            helperAgentId: input.helperAgentId,
            prInfo: nil,
            mergeState: .empty,
            lastSyncedAt: nil,
            lastSyncError: nil
        )
        do {
            try store.create(task)
        } catch {
            try? FileManager.default.removeItem(at: scratchpadDir)
            rollbackWorkspace(input.projectId, prepared)
            throw error
        }
        return task
    }

    private func seedScratchpad(at dir: URL, title: String, branch: String, linkURL: String?) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("scratchpad.md")
        if FileManager.default.fileExists(atPath: path.path) { return }
        let iso = ISO8601DateFormatter().string(from: Date())
        let linkLine = linkURL.map { "Link: \($0)" } ?? "Link: —"
        let template = """
        # \(title)

        Branch: \(branch)
        Created: \(iso)
        \(linkLine)

        ## Notes
        """
        try template.write(to: path, atomically: true, encoding: .utf8)
    }
}

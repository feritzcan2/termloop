// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Minimal bridge from the lifecycle coordinator's workspace-metadata protocol
/// to the existing `WorkspaceMetadataStore`. v1 supports queries and the
/// branch+path bind path; cleanup goes through the existing branch=nil API.
@MainActor
public final class TaskBoardWorkspaceMetadataBridge: TaskBoundWorkspaceMetadataStoring {
    public static let shared = TaskBoardWorkspaceMetadataBridge()
    private init() {}

    public func setBinding(workspaceId: UUID, branch: String, path: String) throws {
        WorkspaceMetadataStore.shared.setBranch(branch, worktreePath: path, forWorkspaceId: workspaceId)
    }

    public func clearBinding(workspaceId: UUID) throws {
        WorkspaceMetadataStore.shared.setBranch(nil, worktreePath: nil, forWorkspaceId: workspaceId)
    }

    public func workspaceExists(workspaceId: UUID) -> Bool {
        WorkspaceMetadataStore.shared.hasMetadata(forWorkspaceId: workspaceId)
    }
}

@MainActor
public final class TaskBoardWorktreeProvisioner: TaskBoundWorktreeProvisioning {
    public static let shared = TaskBoardWorktreeProvisioner()
    private init() {}

    public func provision(projectRoot: URL, branchHint: String?, allowDirty: Bool) async throws
        -> TaskWorktreeProvisionResult
    {
        let branch = normalizedBranch(branchHint)
        guard let preferredPath = WorktreeResolver.path(projectFolder: projectRoot.path, branch: branch) else {
            throw TaskLifecycleError.provisionFailed("Could not resolve worktree path.")
        }
        guard AppDelegate.shared?.tabManager != nil else {
            throw TaskLifecycleError.provisionFailed(
                String(localized: "tasks.provision.failure.noWindow",
                       defaultValue: "A TermLoop window is required to create the task worktree.",
                       table: "TermLoop")
            )
        }

        let service = GitWorktreeService()
        let existing = try service.existingUsableWorktree(in: projectRoot.path, branch: branch)
        let effectivePath: String
        let createdWorktree: Bool
        if let existing {
            effectivePath = existing.path
            createdWorktree = false
        } else {
            let path = try availableProvisioningPath(preferredPath)
            if !allowDirty {
                guard try service.isClean(worktreePath: projectRoot.path) else {
                    throw TaskLifecycleError.provisionFailed(TaskProvisionFailureReason.dirtySourceCheckout)
                }
            }
            let branchExists = try service.branches(in: projectRoot.path)
                .contains { $0.name == branch }
            if branchExists {
                try service.add(folder: projectRoot.path, path: path, branch: branch)
            } else {
                try service.addCreatingBranch(
                    folder: projectRoot.path,
                    path: path,
                    branch: branch,
                    baseRef: "HEAD"
                )
            }
            effectivePath = path
            createdWorktree = true
        }
        let workspaceId = try workspaceIdForWorktree(
            path: effectivePath,
            branch: branch,
            projectRoot: projectRoot
        )
        WorktreeProjectionStore.shared.refresh(projectFolder: projectRoot.path, reason: "tasks.provision")
        return TaskWorktreeProvisionResult(
            workspaceId: workspaceId,
            branch: branch,
            worktreePath: effectivePath,
            createdWorktree: createdWorktree
        )
    }

    private func availableProvisioningPath(_ preferredPath: String) throws -> String {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: preferredPath) else { return preferredPath }

        for suffix in 2...999 {
            let candidate = "\(preferredPath)-\(suffix)"
            guard fileManager.fileExists(atPath: candidate) else {
                NSLog(
                    "[TaskWorktree] preserving occupied unregistered path preferred=\(preferredPath) fallback=\(candidate)"
                )
                return candidate
            }
        }
        throw TaskLifecycleError.provisionFailed(
            "Could not find a free worktree path next to occupied path \(preferredPath)."
        )
    }

    public func teardown(workspaceId: UUID?, worktreePath: String, projectRoot: URL) async throws {
        if let workspaceId,
           let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) {
            _ = try WorktreeCoordinator.shared.detach(workspace: workspace, prune: .auto)
        } else {
            try GitWorktreeService().remove(folder: projectRoot.path, path: worktreePath)
        }
        WorktreeProjectionStore.shared.refresh(projectFolder: projectRoot.path, reason: "tasks.teardown")
    }

    private func workspaceIdForWorktree(path: String, branch: String, projectRoot: URL) throws -> UUID {
        let projectId = ProjectStore.shared.project(containingPath: projectRoot.path)?.id
            ?? ProjectStore.shared.activeProjectId
        if let existingId = WorkspaceMetadataStore.shared
            .workspaceIds(withWorktreePath: path, projectId: projectId)
            .first(where: { AppDelegate.shared?.workspaceFor(tabId: $0) != nil }) {
            return existingId
        }

        guard let tabManager = AppDelegate.shared?.tabManager else {
            throw TaskLifecycleError.provisionFailed(
                String(localized: "tasks.provision.failure.noWindow",
                       defaultValue: "A TermLoop window is required to create the task worktree.",
                       table: "TermLoop")
            )
        }
        let workspace = tabManager.addWorkspace(
            title: branch,
            workingDirectory: path,
            select: true,
            eagerLoadTerminal: true,
            projectId: projectId
        )
        WorkspaceMetadataStore.shared.setProjectId(projectId, forWorkspaceId: workspace.id)
        WorkspaceMetadataStore.shared.setTerminalAgentId(nil, for: workspace.id)
        WorkspaceMetadataStore.shared.setBranch(branch, worktreePath: path, forWorkspaceId: workspace.id)
        return workspace.id
    }

    private func normalizedBranch(_ value: String?) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "feat/task-\(UUID().uuidString.prefix(4))" : trimmed
    }
}

/// Convenience: build a coordinator for a given store using the v1 bridges.
@MainActor
public extension TaskLifecycleCoordinator {
    static func makeForProject(store: TaskBoardStore) -> TaskLifecycleCoordinator {
        TaskLifecycleCoordinator(
            store: store,
            workspaces: TaskBoardWorkspaceMetadataBridge.shared,
            worktrees: TaskBoardWorktreeProvisioner.shared
        )
    }
}

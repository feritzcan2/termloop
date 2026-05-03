// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop - GPL-3.0-or-later

import Combine
import Foundation

@MainActor
final class SidebarProjectRefreshCoordinator: ObservableObject {
    static let shared = SidebarProjectRefreshCoordinator()

    @Published private(set) var isRefreshing = false

    private let reason = "manualProjectRefresh"
    private var refreshTask: Task<Void, Never>?

    private init() {}

    func refresh(tabManager: TabManager) {
        guard !isRefreshing else { return }

        let snapshot = makeSnapshot(tabManager: tabManager)
        isRefreshing = true

        refreshTask?.cancel()
        refreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            dispatch(snapshot, tabManager: tabManager)
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            isRefreshing = false
            refreshTask = nil
        }
    }

    private func dispatch(_ snapshot: RefreshSnapshot, tabManager: TabManager) {
        SidebarCLIStatusProbe.shared.refreshIfStale(force: true)

        if !snapshot.invalidationTargets.isEmpty {
            GitPresentationInvalidationCenter.invalidate(
                snapshot.invalidationTargets,
                reason: reason,
                source: "SidebarProjectRefreshCoordinator"
            )
        }

        SidebarProjectRefreshBridge.refresh(
            tabManager: tabManager,
            workspaces: snapshot.workspaces,
            reason: reason
        )

        for input in snapshot.pullRequestLookupInputs {
            WorktreeBranchPullRequestStore.shared.ensureLookup(
                directory: input.directory,
                branch: input.branch,
                reason: reason,
                force: true
            )
        }
    }

    private struct RefreshSnapshot {
        let workspaces: [Workspace]
        let invalidationTargets: [GitInvalidationTarget]
        let pullRequestLookupInputs: [WorktreeBranchPullRequestStore.LookupInput]
    }

    private func makeSnapshot(tabManager: TabManager) -> RefreshSnapshot {
        let workspaces = TermLoopSidebar.projectScopedTabs(allTabs: tabManager.tabs)
        let directories = refreshDirectories(for: workspaces)
        let targets = directories.map { GitInvalidationTarget.directory($0) }
        let prInputs = pullRequestLookupInputs(for: workspaces)
        return RefreshSnapshot(
            workspaces: workspaces,
            invalidationTargets: targets,
            pullRequestLookupInputs: prInputs
        )
    }

    private func refreshDirectories(for workspaces: [Workspace]) -> [String] {
        var directories = Set<String>()

        if let activeProjectId = ProjectStore.shared.activeProjectId,
           let project = ProjectStore.shared.project(id: activeProjectId),
           let directory = normalizedDirectory(project.folderPath) {
            directories.insert(directory)
        }

        for workspace in workspaces {
            [
                WorkspaceMetadataStore.shared.worktreeRootPath(forWorkspaceId: workspace.id),
                WorkspaceMetadataStore.shared.worktreePath(for: workspace),
                workspace.termLoopPresentationCwd(),
                workspace.currentDirectory,
            ].compactMap(normalizedDirectory).forEach { directories.insert($0) }

            for directory in workspace.panelDirectories.values.compactMap(normalizedDirectory) {
                directories.insert(directory)
            }
        }

        return directories.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    private func pullRequestLookupInputs(
        for workspaces: [Workspace]
    ) -> [WorktreeBranchPullRequestStore.LookupInput] {
        var inputs = Set<WorktreeBranchPullRequestStore.LookupInput>()
        for workspace in workspaces {
            guard let branch = normalizedBranch(for: workspace),
                  let directory = normalizedDirectory(
                    WorkspaceMetadataStore.shared.worktreeRootPath(forWorkspaceId: workspace.id)
                        ?? WorkspaceMetadataStore.shared.worktreePath(for: workspace)
                        ?? workspace.termLoopPresentationCwd()
                        ?? workspace.currentDirectory
                  ) else { continue }
            inputs.insert(WorktreeBranchPullRequestStore.LookupInput(
                directory: directory,
                branch: branch
            ))
        }
        return inputs.sorted { lhs, rhs in
            if lhs.directory != rhs.directory {
                return lhs.directory.localizedStandardCompare(rhs.directory) == .orderedAscending
            }
            return lhs.branch.localizedStandardCompare(rhs.branch) == .orderedAscending
        }
    }

    private func normalizedBranch(for workspace: Workspace) -> String? {
        let metadataBranch = WorkspaceMetadataStore.shared.branch(for: workspace)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !metadataBranch.isEmpty { return metadataBranch }

        let workspaceBranch = workspace.gitBranch?.branch
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return workspaceBranch.isEmpty ? nil : workspaceBranch
    }

    private func normalizedDirectory(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        let expanded = (trimmed as NSString).expandingTildeInPath
        return URL(fileURLWithPath: expanded).standardizedFileURL.path
    }
}

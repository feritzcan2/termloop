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
        RemoteWorkItemBindingRefreshCoordinator.shared.refresh(
            inputs: snapshot.remoteWorkItemBindings,
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
        let remoteWorkItemBindings: [RemoteWorkItemBindingRefreshCoordinator.Input]
    }

    private func makeSnapshot(tabManager: TabManager) -> RefreshSnapshot {
        let workspaces = TermLoopSidebar.projectScopedTabs(allTabs: tabManager.tabs)
        let directories = refreshDirectories(for: workspaces)
        let targets = directories.map { GitInvalidationTarget.directory($0) }
        let prInputs = pullRequestLookupInputs(for: workspaces)
        let remoteBindings = remoteWorkItemBindings(for: workspaces)
        return RefreshSnapshot(
            workspaces: workspaces,
            invalidationTargets: targets,
            pullRequestLookupInputs: prInputs,
            remoteWorkItemBindings: remoteBindings
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

    private func remoteWorkItemBindings(
        for workspaces: [Workspace]
    ) -> [RemoteWorkItemBindingRefreshCoordinator.Input] {
        var byPath: [String: RemoteWorkItemBindingRefreshCoordinator.Input] = [:]
        let metadata = WorkspaceMetadataStore.shared
        for workspace in workspaces {
            guard let path = metadata.reportedStatePath(
                forWorkspaceId: workspace.id,
                fallbackPath: workspace.termLoopPresentationCwd()
            ) else { continue }
            guard byPath[path] == nil else { continue }
            guard let binding = AgentReportedStateStore.shared.binding(
                abilityId: TermLoopBuiltInMCP.jiraAbilityId,
                bindingId: JiraTicketBindingPrompt.bindingId,
                forPath: path
            ) else { continue }
            guard let input = RemoteWorkItemBindingRefreshCoordinator.input(
                workspaceId: workspace.id,
                reportedStatePath: path,
                binding: binding
            ) else { continue }
            byPath[path] = input
        }
        return byPath.values.sorted { lhs, rhs in
            lhs.reportedStatePath.localizedStandardCompare(rhs.reportedStatePath) == .orderedAscending
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

@MainActor
final class RemoteWorkItemBindingRefreshCoordinator {
    static let shared = RemoteWorkItemBindingRefreshCoordinator()

    struct Input: Hashable, Sendable {
        let workspaceId: UUID
        let reportedStatePath: String
        let reference: RemoteWorkItemReference
        let priorURL: String?
    }

    private var refreshTask: Task<Void, Never>?

    private init() {}

    static func input(
        workspaceId: UUID,
        reportedStatePath: String,
        binding: AgentReportedStateStore.AgentReportedBinding
    ) -> Input? {
        let url = nonEmpty(binding.url)
        let candidates = [url, binding.label].compactMap { $0 }
        guard var reference = candidates
            .lazy
            .compactMap(RemoteWorkItemParser.parse)
            .first(where: { $0.provider == .jira }) else {
            return nil
        }
        if reference.url == nil {
            reference.url = url
        }
        return Input(
            workspaceId: workspaceId,
            reportedStatePath: reportedStatePath,
            reference: reference,
            priorURL: url
        )
    }

    func refresh(inputs: [Input], reason: String) {
        guard !inputs.isEmpty else { return }
        refreshTask?.cancel()
        refreshTask = Task.detached(priority: .utility) { [inputs] in
            let service = RemoteWorkItemService(providers: [JiraRemoteWorkItemProvider()])
            for input in inputs {
                guard !Task.isCancelled else { return }
                do {
                    let snapshot = try await service.fetch(input.reference)
                    await MainActor.run {
                        Self.apply(snapshot: snapshot, input: input, reason: reason)
                    }
                } catch {
                    NSLog("[RemoteWorkItem] binding refresh failed key=\(input.reference.key) reason=\(reason) error=\(String(describing: error))")
                }
            }
        }
    }

    private static func apply(
        snapshot: RemoteWorkItemSnapshot,
        input: Input,
        reason: String
    ) {
        let value = AgentReportedStateStore.AgentReportedBinding(
            abilityId: TermLoopBuiltInMCP.jiraAbilityId,
            bindingId: JiraTicketBindingPrompt.bindingId,
            label: snapshot.reference.key,
            status: snapshot.statusLabel,
            url: snapshot.reference.url ?? input.priorURL,
            reportedAt: Date()
        )
        _ = WorkspaceMetadataStore.shared.setReportedBinding(
            value,
            abilityId: TermLoopBuiltInMCP.jiraAbilityId,
            bindingId: JiraTicketBindingPrompt.bindingId,
            forWorkspaceId: input.workspaceId,
            fallbackPath: input.reportedStatePath
        )
        NSLog("[RemoteWorkItem] binding refreshed key=\(snapshot.reference.key) status=\(snapshot.statusLabel ?? "nil") reason=\(reason)")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

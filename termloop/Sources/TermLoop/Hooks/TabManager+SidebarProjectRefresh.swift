// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop - GPL-3.0-or-later

import Foundation

@MainActor
enum SidebarProjectRefreshBridge {
    typealias SchedulePanelRefresh = (_ workspaceId: UUID, _ panelId: UUID, _ reason: String) -> Void

    private final class Entry {
        weak var tabManager: TabManager?
        let scheduleGitMetadata: SchedulePanelRefresh
        let schedulePullRequest: SchedulePanelRefresh

        init(
            tabManager: TabManager,
            scheduleGitMetadata: @escaping SchedulePanelRefresh,
            schedulePullRequest: @escaping SchedulePanelRefresh
        ) {
            self.tabManager = tabManager
            self.scheduleGitMetadata = scheduleGitMetadata
            self.schedulePullRequest = schedulePullRequest
        }
    }

    private static var entries: [ObjectIdentifier: Entry] = [:]

    static func register(
        tabManager: TabManager,
        scheduleGitMetadata: @escaping SchedulePanelRefresh,
        schedulePullRequest: @escaping SchedulePanelRefresh
    ) {
        entries[ObjectIdentifier(tabManager)] = Entry(
            tabManager: tabManager,
            scheduleGitMetadata: scheduleGitMetadata,
            schedulePullRequest: schedulePullRequest
        )
        pruneReleasedEntries()
    }

    static func unregister(tabManager: TabManager) {
        entries.removeValue(forKey: ObjectIdentifier(tabManager))
    }

    static func refresh(
        tabManager: TabManager,
        workspaces: [Workspace],
        reason: String
    ) {
        pruneReleasedEntries()
        guard let entry = entries[ObjectIdentifier(tabManager)] else { return }

        for workspace in workspaces {
            for panelId in refreshPanelIds(for: workspace) {
                entry.scheduleGitMetadata(workspace.id, panelId, reason)
                if workspace.panelGitBranches[panelId] != nil || workspace.panelPullRequests[panelId] != nil {
                    entry.schedulePullRequest(workspace.id, panelId, reason)
                }
            }
        }
    }

    private static func refreshPanelIds(for workspace: Workspace) -> [UUID] {
        var candidatePanelIds = Set(workspace.panelGitBranches.keys)
        candidatePanelIds.formUnion(workspace.panelPullRequests.keys)
        candidatePanelIds.formUnion(workspace.panelDirectories.keys)
        if let focusedPanelId = workspace.focusedPanelId {
            candidatePanelIds.insert(focusedPanelId)
        }

        let livePanelIds = candidatePanelIds.filter { workspace.panels[$0] != nil }
        let sortedPanelIds = livePanelIds.sorted { $0.uuidString < $1.uuidString }

        var panelByDirectory: [String: UUID] = [:]
        var panelIdsWithoutDirectory: [UUID] = []
        for panelId in sortedPanelIds {
            guard let directory = refreshDirectory(for: workspace, panelId: panelId) else {
                panelIdsWithoutDirectory.append(panelId)
                continue
            }
            if panelByDirectory[directory] == nil {
                panelByDirectory[directory] = panelId
            }
        }

        let deduped = panelByDirectory
            .sorted { lhs, rhs in lhs.key.localizedStandardCompare(rhs.key) == .orderedAscending }
            .map(\.value)
        return deduped + panelIdsWithoutDirectory
    }

    private static func refreshDirectory(for workspace: Workspace, panelId: UUID) -> String? {
        let raw = workspace.panelDirectories[panelId]
            ?? workspace.terminalPanel(for: panelId)?.requestedWorkingDirectory
            ?? (workspace.focusedPanelId == panelId ? workspace.currentDirectory : nil)
        return normalizedDirectory(raw)
    }

    private static func normalizedDirectory(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        let expanded = (trimmed as NSString).expandingTildeInPath
        return URL(fileURLWithPath: expanded).standardizedFileURL.path
    }

    private static func pruneReleasedEntries() {
        entries = entries.filter { _, entry in entry.tabManager != nil }
    }
}

extension TermLoopHooks {
    @MainActor
    static func registerSidebarProjectRefreshBridge(
        tabManager: TabManager,
        scheduleGitMetadata: @escaping SidebarProjectRefreshBridge.SchedulePanelRefresh,
        schedulePullRequest: @escaping SidebarProjectRefreshBridge.SchedulePanelRefresh
    ) {
        SidebarProjectRefreshBridge.register(
            tabManager: tabManager,
            scheduleGitMetadata: scheduleGitMetadata,
            schedulePullRequest: schedulePullRequest
        )
    }

    @MainActor
    static func unregisterSidebarProjectRefreshBridge(tabManager: TabManager) {
        SidebarProjectRefreshBridge.unregister(tabManager: tabManager)
    }
}

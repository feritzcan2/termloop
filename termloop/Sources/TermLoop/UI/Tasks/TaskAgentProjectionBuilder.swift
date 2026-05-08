// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct TaskWorktreeAgentSnapshot: Equatable, Identifiable {
    let workspaceId: UUID
    let agentLabel: String
    let displayState: TerminalAgentDisplayState
    let preview: String?
    let latestActivityAt: Date?
    let since: Date?
    let isTaskWorkspace: Bool
    let isPreferredCandidate: Bool

    var id: UUID { workspaceId }
}

struct TaskAgentStatusSummary: Equatable {
    let agentCount: Int
    let dominantState: TerminalAgentDisplayState
    let latestActivityAt: Date?
    let agents: [TaskAgentBadgeSummary]
}

struct TaskAgentBadgeSummary: Equatable, Identifiable {
    let workspaceId: UUID
    let label: String
    let displayState: TerminalAgentDisplayState

    var id: UUID { workspaceId }
}

@MainActor
enum TaskAgentProjectionBuilder {
    static func task(in store: TaskBoardStore, selectedTaskId: UUID?) -> TaskRecord? {
        guard let selectedTaskId else { return nil }
        return store.fileSnapshot().tasks.first { $0.id == selectedTaskId && $0.archivedAt == nil }
    }

    static func detailSnapshot(in store: TaskBoardStore, selectedTaskId: UUID?) -> TaskDetailSnapshot? {
        task(in: store, selectedTaskId: selectedTaskId).map(TaskDetailSnapshot.init(task:))
    }

    static func preferredAgentWorkspace(
        for task: TaskRecord,
        openWorkspaceIds: Set<UUID>? = nil
    ) -> UUID? {
        agents(
            worktreePath: task.worktreePath,
            taskWorkspaceId: task.workspaceId,
            includeTaskWorkspaceId: true,
            openWorkspaceIds: openWorkspaceIds
        )
        .filter(\.isPreferredCandidate)
        .sorted(by: isPreferredAgent(_:_:))
        .first?
        .workspaceId
    }


    static func statusSummaries(
        for tasks: [TaskRecord],
        openWorkspaceIds: Set<UUID>? = nil
    ) -> [UUID: TaskAgentStatusSummary] {
        Dictionary(uniqueKeysWithValues: tasks.compactMap { task in
            guard task.archivedAt == nil,
                  let summary = statusSummary(
                    worktreePath: task.worktreePath,
                    taskWorkspaceId: task.workspaceId,
                    openWorkspaceIds: openWorkspaceIds
                  ) else {
                return nil
            }
            return (task.id, summary)
        })
    }

    static func statusSummary(
        worktreePath: String?,
        taskWorkspaceId: UUID?,
        openWorkspaceIds: Set<UUID>? = nil
    ) -> TaskAgentStatusSummary? {
        let agents = agents(
            worktreePath: worktreePath,
            taskWorkspaceId: taskWorkspaceId,
            includeTaskWorkspaceId: true,
            openWorkspaceIds: openWorkspaceIds
        )
        guard !agents.isEmpty else { return nil }
        let dominant = agents
            .map(\.displayState)
            .sorted { $0.aggregatePriority < $1.aggregatePriority }
            .first ?? .idle
        let latest = agents.compactMap(\.latestActivityAt).max()
        return TaskAgentStatusSummary(
            agentCount: agents.count,
            dominantState: dominant,
            latestActivityAt: latest,
            agents: agents.map {
                TaskAgentBadgeSummary(
                    workspaceId: $0.workspaceId,
                    label: $0.agentLabel,
                    displayState: $0.displayState
                )
            }
        )
    }

    static func agents(
        worktreePath: String?,
        taskWorkspaceId: UUID? = nil,
        includeTaskWorkspaceId: Bool = false,
        openWorkspaceIds: Set<UUID>? = nil,
        fallbackAgentLabel: String? = nil
    ) -> [TaskWorktreeAgentSnapshot] {
        let resolvedFallbackAgentLabel = fallbackAgentLabel ?? Self.fallbackAgentLabel
        var orderedWorkspaceIds: [UUID] = []
        func append(_ workspaceId: UUID?) {
            guard let workspaceId, !orderedWorkspaceIds.contains(workspaceId) else { return }
            orderedWorkspaceIds.append(workspaceId)
        }

        if let path = metadataPath(worktreePath) {
            WorkspaceMetadataStore.shared.workspaceIds(withWorktreePath: path).forEach { append($0) }
        }
        if includeTaskWorkspaceId {
            append(taskWorkspaceId)
        }

        return orderedWorkspaceIds.compactMap { workspaceId in
            agentSnapshot(
                workspaceId: workspaceId,
                taskWorkspaceId: taskWorkspaceId,
                openWorkspaceIds: openWorkspaceIds,
                fallbackAgentLabel: resolvedFallbackAgentLabel
            )
        }
        .sorted(by: isDisplayOrdered(_:_:))
    }

    static func agentRowSnapshots(
        worktreePath: String?,
        taskWorkspaceId: UUID?,
        workspaces: [Workspace],
        branchLabel: String?,
        fallbackAgentLabel: String? = nil
    ) -> [AgentRowPresentationSnapshot] {
        var workspaceById: [UUID: Workspace] = [:]
        for workspace in workspaces {
            workspaceById[workspace.id] = workspace
        }

        return agents(
            worktreePath: worktreePath,
            taskWorkspaceId: taskWorkspaceId,
            includeTaskWorkspaceId: true,
            openWorkspaceIds: Set(workspaces.map(\.id)),
            fallbackAgentLabel: fallbackAgentLabel
        )
        .map { agent in
            if let workspace = workspaceById[agent.workspaceId] {
                return AgentRowSnapshotBuilder.build(
                    workspace: workspace,
                    presentation: TerminalAgentActivityStore.shared.presentation(forWorkspaceId: agent.workspaceId),
                    branchLabel: branchLabel,
                    policy: .presentation
                )
            }
            return fallbackAgentRowSnapshot(agent, branchLabel: branchLabel)
        }
    }

    static func recordedBranches(worktreePath: String?, expectedBranch: String?) -> [String] {
        var values: [String] = []
        if let path = metadataPath(worktreePath) {
            values.append(contentsOf: WorkspaceMetadataStore.shared.workspaceIds(withWorktreePath: path).compactMap { id in
                WorkspaceMetadataStore.shared.metadata(forWorkspaceId: id).branch?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty
            })
        }
        if let expected = expectedBranch?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
            values.append(expected)
        }
        return Array(Set(values))
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    static func metadataPath(_ path: String?) -> String? {
        TaskPathNormalization.resolveDisplayAndKey(path)?.displayPath
    }

    static func pathLeaf(_ path: String?) -> String? {
        TaskPathNormalization.resolveDisplayAndKey(path)?.leafName
    }

    private static var fallbackAgentLabel: String {
        String(localized: "tasks.sidebar.section.branches.agent",
               defaultValue: "agent",
               table: "TermLoop")
    }

    private static func agentSnapshot(
        workspaceId: UUID,
        taskWorkspaceId: UUID?,
        openWorkspaceIds: Set<UUID>?,
        fallbackAgentLabel: String
    ) -> TaskWorktreeAgentSnapshot? {
        if let openWorkspaceIds {
            guard openWorkspaceIds.contains(workspaceId) else { return nil }
        } else {
            guard isOpenWorkspace(workspaceId) else { return nil }
        }

        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
        let presentation = TerminalAgentActivityStore.shared.presentation(forWorkspaceId: workspaceId)
        let agentId = presentation?.agentId
            ?? metadata.terminalAgentId
            ?? metadata.persistedAgentSession?.agentId
        let label = TerminalAgentDisplayFormatter.agentDisplayLabel(
            agentId: agentId,
            fallback: fallbackAgentLabel
        )
        let hasAgentIdentity = presentation != nil
            || metadata.terminalAgentId != nil
            || metadata.persistedAgentSession != nil
            || metadata.agentKind != nil
            || metadata.agentSpawnedAt != nil
            || metadata.lastUserPromptAt != nil
        guard hasAgentIdentity else { return nil }

        let preferred = isVisibleAgentWorkspace(presentation: presentation, metadata: metadata)
        let latestActivityAt = presentation?.latestActivityAt
            ?? metadata.lastUserPromptAt
            ?? metadata.persistedAgentSession?.updatedAt
            ?? metadata.agentSpawnedAt
        return TaskWorktreeAgentSnapshot(
            workspaceId: workspaceId,
            agentLabel: label,
            displayState: presentation?.displayState ?? .idle,
            preview: presentation?.preview ?? metadata.lastMessagePreview,
            latestActivityAt: latestActivityAt,
            since: presentation?.since,
            isTaskWorkspace: taskWorkspaceId == workspaceId,
            isPreferredCandidate: preferred
        )
    }

    private static func isOpenWorkspace(_ workspaceId: UUID) -> Bool {
        AppDelegate.shared?.tabManagerFor(tabId: workspaceId) != nil
    }

    private static func fallbackAgentRowSnapshot(
        _ agent: TaskWorktreeAgentSnapshot,
        branchLabel: String?
    ) -> AgentRowPresentationSnapshot {
        AgentRowPresentationSnapshot(
            workspaceId: agent.workspaceId,
            title: agent.agentLabel,
            agentId: nil,
            agentLabel: agent.agentLabel,
            stateText: TerminalAgentDisplayFormatter.stateText(
                for: agent.displayState,
                preview: agent.preview
            ),
            displayState: agent.displayState,
            branchLabel: branchLabel,
            preview: agent.preview,
            since: agent.since,
            lastUserPromptAt: agent.latestActivityAt
        )
    }

    private static func isVisibleAgentWorkspace(
        presentation: TerminalAgentPresentationState?,
        metadata: WorkspaceMetadataStore.Metadata
    ) -> Bool {
        guard let presentation, presentation.displayState.isVisibleActivity else {
            return false
        }

        if presentation.source != .bound {
            return true
        }
        return metadata.persistedAgentSession != nil
            || metadata.lastUserPromptAt != nil
            || metadata.agentKind != nil
            || metadata.agentSpawnedAt != nil
    }

    private static func isPreferredAgent(_ lhs: TaskWorktreeAgentSnapshot, _ rhs: TaskWorktreeAgentSnapshot) -> Bool {
        let lhsDate = lhs.latestActivityAt ?? .distantPast
        let rhsDate = rhs.latestActivityAt ?? .distantPast
        if lhsDate != rhsDate { return lhsDate > rhsDate }
        if lhs.displayState.activeAgentsSortPriority != rhs.displayState.activeAgentsSortPriority {
            return lhs.displayState.activeAgentsSortPriority < rhs.displayState.activeAgentsSortPriority
        }
        if lhs.isTaskWorkspace != rhs.isTaskWorkspace { return lhs.isTaskWorkspace }
        return lhs.workspaceId.uuidString < rhs.workspaceId.uuidString
    }

    private static func isDisplayOrdered(_ lhs: TaskWorktreeAgentSnapshot, _ rhs: TaskWorktreeAgentSnapshot) -> Bool {
        if lhs.displayState.activeAgentsSortPriority != rhs.displayState.activeAgentsSortPriority {
            return lhs.displayState.activeAgentsSortPriority < rhs.displayState.activeAgentsSortPriority
        }
        let lhsDate = lhs.latestActivityAt ?? .distantPast
        let rhsDate = rhs.latestActivityAt ?? .distantPast
        if lhsDate != rhsDate { return lhsDate > rhsDate }
        return lhs.agentLabel.localizedCaseInsensitiveCompare(rhs.agentLabel) == .orderedAscending
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

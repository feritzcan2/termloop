// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Top-level Tasks page. The board itself is the primary surface. Selecting a
/// card drives sidebar drill-in state and switches the local bottom split to
/// that task's preferred visible agent workspace. Tasks with no attached agent
/// close the split. There is no bottom detail inspector.
struct TaskBoardPage<TerminalContent: View>: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var coordinator: TaskLifecycleCoordinator?
    @ViewBuilder let terminalContent: () -> TerminalContent

    var body: some View {
        Group {
            if selection.inlineTerminalWorkspaceId != nil {
                HorizontalResizableSplit(
                    topMinHeight: 320,
                    bottomMinHeight: 260,
                    bottomPreferredHeight: 430,
                    top: {
                        TaskBoardCanvas(
                            store: store,
                            selection: selection,
                            coordinator: coordinator,
                            onSelect: selectFromBoard
                        )
                    },
                    bottom: { embeddedTerminal }
                )
            } else {
                TaskBoardCanvas(
                    store: store,
                    selection: selection,
                    coordinator: coordinator,
                    onSelect: selectFromBoard
                )
            }
        }
        .onAppear {
            syncStoreSelection()
            syncInlineTerminalForSelectedTask(focusWorkspace: false)
        }
        .onChange(of: selection.selectedTaskId) { _, _ in
            syncStoreSelection()
            syncInlineTerminalForSelectedTask(focusWorkspace: true)
        }
    }

    private func syncStoreSelection() {
        store.selectTask(selection.selectedTaskId)
        if selection.selectedTaskId != nil, store.selectedTaskDetailSnapshot == nil {
            selection.select(nil)
        }
    }

    private func selectFromBoard(_ card: TaskCardSummary) {
        selection.select(card.id)
        syncStoreSelection()
        syncInlineTerminalForSelectedTask(taskId: card.id, focusWorkspace: true)
    }

    private func syncInlineTerminalForSelectedTask(
        taskId explicitTaskId: UUID? = nil,
        focusWorkspace: Bool
    ) {
        let taskId = explicitTaskId ?? selection.selectedTaskId
        guard let taskId,
              let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
            selection.closeInlineTerminal()
            return
        }

        guard let workspaceId = preferredAgentWorkspace(for: task) else {
            selection.closeInlineTerminal()
            return
        }

        let changed = selection.openInlineTerminal(workspaceId: workspaceId)
        if focusWorkspace || changed {
            TaskQuickActions.showWorkspaceInline(workspaceId: workspaceId)
        }
    }

    private func preferredAgentWorkspace(for task: TaskRecord) -> UUID? {
        let ids = agentWorkspaceIds(for: task)
        guard !ids.isEmpty else { return nil }
        return ids
            .map { agentCandidate(workspaceId: $0, taskWorkspaceId: task.workspaceId) }
            .filter(\.hasAgentBinding)
            .sorted(by: isPreferredAgentCandidate(_:_:))
            .first?
            .workspaceId
    }

    private func agentWorkspaceIds(for task: TaskRecord) -> [UUID] {
        var ordered: [UUID] = []
        func append(_ id: UUID?) {
            guard let id, !ordered.contains(id) else { return }
            ordered.append(id)
        }

        if let path = normalizedWorktreePath(task.worktreePath) {
            WorkspaceMetadataStore.shared.workspaceIds(withWorktreePath: path).forEach { append($0) }
        }
        append(task.workspaceId)
        return ordered
    }

    private struct AgentCandidate {
        let workspaceId: UUID
        let displayState: TerminalAgentDisplayState
        let latestActivityAt: Date?
        let hasAgentBinding: Bool
        let isTaskWorkspace: Bool
    }

    private func agentCandidate(workspaceId: UUID, taskWorkspaceId: UUID?) -> AgentCandidate {
        let presentation = TerminalAgentActivityStore.shared.presentation(forWorkspaceId: workspaceId)
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
        let latestActivityAt = presentation?.latestActivityAt
            ?? metadata.lastUserPromptAt
            ?? metadata.persistedAgentSession?.updatedAt
            ?? metadata.agentSpawnedAt
        let hasAgentBinding = isVisibleAgentWorkspace(
            presentation: presentation,
            metadata: metadata
        )
        return AgentCandidate(
            workspaceId: workspaceId,
            displayState: presentation?.displayState ?? (hasAgentBinding ? .ready : .idle),
            latestActivityAt: latestActivityAt,
            hasAgentBinding: hasAgentBinding,
            isTaskWorkspace: taskWorkspaceId == workspaceId
        )
    }

    private func isVisibleAgentWorkspace(
        presentation: TerminalAgentPresentationState?,
        metadata: WorkspaceMetadataStore.Metadata
    ) -> Bool {
        guard let presentation, presentation.displayState.isVisibleActivity else {
            return false
        }

        // A plain terminal workspace can carry a terminalAgentId binding as
        // catalog/default metadata. Do not treat that alone as a task-board
        // agent terminal. Real agent rows either have live/pending/sticky
        // activity, a persisted resumable session, a user prompt timestamp, or
        // an explicit TermLoop-spawned agent session marker.
        if presentation.source != .bound {
            return true
        }
        return metadata.persistedAgentSession != nil
            || metadata.lastUserPromptAt != nil
            || metadata.agentKind != nil
            || metadata.agentSpawnedAt != nil
    }

    private func isPreferredAgentCandidate(_ lhs: AgentCandidate, _ rhs: AgentCandidate) -> Bool {
        let lhsDate = lhs.latestActivityAt ?? .distantPast
        let rhsDate = rhs.latestActivityAt ?? .distantPast
        if lhsDate != rhsDate { return lhsDate > rhsDate }
        if lhs.displayState.activeAgentsSortPriority != rhs.displayState.activeAgentsSortPriority {
            return lhs.displayState.activeAgentsSortPriority < rhs.displayState.activeAgentsSortPriority
        }
        if lhs.isTaskWorkspace != rhs.isTaskWorkspace { return lhs.isTaskWorkspace }
        return lhs.workspaceId.uuidString < rhs.workspaceId.uuidString
    }

    private func normalizedWorktreePath(_ path: String?) -> String? {
        guard let path else { return nil }
        return WorktreeResolver.normalizePath(path)
            ?? URL(fileURLWithPath: path).standardizedFileURL.path
    }

    private var embeddedTerminal: some View {
        terminalContent()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black.opacity(0.2))
            .clipped()
    }
}

private struct TaskBoardCanvas: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var coordinator: TaskLifecycleCoordinator?
    var onSelect: ((TaskCardSummary) -> Void)?

    var body: some View {
        GeometryReader { proxy in
            let spacing: CGFloat = 10
            let horizontalPadding: CGFloat = 10
            let available = proxy.size.width - (horizontalPadding * 2) - (spacing * 4)
            let columnWidth = max(236, floor(available / 5))

            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: spacing) {
                    ForEach(store.columnSnapshots) { snapshot in
                        TaskBoardColumnView(
                            snapshot: snapshot,
                            selection: selection,
                            onMove: coordinator.map { c in
                                { taskId, target in
                                    _Concurrency.Task { @MainActor in
                                        try? await c.moveColumn(taskId: taskId, to: target)
                                    }
                                }
                            },
                            onSelect: onSelect,
                            onCommandClick: { card in
                                if let task = store.fileSnapshot().tasks.first(where: { $0.id == card.id }) {
                                    TaskQuickActions.openWorktree(
                                        workspaceId: task.workspaceId,
                                        worktreePath: task.worktreePath
                                    )
                                }
                            },
                            onArchive: coordinator.map { c in
                                { id in try? c.archiveTask(id) }
                            }
                        )
                        .frame(width: columnWidth)
                        .frame(minHeight: max(0, proxy.size.height - 20))
                    }
                }
                .padding(.horizontal, horizontalPadding)
                .padding(.vertical, 10)
            }
            .background(Color(nsColor: .windowBackgroundColor))
        }
        .onExitCommand { selection.select(nil) }
    }
}

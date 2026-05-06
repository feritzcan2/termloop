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
    @StateObject private var remoteSync: TaskRemoteSyncCoordinator
    @ViewBuilder let terminalContent: () -> TerminalContent

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared

    init(
        store: TaskBoardStore,
        selection: TaskSelectionStore,
        coordinator: TaskLifecycleCoordinator?,
        @ViewBuilder terminalContent: @escaping () -> TerminalContent
    ) {
        self.store = store
        self.selection = selection
        self.coordinator = coordinator
        self.terminalContent = terminalContent
        _remoteSync = StateObject(wrappedValue: TaskRemoteSyncCoordinator(store: store))
    }

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
                            remoteSync: remoteSync,
                            agentStatusesByTaskId: agentStatusesByTaskId,
                            workItemsByTaskId: workItemsByTaskId,
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
                    remoteSync: remoteSync,
                    agentStatusesByTaskId: agentStatusesByTaskId,
                    workItemsByTaskId: workItemsByTaskId,
                    onSelect: selectFromBoard
                )
            }
        }
        .onAppear {
            syncSelectionValidity()
            syncInlineTerminalForSelectedTask(focusWorkspace: false)
        }
        .onChange(of: selection.selectedTaskId) { _, _ in
            syncSelectionValidity()
            syncInlineTerminalForSelectedTask(focusWorkspace: true)
        }
    }

    private var agentStatusesByTaskId: [UUID: TaskAgentStatusSummary] {
        // Intentional subscription reads: the projection is derived on-demand
        // from shared workspace/agent stores instead of persisting telemetry in Tasks.
        _ = metadataStore
        _ = activityStore
        return TaskAgentProjectionBuilder.statusSummaries(for: store.fileSnapshot().tasks)
    }

    private var workItemsByTaskId: [UUID: TaskWorkItemSnapshot] {
        // Same projection-only pattern as agent status: work item bindings
        // stay owned by the reported-state store, Tasks just renders them.
        _ = metadataStore
        return TaskWorkItemProjectionBuilder.snapshots(for: store.fileSnapshot().tasks)
    }

    private func syncSelectionValidity() {
        if selection.selectedTaskId != nil,
           TaskAgentProjectionBuilder.detailSnapshot(in: store, selectedTaskId: selection.selectedTaskId) == nil {
            selection.select(nil)
        }
    }

    private func selectFromBoard(_ card: TaskCardSummary) {
        selection.select(card.id)
        syncSelectionValidity()
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

        guard let workspaceId = TaskAgentProjectionBuilder.preferredAgentWorkspace(for: task) else {
            selection.closeInlineTerminal()
            return
        }

        let changed = selection.openInlineTerminal(workspaceId: workspaceId)
        if focusWorkspace || changed {
            TaskQuickActions.showWorkspaceInline(workspaceId: workspaceId)
        }
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
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator
    let agentStatusesByTaskId: [UUID: TaskAgentStatusSummary]
    let workItemsByTaskId: [UUID: TaskWorkItemSnapshot]
    var onSelect: ((TaskCardSummary) -> Void)?

    var body: some View {
        GeometryReader { proxy in
            let spacing: CGFloat = 10
            let horizontalPadding: CGFloat = 10
            let columnCount = max(store.columnSnapshots.count, 1)
            let available = proxy.size.width - (horizontalPadding * 2) - (spacing * CGFloat(max(columnCount - 1, 0)))
            let columnWidth = max(236, floor(available / CGFloat(columnCount)))

            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: spacing) {
                    ForEach(store.columnSnapshots) { snapshot in
                        TaskBoardColumnView(
                            snapshot: snapshot,
                            title: store.columnTitle(for: snapshot.id),
                            selection: selection,
                            agentStatusesByTaskId: agentStatusesByTaskId,
                            workItemsByTaskId: workItemsByTaskId,
                            onMove: coordinator.map { c in
                                { taskId, target in
                                    _Concurrency.Task { @MainActor in
                                        do {
                                            try await c.moveColumn(taskId: taskId, to: target)
                                            remoteSync.maybePromptRemoteStatusSync(taskId: taskId, to: target)
                                        } catch {
                                            #if DEBUG
                                            print("TaskBoardCanvas move failed: \(error)")
                                            #endif
                                        }
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

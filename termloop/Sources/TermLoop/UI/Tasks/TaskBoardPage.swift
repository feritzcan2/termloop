// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Top-level Tasks page. The board itself is the primary surface. Selecting a
/// card drives sidebar drill-in state and switches the local bottom split to
/// that task's preferred visible agent workspace. Tasks with no attached agent
/// close the split. There is no bottom detail inspector.
struct TaskBoardPage<TerminalContent: View>: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var coordinator: TaskLifecycleCoordinator?
    @ObservedObject private var remoteSync: TaskRemoteSyncCoordinator
    @ViewBuilder let terminalContent: () -> TerminalContent

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    @ObservedObject private var worktreeProjectionStore = WorktreeProjectionStore.shared
    @ObservedObject private var devServerRunStore = DevServerRunStore.shared
    @EnvironmentObject private var tabManager: TabManager

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
        self.remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
    }

    var body: some View {
        Group {
            if selection.inlineTerminalWorkspaceId != nil {
                HorizontalResizableSplit(
                    topMinHeight: 320,
                    bottomMinHeight: 260,
                    bottomPreferredFraction: 0.35,
                    top: {
                        TaskBoardCanvas(
                            store: store,
                            selection: selection,
                            coordinator: coordinator,
                            remoteSync: remoteSync,
                            agentStatusesByTaskId: agentStatusesByTaskId,
                            workItemsByTaskId: workItemsByTaskId,
                            devServerSummariesByTaskId: devServerSummariesByTaskId,
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
                    devServerSummariesByTaskId: devServerSummariesByTaskId,
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
        .disabled(remoteSync.isSyncing)
        .overlay {
            if remoteSync.isSyncing {
                TaskBoardRemoteSyncOverlay()
            }
        }
        .background(renameSelectedTaskCommand)
    }

    private var agentStatusesByTaskId: [UUID: TaskAgentStatusSummary] {
        // Intentional subscription reads: the projection is derived on-demand
        // from shared workspace/agent stores instead of persisting telemetry in Tasks.
        _ = metadataStore
        _ = activityStore
        _ = worktreeProjectionStore.version
        let openWorkspaceIds = Set(tabManager.tabs.map(\.id))
        return TaskAgentProjectionBuilder.statusSummaries(
            for: store.fileSnapshot().tasks,
            projectId: store.projectId,
            openWorkspaceIds: openWorkspaceIds
        )
    }

    private var workItemsByTaskId: [UUID: TaskWorkItemSnapshot] {
        guard store.settingsSnapshot.remoteSync.isEnabled else { return [:] }
        // Same projection-only pattern as agent status: work item bindings
        // stay owned by the reported-state store, Tasks just renders them.
        _ = metadataStore
        _ = worktreeProjectionStore.version
        return TaskWorkItemProjectionBuilder.snapshots(
            for: store.fileSnapshot().tasks,
            projectId: store.projectId
        )
    }

    private var devServerSummariesByTaskId: [UUID: TaskDevServerSummary] {
        _ = devServerRunStore.version
        return TaskDevServerProjectionBuilder.summaries(
            for: store.fileSnapshot().tasks,
            projectId: store.projectId,
            runStore: devServerRunStore
        )
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

        let openWorkspaceIds = Set(tabManager.tabs.map(\.id))
        guard let workspaceId = TaskAgentProjectionBuilder.preferredAgentWorkspace(
            for: task,
            projectId: store.projectId,
            openWorkspaceIds: openWorkspaceIds
        ) else {
            selection.closeInlineTerminal()
            return
        }

        let changed = selection.openInlineTerminal(workspaceId: workspaceId)
        if focusWorkspace || changed {
            TaskQuickActions.showWorkspaceInline(workspaceId: workspaceId)
        }
    }

    private var renameSelectedTaskCommand: some View {
        Button(action: presentRenameSelectedTask) {
            Color.clear
                .frame(width: 0, height: 0)
        }
        .keyboardShortcut("r", modifiers: [.command])
        .buttonStyle(.plain)
        .opacity(0)
        .accessibilityHidden(true)
    }

    private func presentRenameSelectedTask() {
        guard !remoteSync.isSyncing,
              let coordinator,
              let taskId = selection.selectedTaskId,
              let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId && $0.archivedAt == nil }),
              let title = TaskRenameDialog.promptTitle(currentTitle: task.title) else {
            return
        }
        try? coordinator.updateTitle(taskId: task.id, title: title)
    }

    private var embeddedTerminal: some View {
        terminalContent()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black.opacity(0.2))
            .clipped()
    }
}

private struct TaskBoardRemoteSyncOverlay: View {
    var body: some View {
        ZStack {
            Color.black.opacity(0.18)
            VStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                Text(String(localized: "tasks.board.remoteSync.waiting",
                            defaultValue: "Updating remote status...",
                            table: "TermLoop"))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary)
            }
            .padding(.vertical, 16)
            .padding(.horizontal, 20)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.white.opacity(0.12), lineWidth: 1)
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(true)
    }
}

@MainActor
enum TaskRenameDialog {
    static func promptTitle(currentTitle: String) -> String? {
        let alert = NSAlert()
        alert.messageText = String(localized: "tasks.rename.title",
                                   defaultValue: "Rename Task",
                                   table: "TermLoop")
        alert.informativeText = String(localized: "tasks.rename.message",
                                       defaultValue: "Enter a new title for this task.",
                                       table: "TermLoop")

        let input = NSTextField(string: currentTitle)
        input.placeholderString = String(localized: "tasks.rename.placeholder",
                                         defaultValue: "Task title",
                                         table: "TermLoop")
        input.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        alert.accessoryView = input
        alert.addButton(withTitle: String(localized: "tasks.rename.confirm",
                                          defaultValue: "Rename",
                                          table: "TermLoop"))
        alert.addButton(withTitle: String(localized: "tasks.rename.cancel",
                                          defaultValue: "Cancel",
                                          table: "TermLoop"))
        let alertWindow = alert.window
        alertWindow.initialFirstResponder = input
        DispatchQueue.main.async {
            alertWindow.makeFirstResponder(input)
            input.selectText(nil)
        }

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return nil }
        let normalized = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized != currentTitle else { return nil }
        return normalized
    }
}

private struct TaskBoardCanvas: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var coordinator: TaskLifecycleCoordinator?
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator
    let agentStatusesByTaskId: [UUID: TaskAgentStatusSummary]
    let workItemsByTaskId: [UUID: TaskWorkItemSnapshot]
    let devServerSummariesByTaskId: [UUID: TaskDevServerSummary]
    var onSelect: ((TaskCardSummary) -> Void)?

    var body: some View {
        GeometryReader { proxy in
            let spacing: CGFloat = 10
            let horizontalPadding: CGFloat = 10
            let columnCount = max(store.columnSnapshots.count, 1)
            let available = proxy.size.width - (horizontalPadding * 2) - (spacing * CGFloat(max(columnCount - 1, 0)))
            let columnWidth = max(236, floor(available / CGFloat(columnCount)))
            let contentWidth = (horizontalPadding * 2)
                + (columnWidth * CGFloat(columnCount))
                + (spacing * CGFloat(max(columnCount - 1, 0)))

            TaskBoardHorizontalScrollView(contentWidth: max(proxy.size.width, contentWidth)) {
                HStack(alignment: .top, spacing: spacing) {
                    ForEach(store.columnSnapshots) { snapshot in
                        TaskBoardColumnView(
                            snapshot: snapshot,
                            title: store.columnTitle(for: snapshot.id),
                            selection: selection,
                            agentStatusesByTaskId: agentStatusesByTaskId,
                            workItemsByTaskId: workItemsByTaskId,
                            devServerSummariesByTaskId: devServerSummariesByTaskId,
                            onMove: coordinator.map { c in
                                { taskId, target in
                                    _Concurrency.Task { @MainActor in
                                        guard !remoteSync.isSyncing else { return }
                                        do {
                                            try await c.moveColumn(taskId: taskId, to: target)
                                            await remoteSync.maybePromptRemoteStatusSync(taskId: taskId, to: target)
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
                            onOpenAgentTerminal: { card, workspaceId in
                                selection.select(card.id)
                                selection.openInlineTerminal(workspaceId: workspaceId)
                                TaskQuickActions.showWorkspaceInline(workspaceId: workspaceId)
                            },
                            onArchive: coordinator.map { c in
                                { id in try? c.archiveTask(id) }
                            },
                            onDelete: coordinator.map { c in
                                { id in try? c.deleteTask(id) }
                            }
                        )
                        .frame(width: columnWidth)
                        .frame(minHeight: max(0, proxy.size.height - 20))
                    }
                }
                .padding(.horizontal, horizontalPadding)
                .padding(.vertical, 10)
                .frame(width: max(proxy.size.width, contentWidth), alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color(nsColor: .windowBackgroundColor))
        }
        .onExitCommand { selection.select(nil) }
    }
}

private struct TaskBoardHorizontalScrollView<Content: View>: NSViewRepresentable {
    let contentWidth: CGFloat
    @ViewBuilder let content: () -> Content

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> TaskBoardHorizontalNSScrollView {
        let scrollView = TaskBoardHorizontalNSScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasHorizontalScroller = true
        scrollView.hasVerticalScroller = false
        scrollView.autohidesScrollers = false
        scrollView.scrollerStyle = .legacy

        let hostingView = NSHostingView(rootView: content())
        hostingView.translatesAutoresizingMaskIntoConstraints = true
        hostingView.autoresizingMask = []
        scrollView.documentView = hostingView
        scrollView.documentMinWidth = contentWidth
        context.coordinator.hostingView = hostingView
        return scrollView
    }

    func updateNSView(_ scrollView: TaskBoardHorizontalNSScrollView, context: Context) {
        scrollView.drawsBackground = false
        scrollView.hasHorizontalScroller = true
        scrollView.hasVerticalScroller = false
        scrollView.autohidesScrollers = false
        scrollView.scrollerStyle = .legacy
        scrollView.documentMinWidth = contentWidth
        context.coordinator.hostingView?.rootView = content()
        scrollView.needsLayout = true
    }

    final class Coordinator {
        var hostingView: NSHostingView<Content>?
    }
}

private final class TaskBoardHorizontalNSScrollView: NSScrollView {
    var documentMinWidth: CGFloat = 0 {
        didSet {
            guard oldValue != documentMinWidth else { return }
            needsLayout = true
        }
    }

    override func layout() {
        super.layout()
        guard let documentView else { return }

        let visibleSize = contentView.bounds.size
        let resolvedWidth = max(documentMinWidth, visibleSize.width)
        let resolvedHeight = max(0, visibleSize.height)
        let resolvedSize = NSSize(width: resolvedWidth, height: resolvedHeight)
        if documentView.frame.size != resolvedSize {
            documentView.frame = NSRect(origin: .zero, size: resolvedSize)
        }

        let maxX = max(0, resolvedWidth - visibleSize.width)
        let currentOrigin = contentView.bounds.origin
        if currentOrigin.x > maxX || currentOrigin.y != 0 {
            contentView.setBoundsOrigin(NSPoint(x: min(currentOrigin.x, maxX), y: 0))
        }
    }
}

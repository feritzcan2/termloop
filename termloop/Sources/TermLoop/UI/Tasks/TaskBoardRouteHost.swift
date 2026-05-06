// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Per-window host that resolves the per-project `TaskBoardStore` and the
/// window-scoped `TaskSelectionStore`, then renders the Tasks page. Lives at
/// the route boundary so the rest of the Tasks UI doesn't reach into globals.
@MainActor
struct TaskBoardRouteHost: View {
    let projectId: UUID
    let windowId: UUID?

    @EnvironmentObject private var tabManager: TabManager
    @StateObject private var fallbackSelection = TaskSelectionStore()

    private var selection: TaskSelectionStore {
        guard let windowId else { return fallbackSelection }
        return TaskSelectionStoreProvider.shared.store(for: windowId)
    }

    private func applyInlineTerminalPresentation(reason: String) {
        TermLoopHooks.applyMainAreaPresentation(tabManager: tabManager, reason: reason)
    }

    var body: some View {
        if let store = TaskBoardStoreProvider.shared.store(for: projectId) {
            TaskBoardPage(
                store: store,
                selection: selection,
                coordinator: TaskLifecycleCoordinator.makeForProject(store: store),
                terminalContent: {
                    TaskBoardEmbeddedWorkspaceTerminal(
                        tabManager: tabManager,
                        workspaceId: selection.inlineTerminalWorkspaceId
                    )
                }
            )
            .onAppear { applyInlineTerminalPresentation(reason: "taskBoard.appear") }
            .onChange(of: selection.inlineTerminalWorkspaceId) { _, _ in
                applyInlineTerminalPresentation(reason: "taskBoard.inlineTerminalWorkspace")
            }
        } else {
            // Project not yet registered (rare race during startup) — placeholder
            // until reconcile registers it. The host re-renders on store mutation.
            Text(String(localized: "tasks.empty.noProject",
                        defaultValue: "Loading tasks…", table: "TermLoop"))
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// First-class embedded terminal surface for the task board bottom split.
///
/// This intentionally renders the selected `WorkspaceContentView` directly
/// instead of reusing ContentView's full `terminalContent` closure. The full
/// closure carries window titlebar/sidebar chrome and was previously being
/// cropped away with a fixed offset, which made the split fragile during
/// resize/click transitions. This view owns only the workspace surface that the
/// agent belongs to.
struct TaskBoardEmbeddedWorkspaceTerminal: View {
    @ObservedObject var tabManager: TabManager
    let workspaceId: UUID?

    var body: some View {
        Group {
            if let workspace = selectedWorkspace {
                WorkspaceContentView(
                    workspace: workspace,
                    isWorkspaceVisible: true,
                    isWorkspaceInputActive: tabManager.selectedTabId == workspace.id,
                    isFullScreen: false,
                    workspacePortalPriority: 3,
                    onThemeRefreshRequest: nil
                )
                .overlay(alignment: .bottom) {
                    TermLoopHooks.workspaceFooterExtras(workspace: workspace)
                }
            } else {
                missingWorkspacePlaceholder
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var selectedWorkspace: Workspace? {
        guard let workspaceId else { return nil }
        return tabManager.tabs.first { $0.id == workspaceId }
    }

    private var missingWorkspacePlaceholder: some View {
        VStack(spacing: 8) {
            Image(systemName: "terminal")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(String(localized: "tasks.terminal.empty",
                        defaultValue: "Select an agent to open its terminal.",
                        table: "TermLoop"))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

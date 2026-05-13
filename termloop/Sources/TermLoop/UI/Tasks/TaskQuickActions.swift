// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public struct TaskAgentLaunchContext {
    public let targetWorkspaceId: UUID?
    public let projectId: UUID
    public let cwdPath: String
    public let branchName: String?

    public init(
        targetWorkspaceId: UUID?,
        projectId: UUID,
        cwdPath: String,
        branchName: String?
    ) {
        self.targetWorkspaceId = targetWorkspaceId
        self.projectId = projectId
        self.cwdPath = cwdPath
        self.branchName = branchName
    }
}

/// Quick actions available from the Tasks page (sidebar drill-in actions and
/// card context menus).
///
/// Per CLAUDE.md: agent-spawn must use the existing AgentInputs prompt
/// templates. We never inline a prompt string here; instead we route through
/// the existing Quick Action affordance which shows the user the template
/// picker.
@MainActor
enum TaskQuickActions {
    /// Switch the active sidebar tab to `.work` and select the bound workspace.
    /// Wired to actual focus plumbing in Task 18.
    static func openWorktree(workspaceId: UUID?, worktreePath: String? = nil) {
        // Switch sidebar to work and store the selected workspace via existing
        // AppDelegate / AppStorage path. The existing ⌘Click affordance already
        // owns this — we just emit the same intent here.
        UserDefaults.standard.set(
            TermLoopSidebarTab.work.rawValue,
            forKey: TermLoopSidebarTab.storageKey
        )
        UserDefaults.standard.set(
            WorkSubTab.loop.rawValue,
            forKey: WorkSubTab.storageKey
        )
        if let workspaceId, TaskQuickActionsBridge.requestFocusWorkspace(workspaceId) {
            return
        }
        if let worktreePath {
            TaskQuickActionsBridge.requestOpenWorktreePath(worktreePath)
        }
    }

    /// Select a workspace terminal for the Tasks board's inline split without
    /// leaving the Tasks route.
    static func showWorkspaceInline(workspaceId: UUID) {
        _ = TaskQuickActionsBridge.requestSelectWorkspaceInline(workspaceId)
    }

    /// Ask the existing Quick Action agent picker to open for the bound
    /// workspace without leaving the Tasks page. No prompt is supplied — the
    /// user picks a template in the existing UI.
    static func startAgentFromTasks(
        context: TaskAgentLaunchContext,
        onLaunchedWorkspaceId: ((UUID) -> Void)? = nil
    ) {
        TaskQuickActionsBridge.requestNewAgentPanel(context, onLaunchedWorkspaceId)
    }

    static func openTaskFile(path: String, displayTitle: String) {
        MarkdownDocumentStore.shared.open(
            fileURL: URL(fileURLWithPath: path, isDirectory: false).resolvingSymlinksInPath(),
            folderName: "TASKS",
            displayTitle: displayTitle,
            mode: .edit
        )
    }
}

/// Indirection point so the actions don't directly couple to AppDelegate /
/// TabManager APIs. The real bridge is set at app startup; tests can stub.
@MainActor
public enum TaskQuickActionsBridge {
    public static var requestFocusWorkspace: (UUID) -> Bool = { _ in false }
    public static var requestSelectWorkspaceInline: (UUID) -> Bool = { _ in false }
    public static var requestOpenWorktreePath: (String) -> Void = { _ in }
    public static var requestNewAgentPanel: (TaskAgentLaunchContext, ((UUID) -> Void)?) -> Void = { _, _ in }
}

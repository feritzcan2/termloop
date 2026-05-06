// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar content when a task is selected. Pulls the selected task's snapshot
/// from the store and shows a compact task command center: breadcrumb, status,
/// repair actions, and projection sections.
struct TaskSidebarDrillInView: View {
    @ObservedObject var store: TaskBoardStore
    @ObservedObject var selection: TaskSelectionStore
    var onRebind: ((UUID) -> Void)?
    var onUnbind: ((UUID) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                breadcrumb
                if let snap = store.selectedTaskDetailSnapshot {
                    header(snap)
                    quickActions(snap)
                    if case .failed = snap.provisionState {
                        TaskRepairBanner(
                            reason: snap.provisionState.failureDisplayText ?? "",
                            onRebind: { onRebind?(snap.id) },
                            onUnbind: { onUnbind?(snap.id) },
                            onArchive: { onArchive?(snap.id); selection.select(nil) }
                        )
                    }
                    sidebarSection { TaskGitChangesSection(worktreePath: snap.worktreePath) }
                    sidebarSection {
                        TaskOpenPRsSection(
                            workspaceId: snap.workspaceId,
                            worktreePath: snap.worktreePath,
                            branch: snap.branch
                        )
                    }
                    sidebarSection {
                        TaskBranchesSection(
                            branch: snap.branch,
                            worktreePath: snap.worktreePath,
                            selectedAgentWorkspaceId: selection.inlineTerminalWorkspaceId,
                            onOpenAgentTerminal: { workspaceId in
                                selection.openInlineTerminal(workspaceId: workspaceId)
                                TaskQuickActions.showWorkspaceInline(workspaceId: workspaceId)
                            }
                        )
                    }
                }
            }
            .padding(10)
        }
    }

    private var breadcrumb: some View {
        Button(action: { selection.select(nil) }) {
            HStack(spacing: 4) {
                Image(systemName: "chevron.left")
                Text(String(localized: "tasks.sidebar.allTasks",
                            defaultValue: "All tasks", table: "TermLoop"))
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(.accentColor)
        }
        .buttonStyle(.plain)
    }

    private func header(_ snap: TaskDetailSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Circle()
                    .fill(snap.provisionState.taskStatusColor)
                    .frame(width: 8, height: 8)
                    .padding(.top, 5)
                VStack(alignment: .leading, spacing: 3) {
                    Text(snap.title)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(2)
                    HStack(spacing: 4) {
                        Text(columnTitle(snap.columnId))
                        Text("·")
                        Text(worktreeSummary(for: snap))
                    }
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                Text(snap.provisionState.taskCompactStatusText)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(snap.provisionState.taskStatusColor)
                    .padding(.vertical, 3)
                    .padding(.horizontal, 8)
                    .background(snap.provisionState.taskStatusColor.opacity(0.12))
                    .clipShape(Capsule())
                Text(statusHint(for: snap))
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private func worktreeSummary(for snap: TaskDetailSnapshot) -> String {
        if let branch = snap.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty {
            return branch
        }
        if let path = snap.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty {
            return URL(fileURLWithPath: path).lastPathComponent
        }
        return String(localized: "tasks.sidebar.header.manualTask",
                      defaultValue: "Manual task", table: "TermLoop")
    }

    private func statusHint(for snap: TaskDetailSnapshot) -> String {
        if snap.workspaceId != nil {
            return String(localized: "tasks.sidebar.status.live",
                          defaultValue: "Live workspace", table: "TermLoop")
        }
        if snap.worktreePath != nil {
            return String(localized: "tasks.sidebar.status.pathOnly",
                          defaultValue: "On disk", table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.status.manual",
                      defaultValue: "Needs worktree", table: "TermLoop")
    }

    private func quickActions(_ snap: TaskDetailSnapshot) -> some View {
        HStack(spacing: 6) {
            Button(String(localized: "tasks.sidebar.action.open",
                          defaultValue: "Open", table: "TermLoop")) {
                TaskQuickActions.openWorktree(workspaceId: snap.workspaceId, worktreePath: snap.worktreePath)
            }
            .disabled(snap.workspaceId == nil && snap.worktreePath == nil)

            Button(String(localized: "tasks.sidebar.action.agent",
                          defaultValue: "+ Agent", table: "TermLoop")) {
                if let workspaceId = snap.workspaceId {
                    TaskQuickActions.addAgentRun(workspaceId: workspaceId)
                }
            }
            .disabled(snap.workspaceId == nil)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private func sidebarSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.48))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func columnTitle(_ id: TaskColumnId) -> String {
        switch id {
        case .backlog: return String(localized: "tasks.column.backlog", defaultValue: "Backlog", table: "TermLoop")
        case .todo: return String(localized: "tasks.column.todo", defaultValue: "Todo", table: "TermLoop")
        case .inProgress: return String(localized: "tasks.column.in_progress", defaultValue: "In Progress", table: "TermLoop")
        case .inReview: return String(localized: "tasks.column.in_review", defaultValue: "In Review", table: "TermLoop")
        case .done: return String(localized: "tasks.column.done", defaultValue: "Done", table: "TermLoop")
        }
    }
}

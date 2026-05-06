// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar content when a task is selected. Pulls the selected task's snapshot
/// from the store and shows a compact task command center: breadcrumb, status,
/// repair actions, and projection sections.
struct TaskSidebarDrillInView: View {
    let detailSnapshot: TaskDetailSnapshot
    @ObservedObject var selection: TaskSelectionStore
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator
    var columnTitle: (TaskColumnId) -> String = { $0.defaultTitle }
    var onRebind: ((UUID) -> Void)?
    var onOpenSettings: () -> Void = {}

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    var onUnbind: ((UUID) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    breadcrumb
                    header(detailSnapshot)
                    quickActions(detailSnapshot)
                    if case .failed = detailSnapshot.provisionState {
                        TaskRepairBanner(
                            reason: detailSnapshot.provisionState.failureDisplayText ?? "",
                            onRebind: { onRebind?(detailSnapshot.id) },
                            onUnbind: { onUnbind?(detailSnapshot.id) },
                            onArchive: { onArchive?(detailSnapshot.id); selection.select(nil) }
                        )
                    }
                    sidebarSection {
                        TaskWorkItemSection(
                            taskId: detailSnapshot.id,
                            taskWorkItem: workItemSnapshot(for: detailSnapshot),
                            workspaceId: detailSnapshot.workspaceId,
                            worktreePath: detailSnapshot.worktreePath,
                            remoteSync: remoteSync
                        )
                    }
                    sidebarSection {
                        TaskGitChangesSection(
                            workspaceId: detailSnapshot.workspaceId,
                            worktreePath: detailSnapshot.worktreePath,
                            branch: detailSnapshot.branch
                        )
                    }
                    sidebarSection {
                        TaskOpenPRsSection(
                            workspaceId: detailSnapshot.workspaceId,
                            worktreePath: detailSnapshot.worktreePath,
                            branch: detailSnapshot.branch
                        )
                    }
                    sidebarSection {
                        TaskBranchesSection(
                            branch: detailSnapshot.branch,
                            worktreePath: detailSnapshot.worktreePath,
                            taskWorkspaceId: detailSnapshot.workspaceId,
                            selectedAgentWorkspaceId: selection.inlineTerminalWorkspaceId,
                            onOpenAgentTerminal: { workspaceId in
                                selection.openInlineTerminal(workspaceId: workspaceId)
                                TaskQuickActions.showWorkspaceInline(workspaceId: workspaceId)
                            }
                        )
                    }
                }
                .padding(10)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            TaskSidebarSettingsButton(action: onOpenSettings)
                .padding(10)
                .padding(.top, 1)
                .background(Color(nsColor: .windowBackgroundColor))
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
        let statusPresentation = TaskStatusPresentation(
            provisionState: snap.provisionState,
            agentStatus: agentStatus(for: snap)
        )
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Circle()
                    .fill(statusPresentation.color)
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
                Text(statusPresentation.text)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(statusPresentation.color)
                    .padding(.vertical, 3)
                    .padding(.horizontal, 8)
                    .background(statusPresentation.color.opacity(0.12))
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

    private func agentStatus(for snap: TaskDetailSnapshot) -> TaskAgentStatusSummary? {
        // Intentional subscription reads: the header mirrors live Loop agent
        // status while Tasks remains a projection-only consumer.
        _ = metadataStore
        _ = activityStore
        return TaskAgentProjectionBuilder.statusSummary(
            worktreePath: snap.worktreePath,
            taskWorkspaceId: snap.workspaceId
        )
    }

    private func workItemSnapshot(for snap: TaskDetailSnapshot) -> TaskWorkItemSnapshot? {
        if let reference = snap.remoteWorkItem {
            return TaskWorkItemProjectionBuilder.remoteSnapshot(
                reference: reference,
                statusLabel: snap.remoteStatusLabel,
                taskFilePath: snap.taskFilePath,
                workspaceId: snap.workspaceId,
                worktreePath: snap.worktreePath
            )
        }
        return TaskWorkItemProjectionBuilder.snapshot(
            workspaceId: snap.workspaceId,
            worktreePath: snap.worktreePath
        )
    }

    private func worktreeSummary(for snap: TaskDetailSnapshot) -> String {
        if let branch = snap.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty {
            return branch
        }
        if let leaf = TaskAgentProjectionBuilder.pathLeaf(snap.worktreePath) {
            return leaf
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

}

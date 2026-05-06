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
    @EnvironmentObject private var tabManager: TabManager
    var onUnbind: ((UUID) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
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
                    flatSection {
                        TaskWorkItemSection(
                            taskId: detailSnapshot.id,
                            taskWorkItem: workItemSnapshot(for: detailSnapshot),
                            workspaceId: detailSnapshot.workspaceId,
                            worktreePath: detailSnapshot.worktreePath,
                            remoteSync: remoteSync
                        )
                    }
                    if hasWorktreeProjections(detailSnapshot) {
                        Divider().opacity(0.6)
                        flatSection {
                            TaskGitChangesSection(
                                workspaceId: detailSnapshot.workspaceId,
                                worktreePath: detailSnapshot.worktreePath,
                                branch: detailSnapshot.branch
                            )
                        }
                        Divider().opacity(0.6)
                        flatSection {
                            TaskOpenPRsSection(
                                workspaceId: detailSnapshot.workspaceId,
                                worktreePath: detailSnapshot.worktreePath,
                                branch: detailSnapshot.branch
                            )
                        }
                        Divider().opacity(0.6)
                        flatSection {
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

    /// Worktree-derived projections (git changes, open PRs, branches) need a
    /// resolved worktree path to fetch anything. With nothing attached, all
    /// three sections collapse to "no worktree path" stubs — useless noise.
    /// Hide the whole block instead and let the user know via the header's
    /// "Needs worktree" status hint.
    private func hasWorktreeProjections(_ snap: TaskDetailSnapshot) -> Bool {
        let trimmedPath = snap.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !trimmedPath.isEmpty
    }

    private var breadcrumb: some View {
        Button(action: { selection.select(nil) }) {
            HStack(spacing: 4) {
                Image(systemName: "chevron.left")
                Text(String(localized: "tasks.sidebar.allTasks",
                            defaultValue: "All tasks", table: "TermLoop"))
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(.accentColor)
        }
        .buttonStyle(.plain)
    }

    private func header(_ snap: TaskDetailSnapshot) -> some View {
        let statusPresentation = TaskStatusPresentation(
            provisionState: snap.provisionState,
            agentStatus: agentStatus(for: snap)
        )
        return HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(statusPresentation.color)
                .frame(width: 9, height: 9)
                .padding(.top, 7)
            VStack(alignment: .leading, spacing: 5) {
                Text(snap.title)
                    .font(.system(size: 16, weight: .semibold))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(columnTitle(snap.columnId))
                        .foregroundStyle(.secondary)
                    Text("·")
                        .foregroundStyle(.tertiary)
                    Text(worktreeSummary(for: snap))
                        .foregroundStyle(.secondary)
                    Text("·")
                        .foregroundStyle(.tertiary)
                    Text(statusPresentation.text)
                        .foregroundStyle(statusPresentation.color)
                }
                .font(.system(size: 12))
                .lineLimit(1)
                .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func agentStatus(for snap: TaskDetailSnapshot) -> TaskAgentStatusSummary? {
        // Intentional subscription reads: the header mirrors live Loop agent
        // status while Tasks remains a projection-only consumer.
        _ = metadataStore
        _ = activityStore
        return TaskAgentProjectionBuilder.statusSummary(
            worktreePath: snap.worktreePath,
            taskWorkspaceId: snap.workspaceId,
            openWorkspaceIds: Set(tabManager.tabs.map(\.id))
        )
    }

    private func workItemSnapshot(for snap: TaskDetailSnapshot) -> TaskWorkItemSnapshot? {
        if let reference = snap.remoteWorkItem {
            return TaskWorkItemProjectionBuilder.remoteSnapshot(
                reference: reference,
                title: snap.title,
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

    private func quickActions(_ snap: TaskDetailSnapshot) -> some View {
        HStack(spacing: 14) {
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
            Spacer(minLength: 0)
        }
        .buttonStyle(.link)
        .font(.system(size: 12, weight: .medium))
    }

    private func flatSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
    }

}

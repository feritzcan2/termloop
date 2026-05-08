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
    var onOpenTaskSpec: ((UUID) -> Void)?
    var onImplementWithAgent: ((UUID) -> Void)?
    var onOpenSettings: () -> Void = {}

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    @EnvironmentObject private var tabManager: TabManager
    var onUnbind: ((UUID) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
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
                        TaskSpecSection(
                            snapshot: detailSnapshot,
                            onOpen: { onOpenTaskSpec?(detailSnapshot.id) }
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
        HStack(spacing: 8) {
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

            Spacer(minLength: 0)

            Button(action: onOpenSettings) {
                Image(systemName: "gearshape")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(String(localized: "tasks.sidebar.settings.open",
                         defaultValue: "Task Settings",
                         table: "TermLoop"))
        }
    }

    private func header(_ snap: TaskDetailSnapshot) -> some View {
        let statusPresentation = TaskStatusPresentation(
            provisionState: snap.provisionState,
            agentStatus: agentStatus(for: snap)
        )
        return VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(statusPresentation.color)
                    .frame(width: 9, height: 9)
                    .padding(.top, 7)
                Text(snap.title)
                    .font(.system(size: 16, weight: .semibold))
                    .lineLimit(2)
                Spacer(minLength: 0)
            }

            statusPills(snap, statusPresentation: statusPresentation)

            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                Text(worktreeSummary(for: snap))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statusPills(
        _ snap: TaskDetailSnapshot,
        statusPresentation: TaskStatusPresentation
    ) -> some View {
        FlowPillRow(spacing: 6) {
            TaskSidebarPill(
                icon: "rectangle.3.group",
                text: String(localized: "tasks.sidebar.header.boardStatus",
                             defaultValue: "Board: \(columnTitle(snap.columnId))",
                             table: "TermLoop"),
                tint: .secondary
            )
            if let remoteStatus = snap.remoteStatusLabel?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .nonEmptyTaskSidebarString {
                TaskSidebarPill(
                    icon: "checklist",
                    text: String(localized: "tasks.sidebar.header.remoteStatus",
                                 defaultValue: "\(remoteProviderLabel(for: snap)): \(remoteStatus)",
                                 table: "TermLoop"),
                    tint: .blue
                )
                if isStatusMismatch(boardStatus: columnTitle(snap.columnId), remoteStatus: remoteStatus) {
                    TaskSidebarPill(
                        icon: "arrow.triangle.2.circlepath",
                        text: String(localized: "tasks.sidebar.header.statusMismatch",
                                     defaultValue: "Out of sync",
                                     table: "TermLoop"),
                        tint: .orange
                    )
                }
            }
            TaskSidebarPill(
                icon: statusPresentation.iconName,
                text: statusPresentation.text,
                tint: statusPresentation.color
            )
        }
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

    private func isStatusMismatch(boardStatus: String, remoteStatus: String) -> Bool {
        normalizedStatus(boardStatus) != normalizedStatus(remoteStatus)
    }

    private func remoteProviderLabel(for snap: TaskDetailSnapshot) -> String {
        switch snap.remoteWorkItem?.provider {
        case .jira:
            return "Jira"
        case .github:
            return "GitHub"
        case .gitlab:
            return "GitLab"
        case nil:
            return String(localized: "tasks.sidebar.header.remoteProvider",
                          defaultValue: "Remote",
                          table: "TermLoop")
        }
    }

    private func normalizedStatus(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .lowercased()
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .joined(separator: " ")
    }

    private func quickActions(_ snap: TaskDetailSnapshot) -> some View {
        HStack(spacing: 6) {
            Button {
                TaskQuickActions.openWorktree(workspaceId: snap.workspaceId, worktreePath: snap.worktreePath)
            } label: {
                Label(String(localized: "tasks.sidebar.action.openWorktree",
                             defaultValue: "Open Worktree",
                             table: "TermLoop"),
                      systemImage: "terminal")
            }
            .disabled(snap.workspaceId == nil && snap.worktreePath == nil)

            Button {
                if let workspaceId = snap.workspaceId {
                    TaskQuickActions.addAgentRun(workspaceId: workspaceId)
                } else {
                    onImplementWithAgent?(snap.id)
                }
            } label: {
                Label(String(localized: "tasks.sidebar.action.agent",
                             defaultValue: snap.workspaceId == nil ? "Implement with Agent" : "Start Agent",
                             table: "TermLoop"),
                      systemImage: "plus")
            }
            .disabled(snap.provisionState == .pending || (snap.workspaceId == nil && onImplementWithAgent == nil))
            Spacer(minLength: 0)
        }
        .buttonStyle(.bordered)
        .controlSize(.mini)
        .font(.system(size: 12, weight: .medium))
    }

    private func flatSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
    }

}

private extension String {
    var nonEmptyTaskSidebarString: String? { isEmpty ? nil : self }
}

private struct TaskSidebarPill: View {
    let icon: String
    let text: String
    let tint: Color

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .semibold))
            Text(text)
                .lineLimit(1)
        }
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(tint)
        .padding(.vertical, 3)
        .padding(.horizontal, 7)
        .background(tint.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct FlowPillRow<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: spacing) {
                content()
            }
            VStack(alignment: .leading, spacing: spacing) {
                content()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lineLimit(1)
    }
}

private extension TaskStatusPresentation {
    var iconName: String {
        switch self.text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case let value where value.contains("failed"):
            return "exclamationmark.triangle"
        case let value where value.contains("ready"):
            return "checkmark.circle"
        case let value where value.contains("pending"):
            return "clock"
        default:
            return "circle.fill"
        }
    }
}

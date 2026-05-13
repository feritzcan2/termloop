// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar content when a task is selected. Pulls the selected task's snapshot
/// from the store and shows a compact task command center: breadcrumb, status,
/// repair actions, and projection sections.
struct TaskSidebarDrillInView: View {
    let detailSnapshot: TaskDetailSnapshot
    let projectId: UUID
    @ObservedObject var selection: TaskSelectionStore
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator
    var columnTitle: (TaskColumnId) -> String = { $0.defaultTitle }
    var onRebind: ((UUID) -> Void)?
    var onOpenTaskSpec: ((UUID) -> Void)?
    var onRefineTaskSpec: ((UUID) -> Void)?
    var onExecuteTaskSpec: ((UUID) -> Void)?
    var onUpdateTitle: ((UUID, String) -> Void)?
    var onUpdateBrief: ((UUID, String?) -> Void)?
    var onCreateWorktree: ((UUID) -> Void)?
    var onStartAgent: ((UUID) -> Void)?
    var onOpenSettings: () -> Void = {}

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    @ObservedObject private var worktreeProjectionStore = WorktreeProjectionStore.shared
    @EnvironmentObject private var tabManager: TabManager
    var onUnbind: ((UUID) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    breadcrumb
                    header(detailSnapshot)
                    flatSection {
                        mergedTaskCard(detailSnapshot)
                    }
                    Divider().opacity(0.6)
                    flatSection {
                        TaskBranchesSection(
                            branch: detailSnapshot.branch,
                            worktreePath: detailSnapshot.worktreePath,
                            projectId: projectId,
                            taskWorkspaceId: detailSnapshot.workspaceId,
                            provisionState: detailSnapshot.provisionState,
                            selectedAgentWorkspaceId: selection.inlineTerminalWorkspaceId,
                            onOpenWorktree: {
                                TaskQuickActions.openWorktree(
                                    workspaceId: detailSnapshot.workspaceId,
                                    worktreePath: detailSnapshot.worktreePath
                                )
                            },
                            onStartAgent: {
                                onStartAgent?(detailSnapshot.id)
                            },
                            onCreateWorktree: {
                                onCreateWorktree?(detailSnapshot.id)
                            },
                            onClearWorktreeError: {
                                onUnbind?(detailSnapshot.id)
                            },
                            onRebind: {
                                onRebind?(detailSnapshot.id)
                            },
                            onUnbind: {
                                onUnbind?(detailSnapshot.id)
                            },
                            onArchive: {
                                onArchive?(detailSnapshot.id)
                                selection.select(nil)
                            },
                            onOpenAgentTerminal: { workspaceId in
                                selection.openInlineTerminal(workspaceId: workspaceId)
                                TaskQuickActions.showWorkspaceInline(workspaceId: workspaceId)
                            }
                        )
                    }
                    if hasWorktreeProjections(detailSnapshot) {
                        // Compact footer for git/PR status — both render as
                        // single-line summaries when empty, full sections when
                        // there is something to show.
                        VStack(alignment: .leading, spacing: 8) {
                            TaskGitChangesSection(
                                workspaceId: detailSnapshot.workspaceId,
                                worktreePath: detailSnapshot.worktreePath,
                                branch: detailSnapshot.branch,
                                projectId: projectId
                            )
                            Divider().opacity(0.6)
                            TaskOpenPRsSection(
                                workspaceId: detailSnapshot.workspaceId,
                                worktreePath: detailSnapshot.worktreePath,
                                branch: detailSnapshot.branch
                            )
                        }
                        .padding(.top, 4)
                    }
                }
                .padding(10)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Single merged card containing the work-item link (Jira/GitHub/GitLab)
    /// and the task.md spec row. Two rows, one card, one shared title — fixes
    /// the prior "Task Spec / Work Item" duplication where the title and
    /// `task.md` reference appeared in both sections.
    @ViewBuilder
    private func mergedTaskCard(_ snap: TaskDetailSnapshot) -> some View {
        let showsWorkItem = shouldShowWorkItemSection(snap)
        VStack(alignment: .leading, spacing: 6) {
            TaskSidebarSectionTitle(
                String(localized: "tasks.sidebar.section.task",
                       defaultValue: "Task",
                       table: "TermLoop")
            )
            VStack(alignment: .leading, spacing: 8) {
                if showsWorkItem {
                    TaskWorkItemSection(
                        taskId: snap.id,
                        taskWorkItem: workItemSnapshot(for: snap),
                        workspaceId: snap.workspaceId,
                        worktreePath: snap.worktreePath,
                        projectId: projectId,
                        remoteSync: remoteSync,
                        unwrapped: true
                    )
                    Divider().opacity(0.35)
                }
                TaskSpecSection(
                    snapshot: snap,
                    onOpen: { onOpenTaskSpec?(snap.id) },
                    onRefineWithAgent: onRefineTaskSpec.map { refine in
                        { refine(snap.id) }
                    },
                    onExecuteWithAgent: onExecuteTaskSpec.map { execute in
                        { execute(snap.id) }
                    },
                    unwrapped: true
                )
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.56))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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

    private func shouldShowWorkItemSection(_ snap: TaskDetailSnapshot) -> Bool {
        guard remoteSync.settings.isEnabled else { return false }
        return snap.remoteWorkItem != nil || snap.workspaceId != nil || hasWorktreeProjections(snap)
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
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(statusPresentation.color)
                    .frame(width: 9, height: 9)
                    .padding(.top, 8)
                VStack(alignment: .leading, spacing: 4) {
                    TaskSidebarTitleField(
                        taskId: snap.id,
                        title: snap.title,
                        onUpdateTitle: onUpdateTitle
                    )
                    TaskSidebarBriefField(
                        taskId: snap.id,
                        brief: snap.brief,
                        onUpdateBrief: onUpdateBrief
                    )
                }
                Spacer(minLength: 0)
            }

            // Single condensed meta line. Provision/agent state already lives
            // in the colored dot above and the Worktree Agents section below —
            // the header keeps just task identity (board column, remote
            // status, optional out-of-sync hint).
            headerMetaLine(snap, statusPresentation: statusPresentation)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func headerMetaLine(
        _ snap: TaskDetailSnapshot,
        statusPresentation: TaskStatusPresentation
    ) -> some View {
        let remoteStatus = remoteSync.settings.isEnabled
            ? snap.remoteStatusLabel?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .nonEmptyTaskSidebarString
            : nil
        let columnText = columnTitle(snap.columnId)
        let mismatch = remoteStatus.map { isStatusMismatch(boardStatus: columnText, remoteStatus: $0) } ?? false

        FlowPillRow(spacing: 6) {
            TaskSidebarPill(
                icon: "rectangle.3.group",
                text: columnText,
                tint: .secondary
            )
            if let remoteStatus {
                TaskSidebarPill(
                    icon: "checklist",
                    text: "\(remoteProviderLabel(for: snap)) · \(remoteStatus)",
                    tint: .blue
                )
            }
            if mismatch {
                TaskSidebarPill(
                    icon: "arrow.triangle.2.circlepath",
                    text: String(localized: "tasks.sidebar.header.statusMismatch",
                                 defaultValue: "Out of sync",
                                 table: "TermLoop"),
                    tint: .orange
                )
            }
            // Surface provision failures (failed/pending) in the header so the
            // dot's red/orange is not silent. Agent "running" status is
            // intentionally NOT mirrored here — it lives in Worktree Agents.
            if statusPresentation.shouldShowInHeader {
                TaskSidebarPill(
                    icon: statusPresentation.iconName,
                    text: statusPresentation.text,
                    tint: statusPresentation.color
                )
            }
        }
    }

    private func agentStatus(for snap: TaskDetailSnapshot) -> TaskAgentStatusSummary? {
        // Intentional subscription reads: the header mirrors live Loop agent
        // status while Tasks remains a projection-only consumer.
        _ = metadataStore
        _ = activityStore
        _ = worktreeProjectionStore.version
        return TaskAgentProjectionBuilder.statusSummary(
            worktreePath: snap.worktreePath,
            taskWorkspaceId: snap.workspaceId,
            projectId: projectId,
            openWorkspaceIds: Set(tabManager.tabs.map(\.id))
        )
    }

    private func workItemSnapshot(for snap: TaskDetailSnapshot) -> TaskWorkItemSnapshot? {
        _ = worktreeProjectionStore.version
        if let reference = snap.remoteWorkItem {
            return TaskWorkItemProjectionBuilder.remoteSnapshot(
                reference: reference,
                title: snap.title,
                statusLabel: snap.remoteStatusLabel,
                urlString: reference.url,
                taskFilePath: snap.taskFilePath,
                workspaceId: snap.workspaceId,
                worktreePath: snap.worktreePath,
                projectId: projectId
            )
        }
        return TaskWorkItemProjectionBuilder.snapshot(
            workspaceId: snap.workspaceId,
            worktreePath: snap.worktreePath,
            projectId: projectId
        )
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

    private func flatSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
    }

}

private extension String {
    var nonEmptyTaskSidebarString: String? { isEmpty ? nil : self }
}

private struct TaskSidebarTitleField: View {
    let taskId: UUID
    let title: String
    var onUpdateTitle: ((UUID, String) -> Void)?

    @State private var draft: String
    @FocusState private var isFocused: Bool

    init(
        taskId: UUID,
        title: String,
        onUpdateTitle: ((UUID, String) -> Void)?
    ) {
        self.taskId = taskId
        self.title = title
        self.onUpdateTitle = onUpdateTitle
        _draft = State(initialValue: title)
    }

    var body: some View {
        TextField(
            String(localized: "tasks.sidebar.title.placeholder",
                   defaultValue: "Task title",
                   table: "TermLoop"),
            text: $draft,
            axis: .vertical
        )
        .textFieldStyle(.plain)
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(.primary)
        .lineLimit(1...3)
        .padding(.vertical, 3)
        .padding(.horizontal, 5)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isFocused ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.035))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(isFocused ? Color.accentColor.opacity(0.45) : Color.primary.opacity(0.08), lineWidth: 1)
        )
        .focused($isFocused)
        .disabled(onUpdateTitle == nil)
        .onSubmit(commit)
        .onChange(of: isFocused) { _, focused in
            if !focused { commit() }
        }
        .onChange(of: taskId) { _, _ in
            draft = title
        }
        .onChange(of: title) { _, newValue in
            if !isFocused { draft = newValue }
        }
        .onDisappear(perform: commit)
        .help(String(localized: "tasks.sidebar.title.help",
                     defaultValue: "Edit task title",
                     table: "TermLoop"))
    }

    private func commit() {
        let normalized = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            draft = title
            return
        }
        guard normalized != title else {
            draft = normalized
            return
        }
        onUpdateTitle?(taskId, normalized)
        draft = normalized
    }
}

private struct TaskSidebarBriefField: View {
    let taskId: UUID
    let brief: String?
    var onUpdateBrief: ((UUID, String?) -> Void)?

    @State private var draft: String
    @FocusState private var isFocused: Bool

    init(
        taskId: UUID,
        brief: String?,
        onUpdateBrief: ((UUID, String?) -> Void)?
    ) {
        self.taskId = taskId
        self.brief = brief
        self.onUpdateBrief = onUpdateBrief
        _draft = State(initialValue: brief ?? "")
    }

    var body: some View {
        TextField(
            String(localized: "tasks.sidebar.brief.placeholder",
                   defaultValue: "Add brief…",
                   table: "TermLoop"),
            text: $draft,
            axis: .vertical
        )
        .textFieldStyle(.plain)
        .font(.system(size: 12, weight: .medium))
        .foregroundColor(draft.isEmpty ? Color.secondary : Color.primary.opacity(0.82))
        .lineLimit(1...4)
        .padding(.vertical, 3)
        .padding(.horizontal, 5)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isFocused ? Color.accentColor.opacity(0.08) : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(isFocused ? Color.accentColor.opacity(0.35) : Color.primary.opacity(0.06), lineWidth: 1)
        )
        .focused($isFocused)
        .disabled(onUpdateBrief == nil)
        .onSubmit(commit)
        .onChange(of: isFocused) { _, focused in
            if !focused { commit() }
        }
        .onChange(of: taskId) { _, _ in
            draft = brief ?? ""
        }
        .onChange(of: brief) { _, newValue in
            if !isFocused { draft = newValue ?? "" }
        }
        .onDisappear(perform: commit)
        .help(String(localized: "tasks.sidebar.brief.help",
                     defaultValue: "Edit task brief",
                     table: "TermLoop"))
    }

    private func commit() {
        let normalized = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = normalized.isEmpty ? nil : normalized
        guard value != brief else {
            draft = normalized
            return
        }
        onUpdateBrief?(taskId, value)
        draft = normalized
    }
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

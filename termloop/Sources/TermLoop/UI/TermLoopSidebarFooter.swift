// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import SwiftUI

extension TermLoopSidebar {
    /// Brutalist monospace footer that replaces upstream's `SidebarFooter` in
    /// `TermLoopSidebar.Root`. One tight row with:
    ///
    ///   • sparkle — Skills + Commands popover (TermLoop-owned).
    ///   • Connect Mobile — enables on-demand mobile pairing (TermLoop-owned).
    ///   • flex spacer.
    ///   • Send Feedback — quick action (calls the upstream closure).
    ///   • update pill — upstream pill, only rendered when `showsPill`.
    ///
    /// DEBUG-only red banner is intentionally absent — a muted `DEV` tag in
    /// the project header replaces it without shouting.
    struct Footer: View {
        @ObservedObject var updateViewModel: UpdateViewModel
        @ObservedObject var fileExplorerState: FileExplorerState
        let onSendFeedback: () -> Void
        var selectedWorkspaceId: UUID?

        var body: some View {
            VStack(spacing: 0) {
                CollapsedWorkspaceFooterRows()
                WorktreeAgentsHiddenRow()
                ActiveAgentsHiddenRow()
                TermLoopSidebarRule()

                HStack(spacing: 10) {
                    SidebarSkillsCommandsButton()

                    MobilePairingButton()
                    CLISocketStatusChip()

                    // Visible only while a `git submodule update --init
                    // --recursive` task is in flight (or failed). Opens a
                    // sheet that lists each active task + lets the user
                    // cancel. Collapses to EmptyView when the store is
                    // idle so the footer stays clean. Hides tasks for the
                    // actively viewed workspace (content area shows them).
                    SubmoduleInitFooterChip(activeWorkspaceId: selectedWorkspaceId)

                    Spacer(minLength: 6)

                    FeedbackGlyphButton(action: onSendFeedback)

                    // Upstream capsule pill; only visible when there's an
                    // update to surface. Keeps accent/red semantics intact.
                    UpdatePill(model: updateViewModel)
                }
                .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                .padding(.vertical, 6)
            }
            .frame(maxWidth: .infinity)
            .background(Color.clear)
        }
    }
}


@MainActor
private struct CollapsedWorkspaceFooterRows: View {
    @EnvironmentObject private var tabManager: TabManager
    @ObservedObject private var projectStore = ProjectStore.shared
    @State private var snapshot = FooterSnapshot()
    @AppStorage("termloop.collapsedFooter.sectionCollapsed.v1") private var sectionCollapsed: Bool = false

    private struct WorktreeGroup: Identifiable, Equatable {
        let id: String
        let branch: String
        let workspaceIds: [UUID]
    }

    private struct FooterSnapshot: Equatable {
        var worktreeGroups: [WorktreeGroup] = []
        var agentRows: [WorkspaceMetadataStore.HiddenWorkspaceProjection] = []
        var archivedTasks: [TaskCardSummary] = []

        var count: Int {
            worktreeGroups.reduce(0) { $0 + $1.workspaceIds.count }
                + agentRows.count
                + archivedTasks.count
        }

        var isEmpty: Bool {
            worktreeGroups.isEmpty && agentRows.isEmpty && archivedTasks.isEmpty
        }
    }

    var body: some View {
        Group {
            if !snapshot.isEmpty {
                VStack(spacing: 1) {
                    TermLoopSidebarRule()

                    Button {
                        sectionCollapsed.toggle()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "archivebox")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                                .frame(width: 10, height: 10)
                            Text(TermLoopSidebarTheme.caps(String(
                                localized: "workspaceCollapse.footer.title",
                                defaultValue: "Archived",
                                table: "TermLoop"
                            )))
                            .font(TermLoopSidebarTheme.sectionCaps)
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            Spacer()
                            Text(verbatim: "\(snapshot.count)")
                                .font(TermLoopSidebarTheme.tinyMono)
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                                .monospacedDigit()
                            Image(systemName: sectionCollapsed ? "chevron.up" : "chevron.down")
                                .font(.system(size: 8, weight: .semibold))
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                                .frame(width: 10, height: 10)
                        }
                        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(String(
                        localized: "workspaceCollapse.footer.toggleHelp",
                        defaultValue: "Show or hide archived workspaces and tasks",
                        table: "TermLoop"
                    ))

                    if !sectionCollapsed {
                        ForEach(snapshot.worktreeGroups) { group in
                            footerRow(
                                iconName: "shippingbox.fill",
                                title: group.branch,
                                detail: "\(group.workspaceIds.count)",
                                isWorktree: true,
                                onRestore: { restore(workspaceIds: group.workspaceIds) },
                                onDelete: { delete(workspaceIds: group.workspaceIds, targetName: group.branch) },
                                deleteHelp: String(
                                    localized: "workspaceCollapse.footer.deleteHelp",
                                    defaultValue: "Delete collapsed workspace",
                                    table: "TermLoop"
                                ),
                                restoreHelp: String(
                                    localized: "workspaceCollapse.footer.worktreeHelp",
                                    defaultValue: "Restore this worktree and auto-resume saved agents",
                                    table: "TermLoop"
                                )
                            )
                        }

                        ForEach(snapshot.agentRows) { summary in
                            let title = agentTitle(summary)
                            footerRow(
                                iconName: "circle.fill",
                                title: title,
                                detail: nil,
                                isWorktree: false,
                                onRestore: { restore(workspaceIds: [summary.id]) },
                                onDelete: { delete(workspaceIds: [summary.id], targetName: title) },
                                deleteHelp: String(
                                    localized: "workspaceCollapse.footer.deleteHelp",
                                    defaultValue: "Delete collapsed workspace",
                                    table: "TermLoop"
                                ),
                                restoreHelp: String(
                                    localized: "workspaceCollapse.footer.agentHelp",
                                    defaultValue: "Restore this agent and auto-resume its saved session",
                                    table: "TermLoop"
                                )
                            )
                        }

                        ForEach(snapshot.archivedTasks) { task in
                            footerRow(
                                iconName: "checklist",
                                title: task.title,
                                detail: nil,
                                isWorktree: false,
                                onRestore: { restoreArchivedTask(task.id) },
                                onDelete: { deleteArchivedTask(task.id) },
                                deleteHelp: String(
                                    localized: "tasks.card.menu.delete",
                                    defaultValue: "Delete",
                                    table: "TermLoop"
                                ),
                                restoreHelp: String(
                                    localized: "tasks.sidebar.archived.restore.help",
                                    defaultValue: "Restore task",
                                    table: "TermLoop"
                                )
                            )
                        }
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .onAppear {
            rebuildSnapshot()
        }
        .onChange(of: projectStore.activeProjectId) {
            rebuildSnapshot()
        }
        .onReceive(WorkspaceMetadataStore.shared.$hiddenVersion.removeDuplicates()) { _ in
            rebuildSnapshot()
        }
        .onReceive(activeArchivedSnapshotsPublisher.dropFirst()) { archivedTasks in
            rebuildSnapshot(archivedTasks: archivedTasks)
        }
    }

    private var activeTaskStore: TaskBoardStore? {
        guard let activeProjectId = projectStore.activeProjectId else { return nil }
        return TaskBoardStoreProvider.shared.store(for: activeProjectId)
    }

    private var activeArchivedSnapshotsPublisher: AnyPublisher<[TaskCardSummary], Never> {
        activeTaskStore?.$archivedSnapshots.eraseToAnyPublisher()
            ?? Empty().eraseToAnyPublisher()
    }

    private func rebuildSnapshot(archivedTasks providedArchivedTasks: [TaskCardSummary]? = nil) {
        let archivedTasks = providedArchivedTasks ?? activeTaskStore?.archivedSnapshots ?? []
        let archivedWorkspaceIds = Set(archivedTasks.compactMap(\.workspaceId))
        let summaries = WorkspaceMetadataStore.shared.hiddenWorkspaceProjections(
            projectId: projectStore.activeProjectId,
            excludingWorkspaceIds: archivedWorkspaceIds
        )
        .sorted { lhs, rhs in
            (lhs.branch ?? "") < (rhs.branch ?? "")
        }
        let nextSnapshot = FooterSnapshot(
            worktreeGroups: groupedWorktrees(from: summaries),
            agentRows: summaries.filter { ($0.branch ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
            archivedTasks: archivedTasks
        )
        guard snapshot != nextSnapshot else { return }
        snapshot = nextSnapshot
    }

    private func groupedWorktrees(
        from summaries: [WorkspaceMetadataStore.HiddenWorkspaceProjection]
    ) -> [WorktreeGroup] {
        var buckets: [String: [WorkspaceMetadataStore.HiddenWorkspaceProjection]] = [:]
        for summary in summaries {
            let branch = (summary.branch ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !branch.isEmpty else { continue }
            let projectKey = summary.projectId?.uuidString ?? "project"
            buckets["\(projectKey)|\(branch)", default: []].append(summary)
        }
        return buckets.map { key, values in
            let sorted = values.sorted { $0.id.uuidString < $1.id.uuidString }
            return WorktreeGroup(
                id: key,
                branch: sorted.first?.branch ?? key,
                workspaceIds: sorted.map(\.id)
            )
        }
        .sorted { $0.branch.localizedStandardCompare($1.branch) == .orderedAscending }
    }

    private func restore(workspaceIds: [UUID]) {
        for workspaceId in workspaceIds {
            _ = WorkspaceHideCoordinator.unhide(
                workspaceId: workspaceId,
                tabManager: tabManager
            )
        }
    }

    private func delete(workspaceIds: [UUID], targetName: String) {
        guard confirmDelete(targetName: targetName, workspaceCount: workspaceIds.count) else { return }
        for workspaceId in workspaceIds {
            _ = WorkspaceMetadataStore.shared.removeMetadataForId(workspaceId)
        }
        TermLoopHooks.saveCriticalAgentRestoreStateSync()
    }

    private func confirmDelete(targetName: String, workspaceCount: Int) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        let trimmedName = targetName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedName.isEmpty {
            let format = String(
                localized: "workspaceCollapse.footer.deleteConfirm.namedTitle",
                defaultValue: "Delete %@?",
                table: "TermLoop"
            )
            alert.messageText = String.localizedStringWithFormat(format, trimmedName)
        } else {
            alert.messageText = String(
                localized: "workspaceCollapse.footer.deleteConfirm.title",
                defaultValue: "Delete collapsed workspace?",
                table: "TermLoop"
            )
        }
        if workspaceCount == 1 {
            alert.informativeText = String(
                localized: "workspaceCollapse.footer.deleteConfirm.singleBody",
                defaultValue: "This removes the saved collapsed workspace from the sidebar. It cannot be restored from this list afterwards.",
                table: "TermLoop"
            )
        } else {
            let format = String(
                localized: "workspaceCollapse.footer.deleteConfirm.multipleBody",
                defaultValue: "This removes %d saved collapsed workspaces from the sidebar. They cannot be restored from this list afterwards.",
                table: "TermLoop"
            )
            alert.informativeText = String.localizedStringWithFormat(format, workspaceCount)
        }
        alert.addButton(withTitle: String(
            localized: "workspaceCollapse.footer.deleteConfirm.delete",
            defaultValue: "Delete",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func agentTitle(_ summary: WorkspaceMetadataStore.HiddenWorkspaceProjection) -> String {
        let restoredTitle = summary.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let restoredTitle, !restoredTitle.isEmpty { return restoredTitle }
        let agentName = summary.agentId.flatMap { TerminalAgentRegistry.shared.agent(id: $0)?.displayName }
            ?? summary.agentId
        let cwdName = summary.cwd.map { ($0 as NSString).lastPathComponent }
        let title = [agentName, cwdName]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        if !title.isEmpty { return title }
        return String(
            localized: "workspaceCollapse.footer.unknownAgent",
            defaultValue: "Collapsed agent",
            table: "TermLoop"
        )
    }

    private func footerRow(
        iconName: String,
        title: String,
        detail: String?,
        isWorktree: Bool,
        onRestore: @escaping () -> Void,
        onDelete: (() -> Void)?,
        deleteHelp: String?,
        restoreHelp: String
    ) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.uturn.up")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .frame(width: 10)
            Image(systemName: iconName)
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(isWorktree ? TermLoopSidebarTheme.accent : TermLoopSidebarTheme.dim)
                .frame(width: 10, height: 10)
            if isWorktree {
                TermLoopSidebarToken(
                    label: "WORKTREE",
                    iconSystemName: "arrow.triangle.branch",
                    tone: .accent,
                    emphasized: true
                )
            }
            Text(title)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(Color.primary.opacity(0.82))
                .lineLimit(1)
                .truncationMode(.middle)
            if let detail {
                Text(verbatim: detail)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .monospacedDigit()
            }
            Spacer()
            Button(action: onRestore) {
                Text(String(
                    localized: "workspaceCollapse.footer.restore",
                    defaultValue: "restore",
                    table: "TermLoop"
                ))
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            }
            .buttonStyle(.plain)
            .help(restoreHelp)
            if let onDelete {
                Button(action: onDelete) {
                    Image(systemName: "trash")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 14, height: 14)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(deleteHelp ?? "")
            }
        }
        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }

    private func restoreArchivedTask(_ taskId: UUID) {
        guard let store = activeTaskStore else { return }
        try? TaskLifecycleCoordinator.makeForProject(store: store).restoreTask(taskId)
        rebuildSnapshot()
    }

    private func deleteArchivedTask(_ taskId: UUID) {
        guard let store = activeTaskStore else { return }
        try? TaskLifecycleCoordinator.makeForProject(store: store).deleteTask(taskId)
        rebuildSnapshot()
    }
}

/// Bare mono text button that opens the feedback composer. Keeps the footer
/// typographically consistent — no SF Symbol rendering, no capsule.
private struct FeedbackGlyphButton: View {
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Text(verbatim: "Send Feedback")
                .font(TermLoopSidebarTheme.bodyMonoStrong)
                .foregroundStyle(isHovering
                                 ? Color.primary
                                 : TermLoopSidebarTheme.dim)
                .lineLimit(1)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help(String(
            localized: "feedback.glyph.tooltip",
            defaultValue: "Send feedback", table: "TermLoop"
        ))
    }
}

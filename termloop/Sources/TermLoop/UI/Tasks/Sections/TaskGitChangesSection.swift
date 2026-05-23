// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import SwiftUI

/// Sidebar drill-in section: count-only uncommitted changes for the selected task's worktree.
/// File rows stay in the full Git Changes page; the sidebar only acts as a
/// compact launcher so task drill-in does not become a cramped diff preview.
struct TaskGitChangesSection: View {
    let workspaceId: UUID?
    let worktreePath: String?
    let branch: String?
    let projectId: UUID?

    @EnvironmentObject private var tabManager: TabManager
    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var worktreeProjectionStore = WorktreeProjectionStore.shared
    @State private var files: [SidebarGitChangeItem] = []

    private var filesPublisher: AnyPublisher<[SidebarGitChangeItem], Never> {
        guard let path = normalizedWorktreePath else {
            return Just([]).eraseToAnyPublisher()
        }
        return GitWorktreePresentationStore.shared.filesPublisher(for: path)
    }

    var body: some View {
        Group {
            if normalizedWorktreePath == nil {
                compactInlineRow(
                    icon: "exclamationmark.circle",
                    text: String(localized: "tasks.sidebar.section.gitChanges.unbound",
                                 defaultValue: "Git: no worktree", table: "TermLoop"),
                    tint: .secondary
                )
            } else if files.isEmpty {
                compactInlineRow(
                    icon: "checkmark.circle",
                    text: String(localized: "tasks.sidebar.section.gitChanges.clean",
                                 defaultValue: "Git: clean", table: "TermLoop"),
                    tint: .secondary
                )
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    TaskSidebarSectionTitle(
                        String(localized: "tasks.sidebar.section.gitChanges",
                               defaultValue: "Git Changes", table: "TermLoop")
                    )
                    summaryButton
                }
            }
        }
        .onReceive(filesPublisher) { files = $0 }
        .onAppear { refreshFiles() }
        .onChange(of: normalizedWorktreePath) { _, _ in refreshFiles() }
    }

    @ViewBuilder
    private func compactInlineRow(icon: String, text: String, tint: Color) -> some View {
        Button(action: { if canOpenDiffPage { openDiffPage() } }) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                Text(text)
                    .font(.system(size: 11, weight: .medium))
                Spacer(minLength: 0)
                if canOpenDiffPage {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .foregroundStyle(tint)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canOpenDiffPage)
    }

    private var summaryButton: some View {
        Button(action: openDiffPage) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: files.isEmpty ? "checkmark.circle" : "square.and.pencil")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(files.isEmpty ? Color.secondary : Color.orange)
                    Text(changeCountText(files.count))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.primary)
                    Spacer(minLength: 0)
                    if canOpenDiffPage {
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Color.secondary)
                    }
                }

                if !files.isEmpty {
                    statusCountStrip
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canOpenDiffPage)
        .help(canOpenDiffPage ? String(localized: "tasks.sidebar.section.gitChanges.openDiffHelp",
                                      defaultValue: "Open the Git Changes diff page",
                                      table: "TermLoop")
                              : String(localized: "tasks.sidebar.section.gitChanges.noWorkspaceHelp",
                                       defaultValue: "A live workspace is required to open the diff page.",
                                       table: "TermLoop"))
    }

    private var statusCountStrip: some View {
        HStack(spacing: 10) {
            ForEach(statusCounts, id: \.status.rawValue) { item in
                HStack(spacing: 3) {
                    Text(item.status.sidebarSymbol)
                    Text("\(item.count)")
                }
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(item.status.sidebarTint)
            }
        }
    }

    private var statusCounts: [(status: GitFileStatus, count: Int)] {
        GitFileStatus.taskSidebarDisplayOrder.compactMap { status in
            let count = files.filter { $0.status == status }.count
            guard count > 0 else { return nil }
            return (status, count)
        }
    }

    private var resolvedWorkspaceId: UUID? {
        _ = worktreeProjectionStore.version
        if let liveWorkspaceId = liveWorkspaceIdMatchingPath {
            return liveWorkspaceId
        }
        if let workspaceId, tabManager.tabs.contains(where: { $0.id == workspaceId }) {
            return workspaceId
        }
        guard let path = normalizedWorktreePath else { return workspaceId }
        if let projectId,
           let projection = WorktreeProjectionStore.shared.snapshot(projectId: projectId),
           let id = projection.workspaceIds(forWorktreePath: path).first {
            return id
        }
        return metadataStore.workspaceIds(withWorktreePath: path).first ?? workspaceId
    }

    private var liveWorkspaceIdMatchingPath: UUID? {
        guard let path = normalizedWorktreePath else { return nil }
        guard let pathKey = TaskPathNormalization.resolveDisplayAndKey(path)?.keyPath else { return nil }
        return tabManager.tabs.first { workspace in
            workspacePathKeys(workspace).contains(pathKey)
        }?.id
    }

    private func workspacePathKeys(_ workspace: Workspace) -> Set<String> {
        Set([
            metadataStore.worktreePath(forWorkspaceId: workspace.id),
            workspace.termLoopPresentationCwd(),
            workspace.currentDirectory
        ].compactMap { TaskPathNormalization.resolveDisplayAndKey($0)?.keyPath })
    }

    private var canOpenDiffPage: Bool {
        resolvedWorkspaceId != nil && normalizedWorktreePath != nil
    }

    private func openDiffPage() {
        guard let workspaceId = resolvedWorkspaceId,
              let path = normalizedWorktreePath else { return }
        GitChangesMainAreaStore.shared.show(
            WorktreeChangesPresentation(
                workspaceId: workspaceId,
                branch: normalizedBranch,
                worktreePath: path,
                baselineHead: metadataStore.metadata(forWorkspaceId: workspaceId).worktreeBaselineHead
            )
        )
    }

    private func changeCountText(_ count: Int) -> String {
        if count == 1 {
            return String(localized: "tasks.sidebar.section.gitChanges.count.one",
                          defaultValue: "1 change",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.section.gitChanges.count.many",
                      defaultValue: "\(count) changes",
                      table: "TermLoop")
    }

    private var normalizedWorktreePath: String? {
        guard let worktreePath else { return nil }
        return TaskPathNormalization.resolveDisplayAndKey(worktreePath)?.displayPath
    }

    private var normalizedBranch: String? {
        let trimmed = branch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func refreshFiles() {
        guard let path = normalizedWorktreePath else {
            files = []
            return
        }
        files = GitWorktreePresentationStore.shared.files(for: path)
    }
}


private extension GitFileStatus {
    static var taskSidebarDisplayOrder: [GitFileStatus] {
        [.modified, .added, .deleted, .renamed, .untracked]
    }
}

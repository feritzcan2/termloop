// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import SwiftUI

/// Sidebar drill-in section: uncommitted changes in the selected task's worktree.
struct TaskGitChangesSection: View {
    let worktreePath: String?

    @State private var files: [SidebarGitChangeItem] = []

    private var filesPublisher: AnyPublisher<[SidebarGitChangeItem], Never> {
        guard let path = normalizedWorktreePath else {
            return Just([]).eraseToAnyPublisher()
        }
        return GitWorktreePresentationStore.shared.filesPublisher(for: path)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TaskSidebarSectionTitle(
                String(localized: "tasks.sidebar.section.gitChanges",
                       defaultValue: "GIT CHANGES", table: "TermLoop")
            )
            if normalizedWorktreePath == nil {
                TaskSidebarEmptyText(
                    String(localized: "tasks.sidebar.section.gitChanges.unbound",
                           defaultValue: "No worktree path attached.", table: "TermLoop")
                )
            } else if files.isEmpty {
                TaskSidebarEmptyText(
                    String(localized: "tasks.sidebar.section.gitChanges.empty",
                           defaultValue: "No changes.", table: "TermLoop")
                )
            } else {
                gitRows
            }
        }
        .onReceive(filesPublisher) { files = $0 }
        .onAppear { refreshFiles() }
        .onChange(of: normalizedWorktreePath) { _, _ in refreshFiles() }
    }

    private var gitRows: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(files.prefix(5)), id: \.path) { file in
                HStack(spacing: 6) {
                    Text(file.status.sidebarSymbol)
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundColor(file.status.sidebarTint)
                        .frame(width: 18, alignment: .leading)
                    Text(file.path)
                        .font(.system(size: 11, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .help(file.path)
            }
            let overflow = max(0, files.count - 5)
            if overflow > 0 {
                TaskSidebarEmptyText(
                    String(localized: "tasks.sidebar.section.gitChanges.more",
                           defaultValue: "+ \(overflow) more changes", table: "TermLoop")
                )
            }
        }
    }

    private var normalizedWorktreePath: String? {
        guard let worktreePath else { return nil }
        return TaskPathNormalization.resolveDisplayAndKey(worktreePath)?.displayPath
    }

    private func refreshFiles() {
        guard let path = normalizedWorktreePath else {
            files = []
            return
        }
        files = GitWorktreePresentationStore.shared.files(for: path)
    }
}

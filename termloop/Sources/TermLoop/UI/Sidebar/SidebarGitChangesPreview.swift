// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Module-level (not `static let` on the `@MainActor` struct) so it can be
/// used as a default argument — default-argument expressions run in a
/// nonisolated context and SE-0411 rejects reading main-actor state there.
let sidebarGitChangesPreviewDefaultMaxVisible: Int = 5

/// Compact inline list of git-changed files shown under a workspace row.
/// Display-only; file taps go back through callbacks into the existing
/// Git Changes flow.

@MainActor
struct SidebarGitChangesPreview: View {
    let files: [SidebarGitChangeItem]
    let maxVisible: Int
    let onSelectFile: (String) -> Void
    let onShowAll: () -> Void

    init(
        files: [SidebarGitChangeItem],
        maxVisible: Int = sidebarGitChangesPreviewDefaultMaxVisible,
        onSelectFile: @escaping (String) -> Void,
        onShowAll: @escaping () -> Void
    ) {
        self.files = files
        self.maxVisible = maxVisible
        self.onSelectFile = onSelectFile
        self.onShowAll = onShowAll
    }

    var body: some View {
        let visible = Array(files.prefix(maxVisible))
        let overflow = max(0, files.count - visible.count)
        VStack(alignment: .leading, spacing: 2) {
            ForEach(visible, id: \.path) { file in
                Button {
                    onSelectFile(file.path)
                } label: {
                    HStack(spacing: 6) {
                        Text(file.status.sidebarSymbol)
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .foregroundStyle(file.status.sidebarTint)
                            .frame(width: 18, alignment: .leading)
                        Text(file.path)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(file.path)
            }

            if overflow > 0 {
                Button {
                    onShowAll()
                } label: {
                    Text(String(
                        localized: "sidebarGitChangesPreview.moreChanges",
                        defaultValue: "+ \(overflow) more changes",
                        table: "TermLoop"
                    ))
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(String(
                    localized: "sidebarGitChangesPreview.moreChanges.help",
                    defaultValue: "Open all Git changes for this workspace",
                    table: "TermLoop"
                ))
            }
        }
        .padding(.vertical, 3)
    }
}

/// Canonical sidebar status formatting. Shared across the Folders tree,
/// Worktree Agents rows, the inline preview, and the full Changes view.
extension GitFileStatus {
    var sidebarSymbol: String {
        switch self {
        case .modified: return "M"
        case .added: return "A"
        case .deleted: return "D"
        case .renamed: return "R"
        case .untracked: return "??"
        }
    }

    var sidebarTint: Color {
        switch self {
        case .modified: return .orange
        case .added: return .green
        case .deleted: return .red
        case .renamed: return .blue
        case .untracked: return .yellow
        }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Replaces the upstream "Branch + directory row" block inside `TabItemView`.
///
/// Renders the same compact or vertical branch/directory line the workspace
/// row would normally show — unless the enclosing folder header already
/// exposes a shared branch + directory chip (`TermLoopFolderSharedContext`),
/// in which case the row stays silent to avoid repeating the same info.
struct TermLoopSidebarBranchDirectoryRow: View {
    let tab: Workspace
    let isActive: Bool
    let settings: SidebarTabItemSettingsSnapshot

    @Environment(\.termLoopFolderSharedContext) private var folderSharedContext

    var body: some View {
        let detailVisibility = settings.visibleAuxiliaryDetails
        if detailVisibility.showsBranchDirectory,
           let visibleContent = visibleContent(detailVisibility: detailVisibility) {
            visibleContent
        }
    }

    // MARK: - Decision

    @ViewBuilder
    private func visibleContent(detailVisibility: SidebarWorkspaceAuxiliaryDetailVisibility) -> AnyView? {
        let summary = tab.sidebarBranchDirectorySummary()
        if let folderSharedContext, folderSharedContext.fullyCovers(summary) {
            return nil
        }
        if settings.usesVerticalBranchLayout {
            return AnyView(verticalBody)
        } else {
            return AnyView(compactBody)
        }
    }

    // MARK: - Vertical layout

    @ViewBuilder
    private var verticalBody: some View {
        let lines = verticalBranchDirectoryLines()
        if !lines.isEmpty {
            let showsWorktreeBadge = isWorktreeBacked
            let branchLinesContainBranch = settings.showsGitBranch && lines.contains { $0.branch != nil }
            HStack(alignment: .top, spacing: 3) {
                if settings.showsGitBranchIcon, branchLinesContainBranch {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 9))
                        .foregroundColor(activeSecondaryColor(0.6))
                }
                VStack(alignment: .leading, spacing: 1) {
                    if showsWorktreeBadge {
                        worktreeBadge
                            .padding(.bottom, 1)
                    }
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        HStack(spacing: 3) {
                            if let branch = line.branch {
                                Text(branch)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(activeSecondaryColor(0.75))
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                            if line.branch != nil, line.directory != nil {
                                Image(systemName: "circle.fill")
                                    .font(.system(size: 3))
                                    .foregroundColor(activeSecondaryColor(0.6))
                                    .padding(.horizontal, 1)
                            }
                            if let directory = line.directory {
                                Text(directory)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(activeSecondaryColor(0.75))
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Compact layout

    @ViewBuilder
    private var compactBody: some View {
        let gitSummary = compactGitBranchSummaryText()
        let dirSummary = compactDirectorySummaryText()
        if let dirRow = branchDirectoryRow(gitSummary: gitSummary, directorySummary: dirSummary) {
            HStack(spacing: 3) {
                if isWorktreeBacked {
                    worktreeBadge
                }
                if settings.showsGitBranchIcon, gitSummary != nil {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 9))
                        .foregroundColor(activeSecondaryColor(0.6))
                }
                Text(dirRow)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(activeSecondaryColor(0.75))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
    }

    // MARK: - Summary helpers

    private struct VerticalBranchDirectoryLine {
        let branch: String?
        let directory: String?
    }

    private func verticalBranchDirectoryLines() -> [VerticalBranchDirectoryLine] {
        let orderedPanelIds = tab.sidebarOrderedPanelIds()
        let entries = tab.sidebarBranchDirectoryEntriesInDisplayOrder(orderedPanelIds: orderedPanelIds)
        let home = SidebarPathFormatter.homeDirectoryPath
        return entries.compactMap { entry in
            let branchText: String? = {
                guard settings.showsGitBranch, let branch = entry.branch else { return nil }
                return "\(branch)\(entry.isDirty ? "*" : "")"
            }()

            let directoryText: String? = {
                guard let directory = entry.directory else { return nil }
                let shortened = SidebarPathFormatter.shortenedPath(directory, homeDirectoryPath: home)
                return shortened.isEmpty ? nil : shortened
            }()

            switch (branchText, directoryText) {
            case let (branch?, directory?):
                return VerticalBranchDirectoryLine(branch: branch, directory: directory)
            case let (branch?, nil):
                return VerticalBranchDirectoryLine(branch: branch, directory: nil)
            case let (nil, directory?):
                return VerticalBranchDirectoryLine(branch: nil, directory: directory)
            default:
                return nil
            }
        }
    }

    private func compactGitBranchSummaryText() -> String? {
        guard settings.showsGitBranch else { return nil }
        let orderedPanelIds = tab.sidebarOrderedPanelIds()
        let lines = tab.sidebarGitBranchesInDisplayOrder(orderedPanelIds: orderedPanelIds).map { branch in
            "\(branch.branch)\(branch.isDirty ? "*" : "")"
        }
        guard !lines.isEmpty else { return nil }
        return lines.joined(separator: " | ")
    }

    private func compactDirectorySummaryText() -> String? {
        let orderedPanelIds = tab.sidebarOrderedPanelIds()
        let home = SidebarPathFormatter.homeDirectoryPath
        let entries = tab.sidebarDirectoriesInDisplayOrder(orderedPanelIds: orderedPanelIds).compactMap { directory -> String? in
            let shortened = SidebarPathFormatter.shortenedPath(directory, homeDirectoryPath: home)
            return shortened.isEmpty ? nil : shortened
        }
        return entries.isEmpty ? nil : entries.joined(separator: " | ")
    }

    private func branchDirectoryRow(gitSummary: String?, directorySummary: String?) -> String? {
        var parts: [String] = []
        if let gitSummary { parts.append(gitSummary) }
        if let directorySummary { parts.append(directorySummary) }
        let joined = parts.joined(separator: " · ")
        return joined.isEmpty ? nil : joined
    }

    private var isWorktreeBacked: Bool {
        let branch = WorkspaceMetadataStore.shared.branch(for: tab)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !branch.isEmpty
    }

    private var worktreeBadge: some View {
        TermLoopSidebarToken(
            label: "WORKTREE",
            iconSystemName: "arrow.triangle.branch",
            tone: isActive ? .accent : .neutral,
            emphasized: true
        )
    }

    // MARK: - Colors

    private func activeSecondaryColor(_ opacity: Double = 0.75) -> Color {
        isActive
            ? Color(nsColor: sidebarSelectedWorkspaceForegroundNSColor(opacity: CGFloat(opacity)))
            : .secondary
    }
}

extension TermLoopHooks {
    @MainActor
    @ViewBuilder
    static func sidebarBranchDirectoryRow(
        tab: Workspace,
        isActive: Bool,
        settings: SidebarTabItemSettingsSnapshot
    ) -> some View {
        TermLoopSidebarBranchDirectoryRow(tab: tab, isActive: isActive, settings: settings)
    }
}

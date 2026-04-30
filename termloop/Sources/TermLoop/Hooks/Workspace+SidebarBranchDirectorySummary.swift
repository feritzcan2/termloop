// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Snapshot of the branch + directory strings a workspace row would display
/// in the sidebar. Used to decide whether a folder's shared-context chip can
/// stand in for the per-row branch/directory line.
///
/// Values mirror what `TabItemView`'s `gitBranchSummaryText` and
/// `directorySummaryText` produce for a given workspace — computed from the
/// same `sidebarGitBranchesInDisplayOrder` / `sidebarDirectoriesInDisplayOrder`
/// feeds so equality here implies the displayed line matches exactly.
struct SidebarBranchDirectorySummary: Equatable {
    let branchSummary: String?
    let directorySummary: String?

    var isEmpty: Bool {
        (branchSummary?.isEmpty ?? true) && (directorySummary?.isEmpty ?? true)
    }
}

extension Workspace {
    fileprivate func computeSidebarBranchDirectorySummary(
        orderedPanelIds: [UUID]
    ) -> SidebarBranchDirectorySummary {
        let branchLines = sidebarGitBranchesInDisplayOrder(orderedPanelIds: orderedPanelIds).map { branch in
            "\(branch.branch)\(branch.isDirty ? "*" : "")"
        }
        let home = SidebarPathFormatter.homeDirectoryPath
        let directoryEntries = sidebarDirectoriesInDisplayOrder(orderedPanelIds: orderedPanelIds).compactMap { directory -> String? in
            let shortened = SidebarPathFormatter.shortenedPath(directory, homeDirectoryPath: home)
            return shortened.isEmpty ? nil : shortened
        }
        return SidebarBranchDirectorySummary(
            branchSummary: branchLines.isEmpty ? nil : branchLines.joined(separator: " | "),
            directorySummary: directoryEntries.isEmpty ? nil : directoryEntries.joined(separator: " | ")
        )
    }

    fileprivate func cachedSidebarBranchDirectorySummary() -> SidebarBranchDirectorySummary {
        let structureRevision = bonsplitController.sidebarStructureRevision
        let summaryRevision = sidebarSummaryRevision
        if let cachedEntry = sidebarBranchDirectorySummaryCacheEntry,
           cachedEntry.structureRevision == structureRevision,
           cachedEntry.summaryRevision == summaryRevision {
            return cachedEntry.value
        }

        let summary = computeSidebarBranchDirectorySummary(
            orderedPanelIds: sidebarOrderedPanelIds()
        )
        sidebarBranchDirectorySummaryCacheEntry = SidebarBranchDirectorySummaryCacheEntry(
            structureRevision: structureRevision,
            summaryRevision: summaryRevision,
            value: summary
        )
        return summary
    }

    /// Same joined branch summary text that the workspace row displays.
    /// Returns `nil` when no branch info is available.
    func sidebarBranchSummaryForFolderSharing() -> String? {
        cachedSidebarBranchDirectorySummary().branchSummary
    }

    /// Same joined directory summary text that the workspace row displays.
    /// Returns `nil` when no directory info is available.
    func sidebarDirectorySummaryForFolderSharing() -> String? {
        cachedSidebarBranchDirectorySummary().directorySummary
    }

    func sidebarBranchDirectorySummary() -> SidebarBranchDirectorySummary {
        cachedSidebarBranchDirectorySummary()
    }
}

/// Environment-propagated context telling a workspace row that its parent
/// folder already surfaces a shared branch and/or directory on the header
/// chip. When the workspace's own summary matches, the per-row
/// branch/directory line can stand down.
struct TermLoopFolderSharedContext: Equatable {
    let sharedBranch: String?
    let sharedDirectory: String?

    var hasAny: Bool {
        (sharedBranch?.isEmpty == false) || (sharedDirectory?.isEmpty == false)
    }

    /// True when the folder's shared values fully cover what this workspace
    /// would have shown — the row can drop its branch/directory line.
    func fullyCovers(_ summary: SidebarBranchDirectorySummary) -> Bool {
        guard hasAny else { return false }
        let branchMatches: Bool = {
            guard let rowBranch = summary.branchSummary, !rowBranch.isEmpty else { return true }
            return sharedBranch == rowBranch
        }()
        let directoryMatches: Bool = {
            guard let rowDirectory = summary.directorySummary, !rowDirectory.isEmpty else { return true }
            return sharedDirectory == rowDirectory
        }()
        return branchMatches && directoryMatches
    }
}

private struct TermLoopFolderSharedContextKey: EnvironmentKey {
    static let defaultValue: TermLoopFolderSharedContext? = nil
}

extension EnvironmentValues {
    var termLoopFolderSharedContext: TermLoopFolderSharedContext? {
        get { self[TermLoopFolderSharedContextKey.self] }
        set { self[TermLoopFolderSharedContextKey.self] = newValue }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Producer-side ordering and status parsing for `GitHostPullRequestProbeItem`.
///
/// Sidebar consumers want a branch's full PR list lead-first so the focused
/// pill, CLI `pr=...`, and command-hint reconciliation pick the same "lead"
/// PR while the popover/menu still shows every entry. Two callers needed
/// the same comparator (`TabManager` for the workspace path,
/// `WorktreeBranchPullRequestStore` for the worktree-row fallback path);
/// keeping both in sync is what this file is for.
enum PullRequestOrdering {
    /// Filters invalid items (unknown status / bad URL) and sorts lead-first
    /// by status priority (open > merged > closed), then `updatedAt` desc,
    /// then PR number desc. Equal-priority entries keep their original order.
    static func sortedPullRequests(
        from pullRequests: [GitHostPullRequestProbeItem]
    ) -> [GitHostPullRequestProbeItem] {
        let valid = pullRequests.filter {
            pullRequestStatus(from: $0.state) != nil
                && URL(string: $0.url) != nil
        }
        guard valid.count > 1 else { return valid }

        return valid.enumerated().sorted { lhs, rhs in
            guard let lhsStatus = pullRequestStatus(from: lhs.element.state),
                  let rhsStatus = pullRequestStatus(from: rhs.element.state) else {
                return false
            }
            let lhsPriority = statusPriority(lhsStatus)
            let rhsPriority = statusPriority(rhsStatus)
            if lhsPriority != rhsPriority {
                return lhsPriority > rhsPriority
            }
            let lhsUpdatedAt = lhs.element.updatedAt ?? ""
            let rhsUpdatedAt = rhs.element.updatedAt ?? ""
            if lhsUpdatedAt != rhsUpdatedAt {
                return lhsUpdatedAt > rhsUpdatedAt
            }
            if lhs.element.number != rhs.element.number {
                return lhs.element.number > rhs.element.number
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }

    static func pullRequestStatus(from rawState: String) -> SidebarPullRequestStatus? {
        switch rawState.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() {
        case "OPEN", "ACTIVE", "DRAFT":
            return .open
        case "MERGED", "COMPLETED":
            return .merged
        case "CLOSED", "ABANDONED":
            return .closed
        default:
            return nil
        }
    }

    private static func statusPriority(_ status: SidebarPullRequestStatus) -> Int {
        switch status {
        case .open:   return 3
        case .merged: return 2
        case .closed: return 1
        }
    }
}

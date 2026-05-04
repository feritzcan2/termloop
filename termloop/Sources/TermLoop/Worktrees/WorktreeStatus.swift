// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Git's live view of a worktree HEAD. A worktree has one physical identity
/// (its checkout path) but its HEAD may move between branches or detach during
/// normal operations such as rebase, bisect, and conflict resolution.
enum WorktreeObservedRef: Equatable, Hashable {
    case branch(String)
    case detached(String)

    var branchName: String? {
        switch self {
        case .branch(let branch): return branch
        case .detached: return nil
        }
    }

    var displayName: String {
        switch self {
        case .branch(let branch):
            return branch
        case .detached(let head):
            guard !head.isEmpty else { return "detached" }
            return "detached@\(String(head.prefix(12)))"
        }
    }
}

/// Read-only status for a TermLoop workspace's worktree binding.
///
/// The intended model is path-first: `path` is the physical checkout identity,
/// `expectedBranch` is TermLoop's product-level expectation, and `observedRef`
/// is what Git currently reports for that checkout. A branch mismatch is drift,
/// not proof that the worktree disappeared.
struct WorktreeStatus: Equatable, Hashable {
    enum Kind: String, Equatable, Hashable {
        /// No TermLoop worktree binding exists; repo-root fallback is allowed.
        case unattached
        /// Registered Git worktree, expected branch (if any) matches observed.
        case healthy
        /// Registered Git worktree exists at the expected path, but HEAD is on
        /// a different branch or detached commit.
        case branchDrift
        /// Git reports a locked worktree. The checkout exists, but lifecycle
        /// operations such as prune/remove need separate handling.
        case locked
        /// Git still has a worktree registration that it considers prunable.
        case prunable
        /// The persisted path exists on disk but is not registered in
        /// `git worktree list --porcelain` for the project.
        case missingRegistration
        /// The persisted path is absent on disk and absent from Git's list.
        case missingPath
        /// Git listing failed or no definitive status could be computed.
        case unknown
    }

    enum PathSource: String, Equatable, Hashable {
        /// No path participates in this status.
        case none
        /// The path came from TermLoop metadata.
        case metadata
        /// Metadata had no usable path; Git supplied the registered path for
        /// the expected branch and the caller can safely backfill it later.
        case gitBranchBackfill
    }

    let kind: Kind
    let expectedBranch: String?
    let path: String?
    let pathSource: PathSource
    let observedRef: WorktreeObservedRef?
    let isMain: Bool
    let isLocked: Bool
    let isPrunable: Bool
    let message: String?

    static let unattached = WorktreeStatus(
        kind: .unattached,
        expectedBranch: nil,
        path: nil,
        pathSource: .none,
        observedRef: nil,
        isMain: false,
        isLocked: false,
        isPrunable: false,
        message: nil
    )

    var isAttached: Bool {
        expectedBranch != nil || path != nil
    }

    var needsUserAttention: Bool {
        switch kind {
        case .branchDrift, .locked, .prunable, .missingRegistration, .missingPath, .unknown:
            return true
        case .unattached, .healthy:
            return false
        }
    }

    /// Conservative gate for the later fail-closed spawn/resume phase. Locked
    /// worktrees remain launchable because `git worktree lock` prevents prune,
    /// not file edits; drift/broken states require explicit user repair.
    var permitsAgentLaunch: Bool {
        switch kind {
        case .unattached, .healthy, .locked:
            return true
        case .branchDrift, .prunable, .missingRegistration, .missingPath, .unknown:
            return false
        }
    }

    var isBackfillCandidate: Bool {
        pathSource == .gitBranchBackfill && path != nil
    }
}

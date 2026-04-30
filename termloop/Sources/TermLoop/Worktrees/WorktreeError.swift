// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum WorktreeError: Error, Equatable, LocalizedError {
    case notAGitRepo(path: String)
    case gitNotFound
    case branchLocked(branch: String, holder: String)
    case dirtyWorktree(path: String)
    case worktreeMissingOnDisk(path: String)
    case gitCommandFailed(command: String, stderr: String, exitCode: Int32)
    case invalidParams(reason: String)
    case notFound(what: String)
    case permissionDenied
    case timeout(command: String)
    case agentMidTurn(workspaceId: String, sessionId: String)
    case mainToWorktreeTransitionForbidden

    var code: String {
        switch self {
        case .notAGitRepo:           return "not_a_git_repo"
        case .gitNotFound:           return "git_not_found"
        case .branchLocked:          return "branch_locked"
        case .dirtyWorktree:         return "dirty_worktree"
        case .worktreeMissingOnDisk: return "worktree_missing_on_disk"
        case .gitCommandFailed:      return "git_command_failed"
        case .invalidParams:         return "invalid_params"
        case .notFound:              return "not_found"
        case .permissionDenied:      return "permission_denied"
        case .timeout:               return "timeout"
        case .agentMidTurn:          return "agent_mid_turn"
        case .mainToWorktreeTransitionForbidden:
            return "main_to_worktree_transition_forbidden"
        }
    }

    var errorDescription: String? {
        switch self {
        case .notAGitRepo(let path):
            return "Not a git repository: \(path)"
        case .gitNotFound:
            return "The git executable was not found on PATH"
        case .branchLocked(let branch, _):
            return "Branch \(branch) is already checked out elsewhere"
        case .dirtyWorktree(let path):
            return "Worktree has uncommitted changes: \(path)"
        case .worktreeMissingOnDisk(let path):
            return "Worktree path missing on disk: \(path)"
        case .gitCommandFailed(_, let stderr, _):
            return "git failed: \(stderr.trimmingCharacters(in: .whitespacesAndNewlines))"
        case .invalidParams(let reason):
            return reason
        case .notFound(let what):
            return "Not found: \(what)"
        case .permissionDenied:
            return "Permission denied"
        case .timeout(let cmd):
            return "git command timed out: \(cmd)"
        case .agentMidTurn:
            return "Claude is in the middle of a turn; retry later or use force=true"
        case .mainToWorktreeTransitionForbidden:
            return "Moving a workspace from the main checkout into a worktree is not allowed"
        }
    }
}

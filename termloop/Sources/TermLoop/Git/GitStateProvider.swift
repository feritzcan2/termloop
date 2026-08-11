// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Reads repository/worktree state through `GitCommandRunner`, with pure-path
/// filesystem fallbacks where a subprocess would be too expensive.
struct ProcessGitStateProvider {
    /// Upper bound for the raw `run` helper. Runner-backed calls use the
    /// per-kind defaults instead.
    var timeout: TimeInterval = 5

    func fetchAll(projectRoot: String) throws {
        _ = try GitCommandRunner.runMutation(
            ["fetch", "--prune", "--quiet", "origin"],
            in: projectRoot,
            kind: .fetch,
            caller: "ProcessGitStateProvider.fetchAll",
            invalidates: [.directory(projectRoot)]
        )
    }

    func defaultBranch(projectRoot: String) -> String? {
        if let remote = try? run(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd: projectRoot),
           let name = remote.split(separator: "/").last {
            return String(name).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // Fallback: local HEAD branch
        return try? run(["rev-parse", "--abbrev-ref", "HEAD"], cwd: projectRoot)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func hasRemoteBranch(_ name: String, directory: String) -> Bool {
        (try? run(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/\(name)"], cwd: directory)) != nil
    }

    func isAncestor(branch: String, of tracked: String, projectRoot: String) -> Bool {
        // Route through the shared `run` so we inherit its timeout watchdog.
        // `merge-base --is-ancestor` signals via exit code, not output: success
        // → ancestor, exit 1 → not, other codes → unexpected (treat as false).
        (try? run(["merge-base", "--is-ancestor", branch, tracked], cwd: projectRoot)) != nil
    }

    /// Public wrapper around the shared git runner so callers can invoke raw
    /// git subcommands without re-implementing Process/Pipe/timeout handling.
    @discardableResult
    func runRaw(_ args: [String], cwd: String) throws -> String {
        try run(args, cwd: cwd)
    }

    @discardableResult
    private func run(_ args: [String], cwd: String) throws -> String {
        let kind = GitCommandRunner.CommandKind.classify(arguments: args)
        if Self.shouldInvalidate(arguments: args, kind: kind) {
            return try GitCommandRunner.runMutation(
                args,
                in: cwd,
                kind: kind,
                caller: "ProcessGitStateProvider.runRaw",
                invalidates: [.worktree(cwd), .directory(cwd)],
                timeout: timeout
            )
        }
        return try GitCommandRunner.runThrowing(
            args,
            in: cwd,
            kind: kind,
            caller: "ProcessGitStateProvider.runRaw",
            timeout: timeout
        )
    }

    private static func shouldInvalidate(arguments: [String], kind: GitCommandRunner.CommandKind) -> Bool {
        switch kind {
        case .mutation, .fetch, .worktree:
            return true
        case .revParse, .branch, .status, .remote, .diff, .history, .submodule, .genericRead:
            return false
        }
    }
}

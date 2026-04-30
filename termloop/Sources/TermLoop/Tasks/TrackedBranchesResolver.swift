// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Resolves the set of branches the Tasks tab tracks for a project.
///
/// If an explicit list is provided (e.g. stored on `Project.trackedBranches`),
/// it is returned as-is. Otherwise, the resolver auto-detects by asking the
/// injected `GitRunner` for the project's default branch and checking whether
/// a remote `dev` branch exists.
///
/// Production wiring uses `ProcessGitStateProvider`, which delegates process
/// execution to the shared `GitCommandRunner`.
struct TrackedBranchesResolver {
    protocol GitRunner {
        func defaultBranch(projectRoot: String) -> String?
        func hasRemoteBranch(_ name: String, directory: String) -> Bool
    }

    let gitRunner: GitRunner

    func resolve(explicit: [String]?, projectRoot: String) -> [String] {
        if let explicit { return explicit }
        var result: [String] = []
        if let def = gitRunner.defaultBranch(projectRoot: projectRoot) {
            result.append(def)
        }
        if gitRunner.hasRemoteBranch("dev", directory: projectRoot),
           !result.contains("dev") {
            result.append("dev")
        }
        return result
    }
}

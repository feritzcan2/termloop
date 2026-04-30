// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Builds the `claude [--resume <id>] [--append-system-prompt <block>]`
/// shell command used by restore / worktree-relaunch / socket-handoff
/// paths. Single seam so the ability-block injection stays consistent
/// across the four legacy call-sites that previously inlined their
/// own resume-command plumbing.
///
/// The ability block comes from `ProjectInstructionStore.snapshot(...)`
/// — the one disk-read entry for abilities.
@MainActor
enum ClaudeResumeCommandBuilder {
    /// Default executable is `claude`. `ClaudeRestoreCoordinator` uses
    /// `c` instead so the user's shell alias (e.g. a
    /// `--dangerously-skip-permissions` wrapper) resolves.
    static func buildCommand(
        executable: String = "claude",
        sessionId: String?,
        extraArgs: [String] = [],
        additionalSystemPrompt: String? = nil,
        env: [String: String],
        projectFolderPath: String?,
        runCwd: String?,
        cdIntoRunCwd: Bool
    ) -> String {
        var args: [String] = extraArgs
        if let sessionId, !sessionId.isEmpty {
            args.insert(contentsOf: ["--resume", sessionId], at: 0)
        }
        let snapshot = ProjectInstructionStore.snapshot(
            projectFolderPath: projectFolderPath,
            runCwd: runCwd
        )
        ProjectSkillMaterializer.materialize(
            projectFolderPath: projectFolderPath,
            agentCwdPath: runCwd,
            abilities: snapshot.activeAbilities + snapshot.listedAbilities
        )
        if let block = snapshot.composedAppendSystemPrompt {
            args += ["--append-system-prompt", block]
        }
        // additionalSystemPrompt comes AFTER the project ability block so
        // call-site context (e.g. "this session was just migrated into a
        // worktree") is the last thing the resumed agent reads. Emitted
        // as its own --append-system-prompt; claude concatenates multiple
        // flags into the appended block.
        if let extra = additionalSystemPrompt,
           !extra.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args += ["--append-system-prompt", extra]
        }
        return TermLoopShell.composeCommand(
            executable: executable,
            args: args,
            env: env,
            cwd: (cdIntoRunCwd ? runCwd : nil)
        )
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Bonsplit
import Foundation
import SwiftUI
import os

@MainActor
final class WorktreeCoordinator: ObservableObject {
    static let shared = WorktreeCoordinator()
    private static let logger = Logger(subsystem: "com.termloop.fork", category: "worktree")

    struct AttachResult: Equatable {
        let workspaceId: UUID
        let branch: String
        let path: String
        let createdBranch: Bool
        let createdWorktree: Bool
        let resolvesToMain: Bool
        let migratedAgent: Bool
        let cdIdleShells: Int
    }

    struct DetachResult: Equatable {
        let workspaceId: UUID
        let previousBranch: String?
        let worktreePruned: Bool
    }

    struct DetachToCurrentLocalBranchInspection: Equatable {
        let projectFolder: String
        let currentLocalBranch: String
        let worktreeBranch: String
        let worktreePath: String
        let hasUnmergedCommits: Bool
        let hasLocalChanges: Bool
        let rootHasLocalChanges: Bool
        let runningWorkspaceIds: [UUID]
    }

    struct DetachToCurrentLocalBranchResult: Equatable {
        let currentLocalBranch: String
        let worktreePath: String
        let workspaceCount: Int
        let worktreeRemoved: Bool
        let carriedLocalChanges: Bool
    }

    enum PrunePolicy: String { case auto, keep, force }
    enum LocalChangesPolicy: String { case moveToCurrentBranch, discardAll, leaveInWorktree }

    private let service: GitWorktreeService
    private let metadata: WorkspaceMetadataStore

    init(
        service: GitWorktreeService = GitWorktreeService(),
        metadata: WorkspaceMetadataStore? = nil
    ) {
        self.service = service
        self.metadata = metadata ?? .shared
    }

    #if DEBUG
    private static func debugLog(_ message: @autoclosure () -> String) {
        dlog("worktree.coord \(message())")
    }
    #endif

    /// One-shot system-prompt fragment given to the resumed agent on a
    /// worktree migration. Kept purely declarative on purpose: any
    /// wording about future tool calls or contrast with the source cwd
    /// nudges Claude toward running `pwd` / `git status` to verify the
    /// move it wasn't asked to verify.
    fileprivate static func worktreeMigrationSystemPrompt(toPath: String) -> String {
        "Context: this session is now running in \(toPath). " +
        "Earlier file paths in this transcript were rewritten to point inside that directory."
    }

    // MARK: - Attach

    func attach(
        workspace: Workspace,
        branch: String,
        baseRef: String? = nil,
        createIfMissing: Bool? = nil,
        force: Bool = false
    ) throws -> AttachResult {
        let project = try resolveProject(for: workspace)
        let trimmed = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        let previousBranch = metadata.branch(for: workspace)
        let preservedBaselineHead = previousBranch == trimmed
            ? metadata.worktreeBaselineHead(for: workspace)
            : nil
        #if DEBUG
        Self.debugLog(
            "attach.begin ws=\(workspace.id.uuidString.prefix(8)) project=\(project.name)[\(project.id.uuidString.prefix(8))] " +
            "branch=\(trimmed) baseRef=\(baseRef ?? "nil") createIfMissing=\(createIfMissing.map(String.init(describing:)) ?? "nil") force=\(force) " +
            "previousBranch=\(previousBranch ?? "nil")"
        )
        #endif
        guard !trimmed.isEmpty else {
            throw WorktreeError.invalidParams(reason: "branch is empty")
        }
        guard let resolvedPath = WorktreeResolver.path(
            projectFolder: project.folderPath, branch: trimmed
        ) else {
            throw WorktreeError.invalidParams(reason: "could not resolve path")
        }
        try ensureGitIgnore(in: project.folderPath)

        let worktrees = try service.list(in: project.folderPath)
        let currentPath = resolvedWorkspacePath(
            workspace: workspace,
            projectFolder: project.folderPath,
            worktrees: worktrees
        )
        #if DEBUG
        Self.debugLog(
            "attach.resolved ws=\(workspace.id.uuidString.prefix(8)) projectFolder=\(project.folderPath) " +
            "currentPath=\(currentPath) resolvedPath=\(resolvedPath) worktrees=\(worktrees.count)"
        )
        #endif

        let effectivePath: String
        let createdWorktree: Bool
        let createdBranch: Bool
        let resolvesToMain: Bool

        if let main = worktrees.first(where: { $0.isMain }),
           main.branch == trimmed {
            effectivePath = main.path
            createdWorktree = false
            createdBranch = false
            resolvesToMain = true
        } else if let existing = worktrees.first(where: { $0.branch == trimmed }) {
            effectivePath = existing.path
            createdWorktree = false
            createdBranch = false
            resolvesToMain = false
        } else {
            let branchExists = try service.branches(in: project.folderPath)
                .contains(where: { $0.name == trimmed })
            let shouldCreate = createIfMissing ?? !branchExists
            if branchExists {
                try ensureCleanSourceCheckout(projectFolder: project.folderPath)
                try service.add(
                    folder: project.folderPath, path: resolvedPath, branch: trimmed
                )
                effectivePath = resolvedPath
                createdWorktree = true
                createdBranch = false
                resolvesToMain = false
            } else {
                guard shouldCreate else {
                    throw WorktreeError.notFound(what: "branch \(trimmed)")
                }
                try ensureCleanSourceCheckout(projectFolder: project.folderPath)
                try service.addCreatingBranch(
                    folder: project.folderPath, path: resolvedPath,
                    branch: trimmed, baseRef: baseRef ?? "HEAD"
                )
                effectivePath = resolvedPath
                createdWorktree = true
                createdBranch = true
                resolvesToMain = false
            }
        }

        let normalizedProjectPath = URL(fileURLWithPath: project.folderPath).standardizedFileURL.path
        let normalizedCurrentPath = URL(fileURLWithPath: currentPath).standardizedFileURL.path
        let normalizedEffectivePath = URL(fileURLWithPath: effectivePath).standardizedFileURL.path
        if normalizedCurrentPath == normalizedProjectPath,
           normalizedEffectivePath != normalizedProjectPath {
            throw WorktreeError.mainToWorktreeTransitionForbidden
        }

        // Probe agent state BEFORE flipping metadata so we can refuse cleanly
        // when mid-turn and force=false. Throws .agentMidTurn without leaving
        // the workspace in a half-attached state.
        let migrated = try migrateRunningAgent(
            workspace: workspace,
            project: project,
            toPath: effectivePath,
            force: force
        )
        migratePersistedAgentSession(
            workspace: workspace,
            project: project,
            toPath: effectivePath
        )
        if normalizedEffectivePath != normalizedProjectPath {
            let outcome = ClaudeProjectFiles.seedAllSessions(
                fromCwd: project.folderPath,
                toCwd: effectivePath
            )
            // Seed is best-effort historical-session symlinking; the active
            // resume session is guarded separately by ensureSessionAvailable.
            // Surface failures at the caller's logger context so they are
            // attributable to the attach path and not buried in claude-files.
            if case .failed(let reason) = outcome {
                Self.logger.warning(
                    "worktree.attach: history seed failed ws=\(workspace.id.uuidString, privacy: .public) path=\(effectivePath, privacy: .public) reason=\(reason, privacy: .public)"
                )
            }
        }

        let respawnCount = respawnWorktreePanels(
            workspace: workspace,
            toPath: effectivePath,
            projectFolder: project.folderPath,
            skipPanelId: migrated ? workspace.focusedPanelId : nil
        )

        metadata.setBranch(trimmed, worktreePath: effectivePath, for: workspace)
        metadata.setWorktreeBaselineHead(
            preservedBaselineHead ?? (try? service.headRevision(worktreePath: effectivePath)),
            forWorkspaceId: workspace.id
        )
        #if DEBUG
        Self.debugLog(
            "attach.metadata ws=\(workspace.id.uuidString.prefix(8)) branch=\(trimmed) path=\(effectivePath) " +
            "createdWorktree=\(createdWorktree) createdBranch=\(createdBranch) resolvesToMain=\(resolvesToMain) " +
            "migratedAgent=\(migrated) respawned=\(respawnCount)"
        )
        #endif

        Self.logger.info(
            "worktree attach: ws=\(workspace.id.uuidString, privacy: .public) branch=\(trimmed, privacy: .public) path=\(effectivePath, privacy: .public) respawn=\(respawnCount, privacy: .public) migrated=\(migrated, privacy: .public)"
        )

        // Git worktrees ship with empty submodule directories — their
        // pointers are copied but the files aren't checked out. Agents
        // that run inside this worktree will see empty `termloop/`,
        // `ghostty/`, etc. Kick off `git submodule update --init
        // --recursive` in the background so the user's attach returns
        // immediately while the UI shows progress. No-op when the
        // repo has no `.gitmodules` or the user disabled the setting.
        //
        #if DEBUG
        dlog("worktree.attach createdWorktree=\(createdWorktree) path=\(effectivePath) branch=\(trimmed) wsId=\(workspace.id.uuidString.prefix(5))")
        #endif
        startSubmoduleInitializationIfNeeded(
            createdWorktree: createdWorktree,
            path: effectivePath,
            branch: trimmed,
            workspaceId: workspace.id
        )

        return AttachResult(
            workspaceId: workspace.id, branch: trimmed,
            path: effectivePath, createdBranch: createdBranch,
            createdWorktree: createdWorktree, resolvesToMain: resolvesToMain,
            migratedAgent: migrated,
            cdIdleShells: respawnCount
        )
    }

    /// Explicit conversation-to-worktree move used by the worktree creation
    /// sheet. Unlike generic `attach`, this path allows a root-checkout
    /// workspace to move into a worktree, but only after resume preflight
    /// succeeds for the tracked conversation.
    func migrateWorkspaceToPreparedWorktree(
        workspace: Workspace,
        branch: String,
        path: String,
        baselineHead: String?,
        sessionReference: WorkspaceSessionReference? = nil
    ) throws -> AttachResult {
        let project = try resolveProject(for: workspace)
        let trimmed = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        #if DEBUG
        Self.debugLog(
            "migratePrepared.begin ws=\(workspace.id.uuidString.prefix(8)) project=\(project.name)[\(project.id.uuidString.prefix(8))] " +
            "branch=\(trimmed) path=\(path) baselineHead=\(baselineHead ?? "nil") sessionRef=\(sessionReference?.sessionId ?? "nil")"
        )
        #endif
        guard !trimmed.isEmpty else {
            throw WorktreeError.invalidParams(reason: "branch is empty")
        }

        let effectivePath = URL(fileURLWithPath: path).standardizedFileURL.path
        let normalizedProjectPath = URL(fileURLWithPath: project.folderPath).standardizedFileURL.path
        let migrated = try migrateTrackedConversationAgent(
            workspace: workspace,
            project: project,
            toPath: effectivePath,
            sessionReference: sessionReference
        )
        migratePersistedAgentSession(
            workspace: workspace,
            project: project,
            toPath: effectivePath
        )
        if effectivePath != normalizedProjectPath {
            let outcome = ClaudeProjectFiles.seedAllSessions(
                fromCwd: project.folderPath,
                toCwd: effectivePath
            )
            if case .failed(let reason) = outcome {
                Self.logger.warning(
                    "migrateWorkspaceToPreparedWorktree: history seed failed ws=\(workspace.id.uuidString, privacy: .public) path=\(effectivePath, privacy: .public) reason=\(reason, privacy: .public)"
                )
            }
        }

        let respawnCount = respawnWorktreePanels(
            workspace: workspace,
            toPath: effectivePath,
            projectFolder: project.folderPath,
            skipPanelId: migrated ? workspace.focusedPanelId : nil
        )

        metadata.setBranch(trimmed, worktreePath: effectivePath, for: workspace)
        metadata.setWorktreeBaselineHead(
            baselineHead ?? (try? service.headRevision(worktreePath: effectivePath)),
            forWorkspaceId: workspace.id
        )
        WorktreeAgentsPanelState.reveal(branch: trimmed)
        #if DEBUG
        Self.debugLog(
            "migratePrepared.metadata ws=\(workspace.id.uuidString.prefix(8)) branch=\(trimmed) path=\(effectivePath) " +
            "migratedAgent=\(migrated) respawned=\(respawnCount)"
        )
        #endif
        AppDelegate.shared?.saveSessionSnapshot(
            includeScrollback: false,
            forceSync: true
        )
        startSubmoduleInitializationIfNeeded(
            createdWorktree: false,
            path: effectivePath,
            branch: trimmed,
            workspaceId: workspace.id
        )

        return AttachResult(
            workspaceId: workspace.id,
            branch: trimmed,
            path: effectivePath,
            createdBranch: false,
            createdWorktree: false,
            resolvesToMain: false,
            migratedAgent: migrated,
            cdIdleShells: respawnCount
        )
    }

    // MARK: - Root detach preflight

    func inspectDetachToCurrentLocalBranch(
        workspaces: [Workspace],
        worktreePath explicitWorktreePath: String? = nil
    ) throws -> DetachToCurrentLocalBranchInspection {
        guard let first = workspaces.first else {
            throw WorktreeError.invalidParams(reason: "No workspaces selected.")
        }
        let project = try resolveProject(for: first)
        let expectedBranch = metadata.branch(for: first)
        func boundPath(for workspace: Workspace) -> String? {
            WorktreeResolver.normalizePath(metadata.worktreePath(for: workspace))
                ?? WorktreeResolver.normalizePath(workspace.termLoopCachedWorktreeStatus(maximumAge: 60)?.path)
                ?? WorktreeResolver.normalizePath(workspace.termLoopPresentationCwd())
        }
        let normalizedExplicitPath = WorktreeResolver.normalizePath(explicitWorktreePath)
        let normalizedFirstPath = normalizedExplicitPath ?? boundPath(for: first)
        guard expectedBranch != nil || normalizedFirstPath != nil else {
            throw WorktreeError.invalidParams(reason: "This workspace is not attached to a worktree.")
        }
        #if DEBUG
        Self.debugLog(
            "inspectDetach.begin project=\(project.name)[\(project.id.uuidString.prefix(8))] expectedBranch=\(expectedBranch ?? "nil") worktreePath=\(normalizedFirstPath ?? "nil") workspaces=\(workspaces.map { $0.id.uuidString.prefix(8) }.joined(separator: ","))"
        )
        #endif

        for workspace in workspaces {
            guard workspace.projectId == project.id else {
                throw WorktreeError.invalidParams(
                    reason: "Selected workspaces must belong to the same project."
                )
            }
            if let normalizedFirstPath {
                guard boundPath(for: workspace) == normalizedFirstPath else {
                    throw WorktreeError.invalidParams(
                        reason: "Selected workspaces must point at the same physical worktree path."
                    )
                }
            } else {
                guard metadata.branch(for: workspace) == expectedBranch else {
                    throw WorktreeError.invalidParams(
                        reason: "Selected workspaces must point at the same worktree branch."
                    )
                }
            }
        }

        let worktrees = try service.list(in: project.folderPath)
        let entry: GitWorktreeService.ListEntry?
        if let normalizedFirstPath {
            entry = worktrees.first(where: {
                WorktreeResolver.normalizePath($0.path) == normalizedFirstPath && !$0.isMain
            })
        } else if let expectedBranch {
            entry = worktrees.first(where: { $0.branch == expectedBranch && !$0.isMain })
        } else {
            entry = nil
        }

        guard let entry else {
            let missingPath = normalizedFirstPath
                ?? expectedBranch.flatMap {
                    WorktreeResolver.path(projectFolder: project.folderPath, branch: $0)
                }
                ?? "worktree"
            throw WorktreeError.worktreeMissingOnDisk(path: missingPath)
        }

        let worktreeBranch = entry.branch
            ?? expectedBranch
            ?? "detached@\(String(entry.head.prefix(12)))"
        if let expectedBranch, entry.branch != nil, entry.branch != expectedBranch {
            #if DEBUG
            Self.debugLog(
                "inspectDetach.drift project=\(project.name)[\(project.id.uuidString.prefix(8))] expected=\(expectedBranch) observed=\(entry.branch ?? "nil") path=\(entry.path)"
            )
            #endif
        }

        for workspace in workspaces where normalizedFirstPath == nil {
            guard metadata.branch(for: workspace) == expectedBranch else {
                throw WorktreeError.invalidParams(
                    reason: "Selected workspaces must point at the same worktree branch."
                )
            }
        }

        let currentLocalBranch = try service.currentBranch(in: project.folderPath)
        let worktreeHead = try service.headRevision(worktreePath: entry.path)
        let rootHead = try service.headRevision(worktreePath: project.folderPath)
        let hasUnmergedCommits = try !service.isAncestor(
            revision: worktreeHead,
            of: rootHead,
            in: project.folderPath
        )
        let hasLocalChanges = try !service.isClean(worktreePath: entry.path)
        let rootHasLocalChanges = try !service.isClean(worktreePath: project.folderPath)
        let runningWorkspaceIds = workspaces.compactMap { workspace in
            TerminalAgentActivityStore.shared.isRunning(forWorkspace: workspace) ? workspace.id : nil
        }
        #if DEBUG
        Self.debugLog(
            "inspectDetach.result project=\(project.name)[\(project.id.uuidString.prefix(8))] branch=\(worktreeBranch) " +
            "worktreePath=\(entry.path) currentLocalBranch=\(currentLocalBranch) hasUnmerged=\(hasUnmergedCommits) " +
            "hasLocalChanges=\(hasLocalChanges) rootHasLocalChanges=\(rootHasLocalChanges) running=\(runningWorkspaceIds.map { $0.uuidString.prefix(8) }.joined(separator: ","))"
        )
        #endif

        return DetachToCurrentLocalBranchInspection(
            projectFolder: project.folderPath,
            currentLocalBranch: currentLocalBranch,
            worktreeBranch: worktreeBranch,
            worktreePath: entry.path,
            hasUnmergedCommits: hasUnmergedCommits,
            hasLocalChanges: hasLocalChanges,
            rootHasLocalChanges: rootHasLocalChanges,
            runningWorkspaceIds: runningWorkspaceIds
        )
    }

    func detachToCurrentLocalBranch(
        workspaces: [Workspace],
        worktreePath: String? = nil,
        localChangesPolicy: LocalChangesPolicy
    ) throws -> DetachToCurrentLocalBranchResult {
        let inspection = try inspectDetachToCurrentLocalBranch(
            workspaces: workspaces,
            worktreePath: worktreePath
        )
        #if DEBUG
        Self.debugLog(
            "detachToLocal.begin branch=\(inspection.worktreeBranch) worktreePath=\(inspection.worktreePath) " +
            "policy=\(localChangesPolicy.rawValue) workspaces=\(workspaces.map { $0.id.uuidString.prefix(8) }.joined(separator: ","))"
        )
        #endif

        guard inspection.runningWorkspaceIds.isEmpty else {
            throw WorktreeError.invalidParams(
                reason: "Stop running agents in this worktree before moving it back to \(inspection.currentLocalBranch)."
            )
        }
        guard !inspection.hasUnmergedCommits else {
            throw WorktreeError.invalidParams(
                reason: "Branch \(inspection.worktreeBranch) has commits that are not merged into \(inspection.currentLocalBranch)."
            )
        }

        var patchToCarry = ""
        var untrackedPaths: [String] = []
        if inspection.hasLocalChanges {
            switch localChangesPolicy {
            case .moveToCurrentBranch:
                guard !inspection.rootHasLocalChanges else {
                    throw WorktreeError.invalidParams(
                        reason: "The current local branch checkout has local changes. Clean it before bringing worktree changes over."
                    )
                }
                patchToCarry = try service.diffAgainstHead(worktreePath: inspection.worktreePath)
                untrackedPaths = try service.untrackedPaths(worktreePath: inspection.worktreePath)
                try preflightUntrackedCopies(
                    relativePaths: untrackedPaths,
                    from: inspection.worktreePath,
                    to: inspection.projectFolder
                )
                if !patchToCarry.isEmpty,
                   try !service.canApplyPatch(patchToCarry, in: inspection.projectFolder) {
                    throw WorktreeError.invalidParams(
                        reason: "The worktree's local changes do not apply cleanly to \(inspection.currentLocalBranch)."
                    )
                }
            case .discardAll, .leaveInWorktree:
                break
            }
        }

        for workspace in workspaces {
            _ = try detach(workspace: workspace, prune: .keep)
        }
        #if DEBUG
        Self.debugLog(
            "detachToLocal.detached branch=\(inspection.worktreeBranch) workspaces=\(workspaces.count) policy=\(localChangesPolicy.rawValue)"
        )
        #endif

        var carriedLocalChanges = false
        if inspection.hasLocalChanges, localChangesPolicy == .moveToCurrentBranch {
            if !patchToCarry.isEmpty {
                try service.applyPatch(patchToCarry, in: inspection.projectFolder)
            }
            try copyUntrackedPaths(
                relativePaths: untrackedPaths,
                from: inspection.worktreePath,
                to: inspection.projectFolder
            )
            carriedLocalChanges = !patchToCarry.isEmpty || !untrackedPaths.isEmpty
        }

        let shouldRemoveWorktree = !inspection.hasLocalChanges || localChangesPolicy != .leaveInWorktree
        if shouldRemoveWorktree {
            try service.remove(
                folder: inspection.projectFolder,
                path: inspection.worktreePath,
                force: inspection.hasLocalChanges
            )
        }

        AppDelegate.shared?.saveSessionSnapshot(includeScrollback: false, forceSync: true)
        #if DEBUG
        Self.debugLog(
            "detachToLocal.result branch=\(inspection.worktreeBranch) worktreeRemoved=\(shouldRemoveWorktree) carriedLocalChanges=\(carriedLocalChanges) " +
            "workspaceCount=\(workspaces.count)"
        )
        #endif
        return DetachToCurrentLocalBranchResult(
            currentLocalBranch: inspection.currentLocalBranch,
            worktreePath: inspection.worktreePath,
            workspaceCount: workspaces.count,
            worktreeRemoved: shouldRemoveWorktree,
            carriedLocalChanges: carriedLocalChanges
        )
    }

    // MARK: - Agent migration

    /// Replaces the focused terminal panel with a brand-new surface rooted
    /// at `toPath` and starts `claude` there (with `--resume` when we can
    /// copy the session history file into the new cwd's Claude project dir).
    /// Closing the old panel SIGHUPs whatever process was running inside —
    /// no pid tracking, no race with a reborn Claude, no sendText going
    /// into a still-running TUI. The user's old shell scrollback is lost.
    private func migrateRunningAgent(
        workspace: Workspace,
        project: Project,
        toPath: String,
        force: Bool
    ) throws -> Bool {
        #if DEBUG
        Self.debugLog(
            "migrateRunning.begin ws=\(workspace.id.uuidString.prefix(8)) project=\(project.name)[\(project.id.uuidString.prefix(8))] toPath=\(toPath) force=\(force)"
        )
        #endif
        guard let session = metadata.claudeSession(workspaceId: workspace.id.uuidString) else {
            #if DEBUG
            Self.debugLog("migrateRunning.skip ws=\(workspace.id.uuidString.prefix(8)) reason=noClaudeSession")
            #endif
            return false
        }
        // Defense in depth: session.sessionId is spliced UNQUOTED into the
        // resume command below. The report_claude_session entry point
        // already rejects unsafe ids, but an older build or a tampered
        // sidecar could still deliver one. Refuse to build the command.
        guard TermLoopShell.isSafeUnquotedIdentifier(session.sessionId) else {
            Self.logger.error(
                "worktree migrate: refusing to resume — unsafe session id \(session.sessionId, privacy: .public)"
            )
            #if DEBUG
            Self.debugLog("migrateRunning.skip ws=\(workspace.id.uuidString.prefix(8)) reason=unsafeSessionId sid=\(session.sessionId)")
            #endif
            return false
        }
        let isRunning = {
            TerminalAgentActivityStore.shared.isAgentRunning(forWorkspace: workspace, agentId: "claude")
        }()
        if isRunning && !force {
            #if DEBUG
            Self.debugLog("migrateRunning.blocked ws=\(workspace.id.uuidString.prefix(8)) reason=midTurn sid=\(session.sessionId)")
            #endif
            throw WorktreeError.agentMidTurn(
                workspaceId: workspace.id.uuidString,
                sessionId: session.sessionId
            )
        }

        guard let oldPanelId = workspace.focusedPanelId,
              let paneId = workspace.paneId(forPanelId: oldPanelId) else {
            #if DEBUG
            Self.debugLog("migrateRunning.skip ws=\(workspace.id.uuidString.prefix(8)) reason=noFocusedPanel sid=\(session.sessionId)")
            #endif
            return false
        }

        // Claude's on-disk layout is `~/.claude/projects/<encode(cwd)>/<sid>.jsonl`
        // where cwd is whatever the process saw at spawn. We don't always
        // know that cwd exactly (the hook may not report it, shell
        // integration may lag), so we try every plausible source in order
        // and stop at the first success. Cross-project candidates are
        // filtered out so we never splice an unrelated conversation into
        // this worktree.
        let candidateSources = claudeSessionCandidateSources(
            workspace: workspace,
            project: project,
            reportedCwd: session.cwd
        )
        let canResume = ClaudeProjectFiles.migrateSession(
            sessionId: session.sessionId,
            targetCwd: toPath,
            sourceCwds: candidateSources
        )
        if !canResume {
            Self.logger.info(
                "worktree migrate: no candidate source had session sid=\(session.sessionId, privacy: .public) — falling back to fresh claude"
            )
        }

        // Order: create new surface first, then close old. If we close
        // first and it was the last tab in the pane, the pane can collapse.
        guard let newPanel = workspace.newTerminalSurface(
            inPane: paneId, focus: true, workingDirectory: toPath
        ) else {
            return false
        }
        _ = workspace.closePanel(oldPanelId, force: true)

        // cdIntoRunCwd: defense in depth. The new surface is created with
        // workingDirectory: toPath, but if the spawned shell drops into a
        // login shell that resets to $HOME (or PWD lags), the resumed
        // claude would inherit a stale cwd and any history paths that
        // migrateSession failed to rewrite would silently target the old
        // branch. Forcing `cd` here guarantees the resume runs at toPath.
        //
        // additionalSystemPrompt: one-shot worktree-migration context for
        // the resumed agent. Delivered via the resume command (not as a
        // synthetic JSONL turn) so the reminder is ephemeral, scoped to
        // this one launch, and doesn't pollute ClaudeSessionScanner's
        // title / lastUserSnippet. Wording stays purely declarative
        // (no "tool calls", no contrast with "source cwd") to avoid
        // nudging Claude into a pwd/git-status verification habit.
        let tail = ClaudeResumeCommandBuilder.buildCommand(
            sessionId: canResume ? session.sessionId : nil,
            additionalSystemPrompt: canResume ? Self.worktreeMigrationSystemPrompt(toPath: toPath) : nil,
            env: ["TERMLOOP_WORKSPACE_ID": workspace.id.uuidString],
            projectFolderPath: project.folderPath,
            runCwd: toPath,
            cdIntoRunCwd: true
        ) + "\r"
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            newPanel.sendText(tail)
        }
        if canResume {
            metadata.moveClaudeSession(
                workspaceId: workspace.id.uuidString,
                toCwd: toPath
            )
        } else {
            // Fresh-claude fallback gets a brand-new session id/pid via the
            // next session-start hook. Until that hook lands, don't advertise
            // the stale pre-attach session as resumable on mobile.
            metadata.clearClaudeSession(workspaceId: workspace.id.uuidString)
        }
        #if DEBUG
        Self.debugLog(
            "migrateRunning.result ws=\(workspace.id.uuidString.prefix(8)) sid=\(session.sessionId) canResume=\(canResume) toPath=\(toPath)"
        )
        #endif
        return true
    }

    /// Strict migration path for the explicit "move conversation to
    /// worktree" action. Only resumable agents are allowed and we refuse to
    /// silently start a fresh session when resume prerequisites are missing.
    private func migrateTrackedConversationAgent(
        workspace: Workspace,
        project: Project,
        toPath: String,
        sessionReference: WorkspaceSessionReference?
    ) throws -> Bool {
        #if DEBUG
        Self.debugLog(
            "migrateTracked.begin ws=\(workspace.id.uuidString.prefix(8)) project=\(project.name)[\(project.id.uuidString.prefix(8))] toPath=\(toPath) sessionRef=\(sessionReference?.sessionId ?? "nil")"
        )
        #endif
        let resolvedReference = sessionReference
            ?? WorkspaceSessionReferenceResolver.resolve(for: workspace)
        guard let reference = resolvedReference else {
            #if DEBUG
            Self.debugLog("migrateTracked.skip ws=\(workspace.id.uuidString.prefix(8)) reason=noSessionReference")
            #endif
            return false
        }
        guard let agent = TerminalAgentRegistry.shared.agent(id: reference.agentId),
              TerminalAgentRunner.supportsResume(agentId: agent.id) else {
            #if DEBUG
            Self.debugLog("migrateTracked.blocked ws=\(workspace.id.uuidString.prefix(8)) reason=unsupportedAgent agent=\(reference.agentId)")
            #endif
            throw WorktreeError.invalidParams(
                reason: "This conversation cannot be safely resumed in a worktree."
            )
        }
        guard !TerminalAgentActivityStore.shared.isAgentRunning(
            forWorkspace: workspace,
            agentId: agent.id
        ) else {
            #if DEBUG
            Self.debugLog("migrateTracked.blocked ws=\(workspace.id.uuidString.prefix(8)) reason=midTurn agent=\(agent.id) sid=\(reference.sessionId)")
            #endif
            throw WorktreeError.agentMidTurn(
                workspaceId: workspace.id.uuidString,
                sessionId: reference.sessionId
            )
        }
        guard let oldPanelId = workspace.focusedPanelId,
              let paneId = workspace.paneId(forPanelId: oldPanelId) else {
            #if DEBUG
            Self.debugLog("migrateTracked.skip ws=\(workspace.id.uuidString.prefix(8)) reason=noFocusedPanel agent=\(agent.id)")
            #endif
            return false
        }

        if agent.id == TerminalAgent.claudeId {
            let candidateSources = claudeSessionCandidateSources(
                workspace: workspace,
                project: project,
                reportedCwd: reference.cwd
            )
            guard ClaudeProjectFiles.migrateSession(
                sessionId: reference.sessionId,
                targetCwd: toPath,
                sourceCwds: candidateSources
            ) else {
                throw WorktreeError.invalidParams(
                    reason: "Claude session files could not be copied into the target worktree."
                )
            }
        }

        let persistedSession = PersistedAgentSession(
            agentId: agent.id,
            sessionId: reference.sessionId,
            cwd: toPath,
            updatedAt: Date()
        )
        guard let newPanel = workspace.newTerminalSurface(
            inPane: paneId,
            focus: true,
            workingDirectory: toPath
        ) else {
            return false
        }

        _ = workspace.closePanel(oldPanelId, force: true)
        TerminalAgentLifecycle.relaunchAfterWorktreeMigration(
            workspace: workspace,
            agent: agent,
            project: project,
            persistedSession: persistedSession,
            newPanel: newPanel,
            toPath: toPath,
            additionalSystemPrompt: agent.id == TerminalAgent.claudeId
                ? Self.worktreeMigrationSystemPrompt(toPath: toPath)
                : nil
        )
        #if DEBUG
        Self.debugLog(
            "migrateTracked.result ws=\(workspace.id.uuidString.prefix(8)) agent=\(agent.id) sid=\(reference.sessionId) toPath=\(toPath)"
        )
        #endif
        return true
    }

    private func migratePersistedAgentSession(
        workspace: Workspace,
        project: Project,
        toPath: String
    ) {
        #if DEBUG
        Self.debugLog(
            "migratePersisted.begin ws=\(workspace.id.uuidString.prefix(8)) project=\(project.name)[\(project.id.uuidString.prefix(8))] toPath=\(toPath)"
        )
        #endif
        guard let session = metadata.persistedAgentSession(for: workspace.id) else {
            #if DEBUG
            Self.debugLog("migratePersisted.skip ws=\(workspace.id.uuidString.prefix(8)) reason=noPersistedSession")
            #endif
            return
        }
        if session.agentId != TerminalAgent.claudeId {
            TerminalAgentLifecycle.persistMovedAgentSession(workspaceId: workspace.id, toCwd: toPath)
            #if DEBUG
            Self.debugLog(
                "migratePersisted.result ws=\(workspace.id.uuidString.prefix(8)) agent=\(session.agentId) sid=\(session.sessionId) toPath=\(toPath) resume=unneeded"
            )
            #endif
            return
        }
        let candidateSources = claudeSessionCandidateSources(
            workspace: workspace,
            project: project,
            reportedCwd: session.cwd
        )
        guard ClaudeProjectFiles.migrateSession(
            sessionId: session.sessionId,
            targetCwd: toPath,
            sourceCwds: candidateSources
        ) else {
            #if DEBUG
            Self.debugLog(
                "migratePersisted.skip ws=\(workspace.id.uuidString.prefix(8)) sid=\(session.sessionId) reason=sessionUnavailable"
            )
            #endif
            return
        }
        TerminalAgentLifecycle.persistMovedAgentSession(workspaceId: workspace.id, toCwd: toPath)
        #if DEBUG
        Self.debugLog(
            "migratePersisted.result ws=\(workspace.id.uuidString.prefix(8)) sid=\(session.sessionId) toPath=\(toPath)"
        )
        #endif
    }

    private func claudeSessionCandidateSources(
        workspace: Workspace,
        project: Project,
        reportedCwd: String?
    ) -> [String] {
        let normalizedProject = URL(fileURLWithPath: project.folderPath).standardizedFileURL.path
        var seen = Set<String>()
        var out: [String] = []
        let rawCandidates =
            [reportedCwd] + workspace.panelDirectories.values.map(Optional.some) + [project.folderPath]
        for raw in rawCandidates {
            guard let raw,
                  case let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines),
                  !trimmed.isEmpty else { continue }
            let normalized = URL(fileURLWithPath: trimmed).standardizedFileURL.path
            guard seen.insert(normalized).inserted else { continue }
            if normalized == normalizedProject || normalized.hasPrefix(normalizedProject + "/") {
                out.append(normalized)
            }
        }
        return out
    }

    /// Worktree switch: closes all project-scoped panes and respawns them
    /// at the new worktree path. The migrated agent pane is excluded
    /// (handled separately by `migrateRunningAgent`).
    private func respawnWorktreePanels(
        workspace: Workspace,
        toPath: String,
        projectFolder: String,
        skipPanelId: UUID?
    ) -> Int {
        let targetNormalized = URL(fileURLWithPath: toPath).standardizedFileURL.path
        let projectNormalized = URL(fileURLWithPath: projectFolder).standardizedFileURL.path
        #if DEBUG
        Self.debugLog(
            "respawn.begin ws=\(workspace.id.uuidString.prefix(8)) toPath=\(toPath) projectFolder=\(projectFolder) skipPanel=\(skipPanelId?.uuidString.prefix(8) ?? "nil")"
        )
        #endif

        let snapshot = workspace.panelDirectories
        var respawned = 0
        for (panelId, reportedDirectory) in snapshot {
            if let skipPanelId, panelId == skipPanelId { continue }

            let trimmed = reportedDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }

            let currentNormalized = URL(fileURLWithPath: trimmed).standardizedFileURL.path
            if currentNormalized == targetNormalized { continue }

            let isInsideProject = currentNormalized == projectNormalized
                || currentNormalized.hasPrefix(projectNormalized + "/")
            guard isInsideProject else { continue }

            guard let paneId = workspace.paneId(forPanelId: panelId) else { continue }
            guard workspace.newTerminalSurface(
                inPane: paneId, focus: false, workingDirectory: toPath
            ) != nil else { continue }
            _ = workspace.closePanel(panelId, force: true)
            respawned += 1
            #if DEBUG
            Self.debugLog(
                "respawn.panel ws=\(workspace.id.uuidString.prefix(8)) panel=\(panelId.uuidString.prefix(8)) from=\(trimmed) to=\(toPath)"
            )
            #endif
        }
        if respawned > 0 {
            Self.logger.info(
                "worktree respawn: ws=\(workspace.id.uuidString, privacy: .public) count=\(respawned, privacy: .public) toPath=\(toPath, privacy: .public)"
            )
        }
        #if DEBUG
        Self.debugLog(
            "respawn.result ws=\(workspace.id.uuidString.prefix(8)) count=\(respawned) toPath=\(toPath)"
        )
        #endif
        return respawned
    }

    /// Respawns panes whose cwd doesn't match the current worktree path.
    @discardableResult
    func respawnMismatchedPanels(workspace: Workspace) -> Int {
        guard let project = try? resolveProject(for: workspace),
              metadata.branch(for: workspace) != nil
        else { return 0 }
        let toPath = metadata.worktreePath(for: workspace)
            ?? workspace.termLoopPresentationCwd()
        guard let toPath else {
            #if DEBUG
            Self.debugLog(
                "respawnMismatched.skip ws=\(workspace.id.uuidString.prefix(8)) project=\(project.name)[\(project.id.uuidString.prefix(8))] reason=missingWorktreePath"
            )
            #endif
            return 0
        }
        #if DEBUG
        Self.debugLog(
            "respawnMismatched.begin ws=\(workspace.id.uuidString.prefix(8)) project=\(project.name)[\(project.id.uuidString.prefix(8))] toPath=\(toPath)"
        )
        #endif
        return respawnWorktreePanels(
            workspace: workspace,
            toPath: toPath,
            projectFolder: project.folderPath,
            skipPanelId: nil
        )
    }

    // MARK: - Detach

    func detach(
        workspace: Workspace,
        prune: PrunePolicy = .auto
    ) throws -> DetachResult {
        let project = try resolveProject(for: workspace)
        #if DEBUG
        Self.debugLog(
            "detach.begin ws=\(workspace.id.uuidString.prefix(8)) project=\(project.name)[\(project.id.uuidString.prefix(8))] prune=\(prune.rawValue) branch=\(metadata.branch(for: workspace) ?? "nil")"
        )
        #endif
        guard let branch = metadata.branch(for: workspace) else {
            #if DEBUG
            Self.debugLog("detach.skip ws=\(workspace.id.uuidString.prefix(8)) reason=noAttachedBranch")
            #endif
            return DetachResult(
                workspaceId: workspace.id, previousBranch: nil, worktreePruned: false
            )
        }

        let migrated = try migrateRunningAgent(
            workspace: workspace,
            project: project,
            toPath: project.folderPath,
            force: false
        )
        migratePersistedAgentSession(
            workspace: workspace,
            project: project,
            toPath: project.folderPath
        )
        _ = respawnWorktreePanels(
            workspace: workspace,
            toPath: project.folderPath,
            projectFolder: project.folderPath,
            skipPanelId: migrated ? workspace.focusedPanelId : nil
        )

        // Metadata is only cleared on the return path, AFTER any git op
        // we attempted has succeeded. If a git command throws (missing
        // worktree dir, permission denied, repo lock), the workspace stays
        // attached so the caller can retry instead of silently ending up
        // with a cleared pointer and an orphan worktree on disk.
        func clearAndReturn(pruned: Bool) -> DetachResult {
            metadata.setBranch(nil, for: workspace)
            metadata.setWorktreeBaselineHead(nil, forWorkspaceId: workspace.id)
            #if DEBUG
            Self.debugLog(
                "detach.result ws=\(workspace.id.uuidString.prefix(8)) branch=\(branch) pruned=\(pruned) project=\(project.name)[\(project.id.uuidString.prefix(8))]"
            )
            #endif
            return DetachResult(
                workspaceId: workspace.id, previousBranch: branch, worktreePruned: pruned
            )
        }

        if prune == .keep {
            return clearAndReturn(pruned: false)
        }

        let otherUsers = metadata.workspaceIds(
            withBranch: branch, projectId: project.id
        ).filter { $0 != workspace.id }
        guard otherUsers.isEmpty else {
            return clearAndReturn(pruned: false)
        }

        let worktrees = try service.list(in: project.folderPath)
        guard let entry = worktrees.first(where: { $0.branch == branch }),
              !entry.isMain else {
            return clearAndReturn(pruned: false)
        }

        if prune == .auto {
            let clean = (try? service.isClean(worktreePath: entry.path)) ?? false
            guard clean else {
                return clearAndReturn(pruned: false)
            }
            try service.remove(folder: project.folderPath, path: entry.path)
        } else {
            try service.remove(folder: project.folderPath, path: entry.path, force: true)
        }

        return clearAndReturn(pruned: true)
    }

    // MARK: - Helpers

    private func resolveProject(for workspace: Workspace) throws -> Project {
        guard let projectId = workspace.projectId,
              let project = ProjectStore.shared.project(id: projectId) else {
            #if DEBUG
            Self.debugLog("resolveProject.fail ws=\(workspace.id.uuidString.prefix(8)) projectId=\(workspace.projectId?.uuidString ?? "nil")")
            #endif
            throw WorktreeError.notFound(what: "project for workspace")
        }
        #if DEBUG
        Self.debugLog(
            "resolveProject.ok ws=\(workspace.id.uuidString.prefix(8)) project=\(project.name)[\(project.id.uuidString.prefix(8))] folder=\(project.folderPath)"
        )
        #endif
        return project
    }

    private func preflightUntrackedCopies(
        relativePaths: [String],
        from sourceRoot: String,
        to destinationRoot: String
    ) throws {
        #if DEBUG
        Self.debugLog(
            "preflightUntracked.begin count=\(relativePaths.count) from=\(sourceRoot) to=\(destinationRoot)"
        )
        #endif
        for relativePath in relativePaths {
            let sourceURL = URL(fileURLWithPath: sourceRoot).appendingPathComponent(relativePath)
            let destinationURL = URL(fileURLWithPath: destinationRoot).appendingPathComponent(relativePath)
            guard FileManager.default.fileExists(atPath: sourceURL.path) else {
                throw WorktreeError.invalidParams(
                    reason: "Untracked path is missing on disk: \(relativePath)"
                )
            }
            guard !FileManager.default.fileExists(atPath: destinationURL.path) else {
                throw WorktreeError.invalidParams(
                    reason: "Cannot bring local changes over because \(relativePath) already exists in \(destinationRoot)."
                )
            }
        }
    }

    private func copyUntrackedPaths(
        relativePaths: [String],
        from sourceRoot: String,
        to destinationRoot: String
    ) throws {
        #if DEBUG
        Self.debugLog(
            "copyUntracked.begin count=\(relativePaths.count) from=\(sourceRoot) to=\(destinationRoot)"
        )
        #endif
        for relativePath in relativePaths {
            let sourceURL = URL(fileURLWithPath: sourceRoot).appendingPathComponent(relativePath)
            let destinationURL = URL(fileURLWithPath: destinationRoot).appendingPathComponent(relativePath)
            try FileManager.default.createDirectory(
                at: destinationURL.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: nil
            )
            try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
        }
    }

    private func resolvedWorkspacePath(
        workspace: Workspace,
        projectFolder: String,
        worktrees: [GitWorktreeService.ListEntry]
    ) -> String {
        guard let branch = metadata.branch(for: workspace) else {
            #if DEBUG
            Self.debugLog("resolvedWorkspacePath.default ws=\(workspace.id.uuidString.prefix(8)) projectFolder=\(projectFolder) reason=noBranch")
            #endif
            return projectFolder
        }
        if let recorded = metadata.worktreePath(for: workspace) {
            #if DEBUG
            Self.debugLog("resolvedWorkspacePath.recorded ws=\(workspace.id.uuidString.prefix(8)) branch=\(branch) path=\(recorded)")
            #endif
            return recorded
        }
        if let main = worktrees.first(where: { $0.isMain }),
           main.branch == branch {
            #if DEBUG
            Self.debugLog("resolvedWorkspacePath.main ws=\(workspace.id.uuidString.prefix(8)) branch=\(branch) path=\(main.path)")
            #endif
            return main.path
        }
        if let existing = worktrees.first(where: { $0.branch == branch }) {
            #if DEBUG
            Self.debugLog("resolvedWorkspacePath.listed ws=\(workspace.id.uuidString.prefix(8)) branch=\(branch) path=\(existing.path)")
            #endif
            return existing.path
        }
        #if DEBUG
        Self.debugLog("resolvedWorkspacePath.missing ws=\(workspace.id.uuidString.prefix(8)) branch=\(branch) projectFolder=\(projectFolder)")
        #endif
        return projectFolder
    }

    func ensureCleanSourceCheckout(projectFolder: String) throws {
        #if DEBUG
        Self.debugLog("ensureCleanSourceCheckout.begin folder=\(projectFolder)")
        #endif
        guard try service.isClean(worktreePath: projectFolder) else {
            #if DEBUG
            Self.debugLog("ensureCleanSourceCheckout.blocked folder=\(projectFolder) reason=dirty")
            #endif
            throw WorktreeError.dirtyWorktree(path: projectFolder)
        }
        #if DEBUG
        Self.debugLog("ensureCleanSourceCheckout.ok folder=\(projectFolder)")
        #endif
    }

    private func ensureGitIgnore(in folder: String) throws {
        let url = URL(fileURLWithPath: folder).appendingPathComponent(".gitignore")
        let line = "\(WorktreeResolver.worktreesDirName)/\n"
        #if DEBUG
        Self.debugLog("ensureGitIgnore.begin folder=\(folder)")
        #endif
        if let existing = try? String(contentsOf: url, encoding: .utf8) {
            if !Self.gitIgnoreAlreadyCovers(existing, pattern: WorktreeResolver.worktreesDirName) {
                let joiner = existing.hasSuffix("\n") ? "" : "\n"
                try (existing + joiner + line).write(
                    to: url, atomically: true, encoding: .utf8
                )
                #if DEBUG
                Self.debugLog("ensureGitIgnore.appended folder=\(folder)")
                #endif
            }
        } else {
            try line.write(to: url, atomically: true, encoding: .utf8)
            #if DEBUG
            Self.debugLog("ensureGitIgnore.created folder=\(folder)")
            #endif
        }
    }

    /// True iff `content` has a non-comment, non-negated line that matches
    /// the directory pattern (with/without leading `/` and trailing `/`).
    /// Previously `ensureGitIgnore` did a raw substring check, so a mention
    /// inside a `# comment` suppressed the real rule and `.termloop-worktrees/`
    /// never actually got ignored.
    static func gitIgnoreAlreadyCovers(_ content: String, pattern: String) -> Bool {
        let variants: Set<String> = [
            pattern,
            "\(pattern)/",
            "/\(pattern)",
            "/\(pattern)/"
        ]
        for raw in content.split(whereSeparator: \.isNewline) {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#"), !trimmed.hasPrefix("!") else {
                continue
            }
            if variants.contains(String(trimmed)) { return true }
        }
        return false
    }

    private func startSubmoduleInitializationIfNeeded(
        createdWorktree: Bool,
        path: String,
        branch: String,
        workspaceId: UUID
    ) {
        #if DEBUG
        Self.debugLog(
            "submoduleInit.begin createdWorktree=\(createdWorktree) path=\(path) branch=\(branch) ws=\(workspaceId.uuidString.prefix(8))"
        )
        #endif
        if createdWorktree {
            #if DEBUG
            dlog("worktree.attach → startInBackground for \(branch)")
            #endif
            SubmoduleInitService.startInBackground(
                worktreePath: path,
                displayLabel: branch,
                branch: branch,
                workspaceId: workspaceId
            )
            return
        }

        DispatchQueue.global(qos: .utility).async {
            guard SubmoduleInitService.hasUninitializedSubmodules(worktreePath: path) else { return }
            #if DEBUG
            Self.debugLog("submoduleInit.defer path=\(path) branch=\(branch) ws=\(workspaceId.uuidString.prefix(8))")
            #endif
            DispatchQueue.main.async {
                SubmoduleInitService.startInBackground(
                    worktreePath: path,
                    displayLabel: branch,
                    branch: branch,
                    workspaceId: workspaceId
                )
            }
        }
    }
}

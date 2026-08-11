// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Bonsplit
import Foundation
import os

/// Fires `claude --resume <sessionId>` into a workspace's terminal once the
/// ghostty surface is ready to accept input. Keyed on the
/// `.terminalSurfaceDidBecomeReady` notification (same signal AppDelegate and
/// ContentView already listen on), so the restore command lands right after
/// the shell prompt appears rather than at an undefined point during window
/// restore.
///
/// Two entry points:
///   • `enqueue(workspaceId:session:)` — called from
///     `TermLoopHooks.didRestoreWorkspaces` on app launch. Restore fires
///     automatically when the matching surface reports ready.
///   • `restoreNow(workspaceId:)` — called from the "Restore Claude Session"
///     context-menu item. If the surface is already ready, the pending
///     enqueue still resolves on the next event (e.g. focus change re-emits
///     the ready notification on some code paths); if not, it just waits.
@MainActor
final class ClaudeRestoreCoordinator {
    static let shared = ClaudeRestoreCoordinator()

    private static let logger = Logger(
        subsystem: "com.termloop.fork",
        category: "claude-restore"
    )
    private static let workspaceIdUserInfoKey = "workspaceId"
    private static let retryDelays: [TimeInterval] = [0.25, 0.75, 1.5, 3.0]

    private struct PendingRestoreState {
        let session: PersistedAgentSession
    }

    /// Pending resume requests keyed by workspace id. Entries are removed as
    /// soon as a restore command is dispatched, or when the 30s timeout fires.
    /// We retry while waiting for a ready surface, but never after dispatch:
    /// a second restore command can land inside the resumed Claude UI.
    private var pending: [UUID: PendingRestoreState] = [:]
    private var readyObserver: NSObjectProtocol?
    private static let pendingTimeout: TimeInterval = 30
    private static let restoreScriptPrefix = "claude-restore-"
    private static let restoreScriptMaxRetained = 64
    private static let restoreScriptMaxAge: TimeInterval = 24 * 60 * 60

    private enum FailureReason {
        case missingCwd
        case unsafeSessionId(String)
        case missingSessionFile(String)
        case missingWorktree(String)
        case recreateWorktreeFailed(String, String)

        var message: String {
            switch self {
            case .missingCwd:
                return "[termloop] Claude resume failed: no restore cwd was available."
            case .unsafeSessionId(let sessionId):
                return "[termloop] Claude resume failed: unsafe session id \(sessionId)."
            case .missingSessionFile(let sessionId):
                return "[termloop] Claude resume failed: session file was not found for \(sessionId)."
            case .missingWorktree(let path):
                return "[termloop] Claude resume failed: worktree was not found at \(path)."
            case .recreateWorktreeFailed(let path, let branch):
                return "[termloop] Claude resume failed: worktree was missing and could not be recreated at \(path) for \(branch)."
            }
        }
    }

#if DEBUG
    private static func debugClean(_ value: String?) -> String {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty
            ? "nil"
            : trimmed
                .replacingOccurrences(of: "\n", with: " ")
                .replacingOccurrences(of: "\r", with: " ")
    }

    private static func debugShort(_ id: UUID?) -> String {
        guard let id else { return "nil" }
        return String(id.uuidString.prefix(8))
    }

    private static func debugProject(_ id: UUID?) -> String {
        guard let id else { return "nil" }
        guard let project = ProjectStore.shared.project(id: id) else {
            return "missing:\(debugShort(id))"
        }
        return "\(debugClean(project.name))[\(debugShort(id))] path=\(debugClean(project.folderPath))"
    }
#endif

    private init() {
        readyObserver = NotificationCenter.default.addObserver(
            forName: .terminalSurfaceDidBecomeReady,
            object: nil,
            queue: .main
        ) { [weak self] note in
            MainActor.assumeIsolated {
                self?.handleSurfaceReady(note)
            }
        }
    }

    deinit {
        if let readyObserver {
            NotificationCenter.default.removeObserver(readyObserver)
        }
    }

    /// Registers intent to resume `session` in `workspaceId` the next time
    /// that workspace's terminal surface reports ready. Called once per
    /// workspace at sidecar load time.
    func enqueue(workspaceId: UUID, session: PersistedAgentSession) {
        pending[workspaceId] = PendingRestoreState(session: session)
#if DEBUG
        dlog("claude-restore.enqueue ws=\(workspaceId.uuidString.prefix(8)) sid=\(session.sessionId.prefix(8)) cwd=\(session.cwd ?? "nil")")
#endif
        scheduleRetries(workspaceId: workspaceId, session: session)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pendingTimeout) { [weak self] in
            guard let self else { return }
            if self.pending[workspaceId] != nil {
                self.pending.removeValue(forKey: workspaceId)
                Self.logger.info(
                    "restore timeout ws=\(workspaceId.uuidString, privacy: .public)"
                )
#if DEBUG
                dlog("claude-restore.timeout ws=\(workspaceId.uuidString.prefix(8))")
#endif
            }
        }
    }

    /// User-initiated restore (right-click → "Restore Claude Session"). Tries
    /// to fire immediately if the workspace has a focused terminal surface;
    /// otherwise enqueues so the next ready notification triggers it.
    func restoreNow(workspaceId: UUID) {
        guard let session = WorkspaceMetadataStore.shared.persistedAgentSession(for: workspaceId),
              session.agentId == TerminalAgent.claudeId else {
            return
        }
        if fire(workspaceId: workspaceId, session: session) { return }
        enqueue(workspaceId: workspaceId, session: session)
    }

    /// Called from `TermLoopHooks.didRestoreWorkspaces` right after a
    /// session snapshot restore finishes. At this point the surface-ready
    /// notification has likely already fired (surfaces are created during
    /// session restore, and the notification pipeline is synchronous with
    /// surface init) — so we try to fire immediately, and fall back to
    /// enqueueing if the panel isn't available yet (e.g. window restored
    /// but not yet materialized on the main thread).
    func restoreAfterSessionLoad(workspaceId: UUID, session: PersistedAgentSession) {
        enqueue(workspaceId: workspaceId, session: session)
        // Defer one runloop tick so the workspace's panels finish wiring
        // up after the session-restore pass that called us.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.pending[workspaceId] != nil else { return }
            _ = self.fire(workspaceId: workspaceId, session: session)
        }
    }

    // MARK: - Internals

    private func handleSurfaceReady(_ note: Notification) {
        guard let workspaceId = note.userInfo?[Self.workspaceIdUserInfoKey] as? UUID else {
            return
        }
#if DEBUG
        let pendingState = pending[workspaceId] == nil ? "no-pending" : "has-pending"
        dlog("claude-restore.surfaceReady ws=\(workspaceId.uuidString.prefix(8)) \(pendingState)")
#endif
        guard let state = pending[workspaceId] else { return }
        _ = fire(workspaceId: workspaceId, session: state.session)
    }

    private func scheduleRetries(workspaceId: UUID, session: PersistedAgentSession) {
        for delay in Self.retryDelays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self,
                      let pendingState = self.pending[workspaceId],
                      pendingState.session == session else {
                    return
                }
                _ = self.fire(workspaceId: workspaceId, session: session)
            }
        }
    }

    /// Returns true iff the resume command was queued to the terminal.
    /// Returns false if there's no suitable panel yet or a live claude
    /// session already exists for this workspace (hook beat us to it).
    @discardableResult
    private func fire(workspaceId: UUID, session: PersistedAgentSession) -> Bool {
        let wsIdStr = workspaceId.uuidString
        if WorkspaceMetadataStore.shared.claudeSession(workspaceId: wsIdStr) != nil {
#if DEBUG
            dlog("claude-restore.fire skip=liveSession ws=\(wsIdStr.prefix(8))")
#endif
            pending.removeValue(forKey: workspaceId)
            return false
        }
        guard pending[workspaceId]?.session == session else {
            return false
        }
        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
#if DEBUG
            dlog("claude-restore.fire skip=noWorkspace ws=\(wsIdStr.prefix(8))")
#endif
            return false
        }
        guard let panel = selectTerminalPanel(for: workspace) else {
#if DEBUG
            dlog("claude-restore.fire skip=noPanel ws=\(wsIdStr.prefix(8))")
#endif
            workspace.requestBackgroundTerminalSurfaceStartIfNeeded()
            return false
        }
        guard panel.surface.surface != nil else {
#if DEBUG
            dlog("claude-restore.fire skip=surfaceNotReady ws=\(wsIdStr.prefix(8)) panel=\(panel.id.uuidString.prefix(5))")
#endif
            panel.surface.requestBackgroundSurfaceStartIfNeeded()
            workspace.requestBackgroundTerminalSurfaceStartIfNeeded()
            return false
        }
        var worktreeExpectation = try? workspace.termLoopWorktreeExpectation()
        let persistedWorktreeRoot = Self.termLoopWorktreeRoot(containing: session.cwd)
        let recoveredWorktree = Self.recoveredWorktreeContext(
            workspaceId: workspaceId,
            workspaceTitle: workspace.customTitle ?? workspace.title,
            worktreeRoot: persistedWorktreeRoot
        )
        if let persistedWorktreeRoot,
           !Self.directoryExists(persistedWorktreeRoot),
           ClaudeProjectFiles.sessionExists(sessionId: session.sessionId, cwd: persistedWorktreeRoot) {
            guard let recoveredWorktree,
                  let project = recoveredWorktree.project else {
                pending.removeValue(forKey: workspaceId)
                surfaceFailure(.missingWorktree(persistedWorktreeRoot), in: panel, workspaceId: workspaceId, session: session)
                return false
            }
            do {
                try GitWorktreeService().add(
                    folder: project.folderPath,
                    path: recoveredWorktree.path,
                    branch: recoveredWorktree.branch
                )
            } catch {
                pending.removeValue(forKey: workspaceId)
                surfaceFailure(
                    .recreateWorktreeFailed(recoveredWorktree.path, recoveredWorktree.branch),
                    in: panel,
                    workspaceId: workspaceId,
                    session: session
                )
                return false
            }
        }
        if let recoveredWorktree,
           Self.directoryExists(recoveredWorktree.path),
           Self.shouldPreferRecoveredWorktree(recoveredWorktree, over: worktreeExpectation, sessionId: session.sessionId) {
            worktreeExpectation = recoveredWorktree.expectation
            healWorkspaceMetadataIfNeeded(workspaceId: workspaceId, recovered: recoveredWorktree)
        }
        let spawnCwd = try? workspace.termLoopSpawnCwd()
        let targetCwd = preferredResumeCwd(
            for: workspace,
            persisted: session,
            worktreeExpectation: worktreeExpectation,
            spawnCwd: spawnCwd
        )
#if DEBUG
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
        dlog(
            "claude-restore.fire.evaluate ws=\(wsIdStr) title=\(Self.debugClean(workspace.customTitle ?? workspace.title)) " +
            "sid=\(session.sessionId) sessionCwd=\(Self.debugClean(session.cwd)) targetCwd=\(Self.debugClean(targetCwd)) " +
            "project=\(Self.debugProject(metadata.projectId)) branch=\(Self.debugClean(metadata.branch)) worktree=\(Self.debugClean(metadata.worktreePath)) " +
            "expectationPath=\(Self.debugClean(worktreeExpectation?.path))"
        )
#endif
        guard let targetCwd, !targetCwd.isEmpty else {
#if DEBUG
            dlog("claude-restore.fire skip=noCwd ws=\(wsIdStr.prefix(8))")
#endif
            pending.removeValue(forKey: workspaceId)
            surfaceFailure(.missingCwd, in: panel, workspaceId: workspaceId, session: session)
            return false
        }
        // Defense in depth: sessionId is spliced UNQUOTED into the resume
        // command below. Refuse to build the line if it carries any shell
        // metacharacters, even though the report hook already rejects them.
        guard TermLoopShell.isSafeUnquotedIdentifier(session.sessionId) else {
            Self.logger.error(
                "claude-restore: refusing — unsafe session id \(session.sessionId, privacy: .public)"
            )
            pending.removeValue(forKey: workspaceId)
            surfaceFailure(.unsafeSessionId(session.sessionId), in: panel, workspaceId: workspaceId, session: session)
            return false
        }
        UserScopeHookSync.ensureInstalled(for: .claude)
        if !targetCwd.isEmpty {
            UserScopeHookSync.cleanupProjectScope(
                at: URL(fileURLWithPath: targetCwd, isDirectory: true),
                for: .claude
            )
        }
        // Compute project folder first so it can serve as a fallback source.
        // When an agent was moved to a worktree, session.cwd == targetCwd ==
        // worktree path. ensureSessionAvailable skips source == target, so
        // without the project root we have no fallback if the initial copy
        // failed (e.g. race condition during migration). Mirror the candidate
        // set that WorktreeCoordinator.claudeSessionCandidateSources builds.
        let projectFolderPath = ProjectInstructionStore.resolvedProjectFolderPath(
            for: workspace,
            runCwd: targetCwd
        )
        var sourceCwdCandidates: [String?] = [session.cwd, targetCwd, projectFolderPath]
        if let spawnCwd {
            sourceCwdCandidates.append(spawnCwd)
        }
        let sourceCwds = sourceCwdCandidates.compactMap { $0 }
        guard ClaudeProjectFiles.ensureSessionAvailable(
            sessionId: session.sessionId,
            targetCwd: targetCwd,
            sourceCwds: sourceCwds
        ) else {
            Self.logger.info(
                "session file missing ws=\(wsIdStr, privacy: .public) sid=\(session.sessionId, privacy: .public)"
            )
#if DEBUG
            dlog("claude-restore.fire skip=sessionFileMissing ws=\(wsIdStr.prefix(8)) sid=\(session.sessionId.prefix(8))")
#endif
            pending.removeValue(forKey: workspaceId)
            if WorkspaceMetadataStore.shared.clearPersistedAgentSession(for: workspaceId) {
                TermLoopHooks.saveCriticalAgentRestoreStateSync()
            }
            surfaceFailure(
                .missingSessionFile(session.sessionId),
                in: panel,
                workspaceId: workspaceId,
                session: session,
                includeSessionId: false
            )
            return false
        }
        // Use `c` so the user's shell alias resolves (e.g. `alias c='claude
        // --dangerously-skip-permissions'`). `c` with no alias will fail
        // with "command not found" — that's visible and trivially fixable,
        // preferable to silently stripping the user's custom invocation.
        let resumeCommand = ClaudeResumeCommandBuilder.buildCommand(
            executable: "c",
            sessionId: session.sessionId,
            env: ["TERMLOOP_WORKSPACE_ID": wsIdStr]
                .merging(worktreeExpectation?.environment ?? [:]) { _, new in new },
            projectFolderPath: projectFolderPath,
            runCwd: targetCwd,
            cdIntoRunCwd: true
        )
        let commandText: String = {
            guard let scriptURL = writeInteractiveBootstrapScript(command: resumeCommand) else {
                return resumeCommand
            }
            return "sh \(TermLoopShell.quoteSingle(scriptURL.path))"
        }()

#if DEBUG
        dlog(
            "claude-restore.fire dispatch ws=\(wsIdStr) panel=\(panel.id.uuidString.prefix(5)) " +
            "sid=\(session.sessionId) targetCwd=\(Self.debugClean(targetCwd)) projectFolder=\(Self.debugClean(projectFolderPath))"
        )
#endif
        TerminalAgentRunner.dispatchShellCommandWhenReady(
            commandText,
            on: panel,
            enterFallbackDelay: 0.75
        )

        pending.removeValue(forKey: workspaceId)
        return true
    }

    private func surfaceFailure(
        _ reason: FailureReason,
        in panel: TerminalPanel,
        workspaceId: UUID,
        session: PersistedAgentSession,
        includeSessionId: Bool = true
    ) {
        let message = reason.message
        Self.logger.info(
            "restore failed ws=\(workspaceId.uuidString, privacy: .public) reason=\(message, privacy: .public)"
        )
#if DEBUG
        dlog("claude-restore.failure ws=\(workspaceId.uuidString.prefix(8)) message=\(message)")
#endif
        _ = TermLoopSocketCommands.workspaceReportAgentActivity([
            "workspace_id": workspaceId.uuidString,
            "agent_id": session.agentId,
            "phase": "failed",
            "message_preview": message,
            "session_id": includeSessionId ? session.sessionId : NSNull(),
            "cwd": session.cwd as Any
        ])
        let command = "printf '\\n%s\\n\\n' \(TermLoopShell.quoteSingle(message))"
        DispatchQueue.main.async {
            panel.sendText(command)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                panel.sendInput("\r")
            }
        }
    }

    private func preferredResumeCwd(
        for workspace: Workspace,
        persisted: PersistedAgentSession,
        worktreeExpectation: TermLoopWorktreeExpectation?,
        spawnCwd resolvedSpawnCwd: String?
    ) -> String? {
        func existingPath(_ raw: String?) -> String? {
            guard let path = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !path.isEmpty,
                  FileManager.default.fileExists(atPath: path) else {
                return nil
            }
            return path
        }

        if let worktreePath = existingPath(worktreeExpectation?.path) {
            return worktreePath
        }
        if let persistedWorktreeRoot = existingPath(
            Self.termLoopWorktreeRoot(containing: persisted.cwd)
        ) {
            return persistedWorktreeRoot
        }
        if let spawnCwd = existingPath(resolvedSpawnCwd) {
            return spawnCwd
        }
        return existingPath(persisted.cwd)
    }

    private struct RecoveredWorktreeContext {
        let project: Project?
        let path: String
        let branch: String

        var expectation: TermLoopWorktreeExpectation {
            TermLoopWorktreeExpectation(path: path, branch: branch)
        }
    }

    private static func recoveredWorktreeContext(
        workspaceId: UUID,
        workspaceTitle: String?,
        worktreeRoot: String?
    ) -> RecoveredWorktreeContext? {
        let store = WorkspaceMetadataStore.shared
        let metadata = store.metadata(forWorkspaceId: workspaceId)
        guard let root = worktreeRoot else { return nil }
        let branch = nonEmpty(metadata.branch)
            ?? branchNameForGitCheckout(at: root)
            ?? branchNameFromTitle(workspaceTitle)
            ?? branchNameFromWorktreeLeaf(root)
        guard let branch else { return nil }
        return RecoveredWorktreeContext(
            project: recoveredProject(forWorktreeRoot: root),
            path: root,
            branch: branch
        )
    }

    private static func shouldPreferRecoveredWorktree(
        _ recovered: RecoveredWorktreeContext,
        over expectation: TermLoopWorktreeExpectation?,
        sessionId: String
    ) -> Bool {
        guard let expectation else { return true }
        if !directoryExists(expectation.path) { return true }
        if expectation.path == recovered.path { return true }
        return ClaudeProjectFiles.sessionExists(sessionId: sessionId, cwd: recovered.path)
    }

    private func healWorkspaceMetadataIfNeeded(
        workspaceId: UUID,
        recovered: RecoveredWorktreeContext
    ) {
        var metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
        var changed = false

        if let project = recovered.project,
           metadata.projectId == nil || ProjectStore.shared.project(id: metadata.projectId!) == nil {
            metadata.projectId = project.id
            changed = true
        }

        if metadata.branch != recovered.branch || metadata.worktreePath != recovered.path {
            metadata.branch = recovered.branch
            metadata.worktreePath = recovered.path
            metadata.worktreeBaselineHead = nil
            changed = true
        }

        guard changed else { return }
        WorkspaceMetadataStore.shared.restoreMetadata(metadata, forWorkspaceId: workspaceId)
    }

    static func termLoopWorktreeRoot(containing rawPath: String?) -> String? {
        guard let rawPath,
              case let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        let normalized = URL(fileURLWithPath: trimmed).standardizedFileURL.path
        return WorktreeResolver.worktreeRoot(containing: normalized)
    }

    private static func recoveredProject(forWorktreeRoot root: String) -> Project? {
        if let existing = ProjectStore.shared.project(containingPath: root) {
            return existing
        }
        guard let projectRoot = termLoopProjectRoot(containingWorktreeRoot: root) else {
            return nil
        }
        return ProjectStore.shared.project(containingPath: projectRoot)
    }

    private static func termLoopProjectRoot(containingWorktreeRoot root: String) -> String? {
        let normalized = URL(fileURLWithPath: root).standardizedFileURL.path
        let marker = "/" + WorktreeResolver.worktreesDirName + "/"
        guard let range = normalized.range(of: marker, options: .backwards) else {
            return nil
        }
        return String(normalized[..<range.lowerBound])
    }

    private static func branchNameForGitCheckout(at checkoutPath: String) -> String? {
        let checkoutURL = URL(fileURLWithPath: checkoutPath).standardizedFileURL
        let gitURL = checkoutURL.appendingPathComponent(".git")
        let headURL: URL

        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: gitURL.path, isDirectory: &isDir),
           isDir.boolValue {
            headURL = gitURL.appendingPathComponent("HEAD")
        } else if let gitFile = try? String(contentsOf: gitURL, encoding: .utf8),
                  let gitDirLine = gitFile
                    .split(whereSeparator: { $0.isNewline })
                    .first(where: { $0.lowercased().hasPrefix("gitdir:") }) {
            let rawGitDir = gitDirLine
                .dropFirst("gitdir:".count)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rawGitDir.isEmpty else { return nil }
            let gitDirURL = rawGitDir.hasPrefix("/")
                ? URL(fileURLWithPath: rawGitDir)
                : checkoutURL.appendingPathComponent(rawGitDir)
            headURL = gitDirURL.standardizedFileURL.appendingPathComponent("HEAD")
        } else {
            return nil
        }

        guard let head = try? String(contentsOf: headURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
              head.hasPrefix("ref: refs/heads/") else {
            return nil
        }
        return nonEmpty(String(head.dropFirst("ref: refs/heads/".count)))
    }

    static func branchNameFromTitle(_ title: String?) -> String? {
        guard let title = nonEmpty(title) else { return nil }
        let head = title
            .split(whereSeparator: { $0.isWhitespace || $0 == "(" })
            .first
            .map(String.init)
        guard let head,
              head.contains("/"),
              !head.contains("://") else {
            return nil
        }
        return nonEmpty(head)
    }

    static func branchNameFromWorktreeLeaf(_ root: String) -> String? {
        let leaf = URL(fileURLWithPath: root).lastPathComponent
        guard !leaf.isEmpty else { return nil }
        let trimmedHashSuffix: String = {
            guard let range = leaf.range(of: #"-[0-9a-fA-F]{4}$"#, options: .regularExpression) else {
                return leaf
            }
            return String(leaf[..<range.lowerBound])
        }()
        return nonEmpty(trimmedHashSuffix.replacingOccurrences(of: "__", with: "/"))
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func directoryExists(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir)
            && isDir.boolValue
    }

    private func writeInteractiveBootstrapScript(command: String) -> URL? {
        let delimiter = "TERMLOOP_TERMLOOP_CLAUDE_RESTORE_EOF_\(UUID().uuidString.replacingOccurrences(of: "-", with: "_"))"
        let script = """
        #!/bin/sh
        cmux_termloop_shell="${SHELL:-/bin/zsh}"
        cmux_termloop_command="$(cat <<'\(delimiter)'
        \(command)
        \(delimiter)
        )"
        exec "$cmux_termloop_shell" -ilc "$cmux_termloop_command"
        """

        let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("termloop-terminal-agents", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            pruneRestoreScripts(in: dir)
            let fileURL = dir.appendingPathComponent("\(Self.restoreScriptPrefix)\(UUID().uuidString).sh")
            try script.write(to: fileURL, atomically: true, encoding: .utf8)
            return fileURL
        } catch {
            return nil
        }
    }

    private func pruneRestoreScripts(in dir: URL) {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        let now = Date()
        let scripts: [(url: URL, modifiedAt: Date)] = urls.compactMap { url in
            let name = url.lastPathComponent
            guard name.hasPrefix(Self.restoreScriptPrefix), url.pathExtension == "sh" else {
                return nil
            }
            guard let values = try? url.resourceValues(
                forKeys: [.contentModificationDateKey, .isRegularFileKey]
            ), values.isRegularFile == true else {
                return nil
            }
            return (url, values.contentModificationDate ?? .distantPast)
        }
            .sorted(by: { $0.modifiedAt > $1.modifiedAt })

        for (index, item) in scripts.enumerated() {
            let isOverflow = index >= Self.restoreScriptMaxRetained
            let isStale = now.timeIntervalSince(item.modifiedAt) > Self.restoreScriptMaxAge
            if isOverflow || isStale {
                try? fm.removeItem(at: item.url)
            }
        }
    }

    private func selectTerminalPanel(for workspace: Workspace) -> TerminalPanel? {
        if let focused = workspace.focusedTerminalPanel {
            return focused
        }
        if let panelId = workspace.focusedPanelId,
           let panel = workspace.terminalPanel(for: panelId) {
            return panel
        }
        return workspace.panels.values
            .compactMap { $0 as? TerminalPanel }
            .sorted { $0.id.uuidString < $1.id.uuidString }
            .first
    }

}

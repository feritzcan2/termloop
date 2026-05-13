// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Bonsplit
import Foundation
import SwiftUI
import os

/// TermLoop-side hook entry points called from upstream files via marker-wrapped
/// one-liners. Centralizes the TermLoop knowledge so upstream code stays as
/// close to `upstream/main` as possible.
@MainActor
enum TermLoopHooks {
    private static let logger = Logger(subsystem: "com.termloop.fork", category: "hooks")
    private static let persistedAgentFallbackRecency: TimeInterval = 60 * 60
    private static let persistedAgentRecoveryDelays: [TimeInterval] = [2.0, 8.0, 20.0, 45.0]
    private static let minimumDistinctBackfillScore = 240

    struct BackfillCandidate {
        let workspaceId: UUID
        let agentId: String
        let cwd: String
        let startedAt: Date?
        let workspaceTitle: String?
        let lastMessagePreview: String?
    }

    struct BackfillSessionCandidate {
        let session: PersistedAgentSession
        let title: String?
        let assistantPreview: String?
        let userPreview: String?
    }

    private struct PendingRestoreWorkspaceMetadata {
        let metadata: WorkspaceMetadataStore.Metadata
        let processTitle: String?
        let customTitle: String?
        let currentDirectory: String?
        let termLoopRestoreId: UUID?
    }

    static var restoredTerminalLauncher: (Workspace, TerminalAgent, String?, [String: String]) -> Void = {
        workspace, agent, cwd, env in
        TerminalAgentRunner.dispatchRestoredAgentCommand(in: workspace, agent: agent, cwd: cwd, env: env)
    }

    /// Per-window positional metadata queued at sidecar load and drained by
    /// `didRestoreWorkspaces(workspaces:)` as each window finishes its
    /// upstream restore. UUID-keyed restore can't work because
    /// `SessionWorkspaceSnapshot` doesn't persist workspace ids — each
    /// restart mints fresh UUIDs.
    private static var pendingRestoreMetadata: [[PendingRestoreWorkspaceMetadata]] = []

    /// Freshly-migrated workspace ids (assigned a default terminal agent via
    /// `WorkspaceAgentMigration`). Consumed once per id by the focus path so
    /// the migration toast fires exactly once per legacy workspace.
    private static var pendingMigrationToastWorkspaceIds: Set<UUID> = []

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

    private static func debugSession(_ session: PersistedAgentSession?) -> String {
        guard let session else { return "nil" }
        return "agent=\(session.agentId) sid=\(session.sessionId) cwd=\(debugClean(session.cwd))"
    }

    private static func debugProject(_ id: UUID?) -> String {
        guard let id else { return "nil" }
        guard let project = ProjectStore.shared.project(id: id) else {
            return "missing:\(debugShort(id))"
        }
        return "\(debugClean(project.name))[\(debugShort(id))] path=\(debugClean(project.folderPath))"
    }

    private static func debugMetadata(_ metadata: WorkspaceMetadataStore.Metadata) -> String {
        [
            "project=\(debugProject(metadata.projectId))",
            "terminalAgent=\(debugClean(metadata.terminalAgentId))",
            "branch=\(debugClean(metadata.branch))",
            "worktree=\(debugClean(metadata.worktreePath))",
            "baseline=\(debugClean(metadata.worktreeBaselineHead))",
            "persisted={\(debugSession(metadata.persistedAgentSession))}"
        ].joined(separator: " ")
    }

    private static func debugRestoreEntry(_ entry: PendingRestoreWorkspaceMetadata) -> String {
        [
            "restoreId=\(entry.termLoopRestoreId?.uuidString ?? "nil")",
            "entryTitle=\(debugClean(entry.customTitle ?? entry.processTitle))",
            "entryCwd=\(debugClean(entry.currentDirectory))",
            debugMetadata(entry.metadata)
        ].joined(separator: " ")
    }

    private static func debugRestoreAssignment(
        stage: String,
        entryIndex: Int,
        workspace: Workspace,
        entry: PendingRestoreWorkspaceMetadata
    ) {
        dlog(
            "session.restore.map stage=\(stage) entry=\(entryIndex) ws=\(workspace.id.uuidString) " +
            "wsTitle=\(debugClean(workspaceDisplayTitle(workspace))) wsCwd=\(debugClean(workspace.currentDirectory)) " +
            debugRestoreEntry(entry)
        )
    }

    private static func debugSnapshotMetadata(
        _ metadata: WorkspaceMetadataStore.Metadata,
        workspaceId: UUID? = nil
    ) -> String {
        [
            "ws=\(workspaceId.map { $0.uuidString } ?? "nil")",
            "project=\(debugProject(metadata.projectId))",
            "terminalAgent=\(debugClean(metadata.terminalAgentId))",
            "branch=\(debugClean(metadata.branch))",
            "worktree=\(debugClean(metadata.worktreePath))",
            "persisted={\(debugSession(metadata.persistedAgentSession))}",
            "hidden=\(metadata.isHidden == true ? 1 : 0)"
        ].joined(separator: " ")
    }
#endif

    /// UserDefaults key backing the "Auto-restore Claude sessions on launch"
    /// toggle in TermLoop Settings. Default is `true` — **opt-out**. The
    /// Settings toggle writes the explicit user choice to UserDefaults;
    /// `isClaudeAutoRestoreEnabled()` treats "unset" as on so first launch
    /// actually restores sessions without requiring a prior opt-in.
    static let claudeAutoRestoreDefaultsKey = "termloop.claudeAutoRestore"

    /// Legacy UserDefaults key from the opt-in era. Kept as a constant so
    /// `TermLoopSettingsView` can continue writing to it (harmless) and any
    /// pre-existing `true` value still exists after upgrade. No longer
    /// gates the feature.
    static let claudeAutoRestoreAskedDefaultsKey = "termloop.claudeAutoRestoreAsked"

#if DEBUG
    static func debugTitlebarControlsStyleMenu(selection: Binding<Int>) -> some View {
        Menu("Titlebar Controls Style") {
            ForEach(TitlebarControlsStyle.allCases) { style in
                Button {
                    selection.wrappedValue = style.rawValue
                } label: {
                    Label {
                        Text(style.menuTitle)
                    } icon: {
                        Image(systemName: selection.wrappedValue == style.rawValue ? "checkmark" : "circle")
                    }
                }
            }
        }
    }
#endif

    static func beginTabManagerSessionRestore(
        tabManager: TabManager,
        selectedWorkspaceIndex: Int?,
        totalWorkspaceCount: Int
    ) {
#if DEBUG
        dlog(
            "session.restore.begin windowTabs=\(totalWorkspaceCount) selectedIndex=\(selectedWorkspaceIndex.map(String.init) ?? "nil") " +
            "pendingMetadataWindows=\(pendingRestoreMetadata.count)"
        )
#endif
        TermLoopDeferredWorkspaceRestore.begin(
            tabManager: tabManager,
            selectedWorkspaceIndex: selectedWorkspaceIndex,
            totalWorkspaceCount: totalWorkspaceCount
        )
    }

    static func restoreWorkspaceSessionSnapshot(
        workspace: Workspace,
        snapshot: SessionWorkspaceSnapshot,
        tabManager: TabManager
    ) {
        workspace.applyTermLoopRestoreId(snapshot.termLoopRestoreId)
#if DEBUG
        dlog(
            "session.restore.snapshot ws=\(workspace.id.uuidString) " +
            "restoreId=\(workspace.termLoopRestoreId.uuidString) " +
            "title=\(debugClean(snapshot.processTitle)) cwd=\(debugClean(snapshot.currentDirectory))"
        )
#endif
        TermLoopDeferredWorkspaceRestore.restore(
            workspace: workspace,
            snapshot: snapshot,
            tabManager: tabManager
        )
    }

    nonisolated static func shouldSkipSessionSaveDuringStartupRestore(
        isApplyingStartupSessionRestore: Bool,
        includeScrollback: Bool
    ) -> Bool {
        isApplyingStartupSessionRestore && !includeScrollback
    }

    static func sessionSnapshot(
        for workspace: Workspace,
        includeScrollback: Bool
    ) -> SessionWorkspaceSnapshot {
        TermLoopDeferredWorkspaceRestore.sessionSnapshot(
            for: workspace,
            includeScrollback: includeScrollback
        )
    }

    /// Reads the auto-restore preference. Defaults to `true` when the user
    /// has never explicitly set it. Respects an explicit `false` written by
    /// the Settings toggle.
    static func isClaudeAutoRestoreEnabled() -> Bool {
        if let value = UserDefaults.standard.object(forKey: claudeAutoRestoreDefaultsKey) as? Bool {
            return value
        }
        return true
    }

    nonisolated static func removeLegacyPersistedWindowGeometryIfPresent(
        defaults: UserDefaults,
        keys: [String]
    ) {
        for key in keys where defaults.object(forKey: key) != nil {
            defaults.removeObject(forKey: key)
        }
    }

    /// Called from `GhosttyTerminalView`'s focus-restoration entry points
    /// (`applyFirstResponderIfNeeded`, `ensureFocus`) to yield to the
    /// sidebar inline create text field while an inline name input is
    /// active. Without this guard the terminal's continuous
    /// `makeFirstResponder(surfaceView)` scheduling steals focus before
    /// the user can type a character.
    static func shouldDeferTerminalFocusSteal() -> Bool {
        SidebarInlineCreateCoordinator.shared.request != nil
    }

    nonisolated static func refreshV2KnownRefsIfNeeded(method: String, refresh: () -> Void) {
        TermLoopV2KnownRefsRefreshGate.refreshIfNeeded(method: method, refresh: refresh)
    }

    /// Writes the TermLoop sidecar snapshot next to upstream's session file.
    /// Called from `AppDelegate.persistSessionSnapshot` after the upstream
    /// session JSON is written.
    static func saveSidecarSnapshot(alongside sessionURL: URL) {
        backfillPersistedAgentSessionsIfNeeded()
        let restoreStampsByPosition = AppDelegate.shared?.termLoopWorkspaceRestoreStampsByPosition() ?? []
        let hiddenWorkspaceMetadata = hiddenWorkspaceMetadataByIdForPersistence()
#if DEBUG
        dlog(
            "session.save.sidecar begin windows=\(restoreStampsByPosition.count) hidden=\(hiddenWorkspaceMetadata.count) session=\(sessionURL.lastPathComponent)"
        )
        for (windowIndex, windowEntries) in restoreStampsByPosition.enumerated() {
            for (workspaceIndex, entry) in windowEntries.enumerated() {
                dlog(
                    "session.save.sidecar.window window=\(windowIndex) workspace=\(workspaceIndex) " +
                    "title=\(debugClean(entry.customTitle ?? entry.processTitle)) cwd=\(debugClean(entry.currentDirectory)) " +
                    debugSnapshotMetadata(entry.metadata)
                )
            }
        }
        for (rawId, metadata) in hiddenWorkspaceMetadata {
            dlog(
                "session.save.sidecar.hidden ws=\(rawId) " +
                debugSnapshotMetadata(metadata, workspaceId: UUID(uuidString: rawId))
            )
        }
#endif
        let snapshot = TermLoopSessionSnapshot(
            version: 7,
            projects: ProjectStore.shared.sessionSnapshot,
            activeProjectId: ProjectStore.shared.activeProjectId?.uuidString,
            openProjectIds: ProjectStore.shared.openProjectIds.map { $0.uuidString },
            workspaceMetadataByPosition: restoreStampsByPosition.map { $0.map(\.metadata) },
            workspaceRestoreStampsByPosition: restoreStampsByPosition,
            hiddenWorkspaceMetadataById: hiddenWorkspaceMetadata.isEmpty ? nil : hiddenWorkspaceMetadata
        )

        let url = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
        let directory = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: nil
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(snapshot)
            try data.write(to: url, options: .atomic)
#if DEBUG
            dlog(
                "session.save.sidecar wrote path=\(url.path) bytes=\(data.count) projects=\(snapshot.projects.count) " +
                "visibleWindows=\(snapshot.workspaceMetadataByPosition?.count ?? 0) hidden=\(snapshot.hiddenWorkspaceMetadataById?.count ?? 0)"
            )
#endif
            TaggedBuildSharedState.mirrorCurrentSessionArtifactsIfNeeded(currentSessionURL: sessionURL)
        } catch {
            logger.error("sidecar save failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Persistence-time metadata self-heal. Legacy workspaces can carry a nil
    /// `projectId` even though their cwd lives under a known project root.
    /// Repair that before writing the sidecar so project-scoped restore does
    /// not strand those workspaces under "no project" on the next launch.
    static func persistenceMetadata(for workspace: Workspace) -> WorkspaceMetadataStore.Metadata {
        let store = WorkspaceMetadataStore.shared
        let originalMetadata = store.metadata(for: workspace)
        let metadata = healedMetadata(
            originalMetadata,
            workspaceCurrentDirectory: workspace.currentDirectory
        )
#if DEBUG
        if originalMetadata != metadata {
            dlog(
                "session.save.heal ws=\(workspace.id.uuidString) title=\(debugClean(workspaceDisplayTitle(workspace))) " +
                "before=\(debugSnapshotMetadata(originalMetadata, workspaceId: workspace.id)) after=\(debugSnapshotMetadata(metadata, workspaceId: workspace.id))"
            )
        } else {
            dlog(
                "session.save.metadata ws=\(workspace.id.uuidString) title=\(debugClean(workspaceDisplayTitle(workspace))) " +
                debugSnapshotMetadata(metadata, workspaceId: workspace.id)
            )
        }
#endif
        guard originalMetadata != metadata else {
            return metadata
        }
        store.restoreMetadata(metadata, forWorkspaceId: workspace.id)
        if let recoveredProjectId = metadata.projectId {
            logger.info(
                "persistence project recovered ws=\(workspace.id.uuidString, privacy: .public) project=\(recoveredProjectId.uuidString, privacy: .public)"
            )
        }
        return metadata
    }

    private static func hiddenWorkspaceMetadataByIdForPersistence()
        -> [String: WorkspaceMetadataStore.Metadata] {
        Dictionary(
            uniqueKeysWithValues: WorkspaceMetadataStore.shared.hiddenWorkspaces()
                .map { pair in (pair.id.uuidString, pair.metadata) }
        )
    }

    static func prepareSharedTaggedBuildState() {
        TaggedBuildSharedState.prepareCurrentBuildState()
    }

    static func migrateSidebarWorkSubTabDefaultIfNeeded(defaults: UserDefaults = .standard) {
        // Earlier the migration wrote to the camel-case key instead of
        // `WorkSubTab.storageKey`, leaving the migration silently ineffective.
        let migrationKey = "termloop.workSubTab.loopDefaultMigration.v1"
        guard !defaults.bool(forKey: migrationKey) else { return }
        defaults.set(WorkSubTab.loop.rawValue, forKey: WorkSubTab.storageKey)
        defaults.set(true, forKey: migrationKey)
    }

    static func migrateAppearanceDarkDefaultIfNeeded(defaults: UserDefaults = .standard) {
        let migrationKey = "appearanceMode.darkDefaultMigration.v1"
        guard !defaults.bool(forKey: migrationKey) else { return }
        defaults.set(AppearanceSettings.defaultMode.rawValue, forKey: AppearanceSettings.appearanceModeKey)
        defaults.set(true, forKey: migrationKey)
    }

    static func removeMirroredSessionSnapshotIfNeeded() {
        guard let currentSessionURL = SessionPersistenceStore.defaultSnapshotFileURL() else { return }
        TaggedBuildSharedState.mirrorCurrentSessionArtifactsIfNeeded(currentSessionURL: currentSessionURL)
    }

    /// Single entry point for the upstream `handleClient` accept hook.
    /// Stamps the per-thread current-fd marker (used by socket commands to
    /// recover the originating client) and registers the fd with
    /// `TermLoopSocketIO` so writeFrame has a live FDState to grab.
    /// Nonisolated because `handleClient` runs on a detached accept thread.
    nonisolated static func handleAcceptedClient(socket fd: Int32) {
        TermLoopTCPBridge.setCurrentSocketFd(fd)
        TermLoopSocketIO.beginConnection(fd)
    }

    /// Single entry point for the upstream `handleClient` defer. Tears down
    /// the connection's subscriptions and IO bookkeeping before the upstream
    /// `defer { close(socket) }` actually closes the descriptor — defer
    /// ordering is LIFO, so this runs first. Nonisolated for the same reason
    /// as `handleAcceptedClient(socket:)`.
    nonisolated static func handleClientDisconnect(socket fd: Int32) {
        TermLoopMobileSurfaceStreamStore.shared.disposeConnection(for: fd)
        TermLoopSubscriptionTracker.shared.disposeConnection(for: fd)
    }

    /// Flushes critical relaunch metadata immediately instead of waiting for
    /// autosave/quit-time snapshot persistence. Used when an agent session id
    /// changes so restart-resume state cannot be lost to a crash in the gap.
    static func saveCriticalAgentRestoreStateSync() {
        if let appDelegate = AppDelegate.shared {
            _ = appDelegate.saveSessionSnapshot(includeScrollback: false, forceSync: true)
            return
        }
        guard let sessionURL = SessionPersistenceStore.defaultSnapshotFileURL() else { return }
        saveSidecarSnapshot(alongside: sessionURL)
    }

    /// Codex session-start hooks can arrive slightly after the shell command
    /// has already launched, and in some cases may be skipped entirely by the
    /// CLI. Claude can also miss capture when a workspace still carries stale
    /// per-project hook config. Schedule a couple of short delayed backfills so
    /// the session file on disk can still populate `persistedAgentSession`
    /// before the next quit.
    static func schedulePersistedAgentSessionRecoveryIfNeeded(agentId: String?) {
        let normalized = agentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized == TerminalAgent.claudeId || normalized == "codex" else { return }
        for delay in persistedAgentRecoveryDelays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                let didRecover = backfillPersistedAgentSessionsIfNeeded()
                if didRecover {
                    saveCriticalAgentRestoreStateSync()
                }
            }
        }
    }

    /// Startup self-heal for workspaces that already have an agent binding but
    /// somehow missed their original session capture. Also strips any TermLoop
    /// entries that older versions wrote into per-workspace hook files, so those
    /// worktrees cannot keep running with stale hook config.
    static func scheduleStartupAgentRestoreSelfHeal(workspaces: [Workspace]) {
        var shouldScheduleRecovery = false
        let metadataStore = WorkspaceMetadataStore.shared

        for workspace in workspaces {
            let metadata = metadataStore.metadata(forWorkspaceId: workspace.id)
            let agentId = metadata.persistedAgentSession?.agentId ?? metadata.terminalAgentId
            guard let agentId = agentId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  HookManagedAgent(rawValue: agentId) != nil else {
                continue
            }
            let cwd = (try? workspace.termLoopSpawnCwd()) ?? {
                let raw = workspace.currentDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
                return raw.isEmpty ? nil : raw
            }()
            if let cwd, !cwd.isEmpty {
                UserScopeHookSync.cleanupProjectScopeAllAgents(
                    at: URL(fileURLWithPath: cwd, isDirectory: true)
                )
            }
            if metadata.persistedAgentSession == nil {
                shouldScheduleRecovery = true
            }
        }

        guard shouldScheduleRecovery else { return }
        for delay in persistedAgentRecoveryDelays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                let didRecover = backfillPersistedAgentSessionsIfNeeded()
                if didRecover {
                    saveCriticalAgentRestoreStateSync()
                }
            }
        }
    }

    @discardableResult
    private static func backfillPersistedAgentSessionsIfNeeded(
        now: Date = Date(),
        claudeScanner: ClaudeSessionScanner = .shared,
        codexScanner: CodexSessionScanner = .shared
    ) -> Bool {
        guard let workspaces = AppDelegate.shared?.termLoopOpenWorkspacesInPersistenceOrder(),
              !workspaces.isEmpty else { return false }

        let metadataStore = WorkspaceMetadataStore.shared
        var usedSessionIds = Set(
            workspaces.compactMap { metadataStore.persistedAgentSession(for: $0.id)?.sessionId }
        )
        var didRecover = false

        let candidates = workspaces.compactMap { workspace -> BackfillCandidate? in
            guard metadataStore.persistedAgentSession(for: workspace.id) == nil else { return nil }
            let activity = TerminalAgentActivityStore.shared.state(forWorkspaceId: workspace.id)
            let agentId = activity?.agentId
                ?? metadataStore.terminalAgentId(for: workspace.id)
            guard let agentId, agentId == TerminalAgent.claudeId || agentId == "codex" else {
                return nil
            }
            let cwd = (activity?.cwd?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? activity?.cwd
                : nil)
                ?? (try? workspace.termLoopSpawnCwd())
                ?? {
                    let current = workspace.currentDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
                    return current.isEmpty ? nil : current
                }()
            guard let cwd, !cwd.isEmpty else { return nil }
            return BackfillCandidate(
                workspaceId: workspace.id,
                agentId: agentId,
                cwd: cwd,
                startedAt: activity?.startedAt,
                workspaceTitle: normalizedBackfillTitle(workspaceDisplayTitle(workspace)),
                lastMessagePreview: metadataStore.metadata(forWorkspaceId: workspace.id).lastMessagePreview
            )
        }

        let grouped = Dictionary(grouping: candidates) { "\($0.agentId)|\($0.cwd)" }
        let cutoff = now.addingTimeInterval(-persistedAgentFallbackRecency)
        for (_, group) in grouped {
            guard let first = group.first else { continue }
            let sortedCandidates = group.sorted { lhs, rhs in
                switch (lhs.startedAt, rhs.startedAt) {
                case let (l?, r?) where l != r:
                    return l > r
                case (_?, nil):
                    return true
                case (nil, _?):
                    return false
                default:
                    return lhs.workspaceId.uuidString < rhs.workspaceId.uuidString
                }
            }

            let sessions = persistedSessionsForBackfill(
                agentId: first.agentId,
                cwd: first.cwd,
                cutoff: cutoff,
                claudeScanner: claudeScanner,
                codexScanner: codexScanner
            )

            for candidate in sortedCandidates {
                guard let session = bestBackfillSession(
                    for: candidate,
                    sessions: sessions,
                    usedSessionIds: usedSessionIds,
                    candidateCountInGroup: group.count
                ) else { continue }
                if metadataStore.setPersistedAgentSession(session.session, for: candidate.workspaceId) {
                    usedSessionIds.insert(session.session.sessionId)
                    didRecover = true
                }
            }
        }

        return didRecover
    }

    static func persistedAgentSessionsForBackfill(
        agentId: String,
        cwd: String,
        cutoff: Date,
        claudeScanner: ClaudeSessionScanner = .shared,
        codexScanner: CodexSessionScanner = .shared
    ) -> [PersistedAgentSession] {
        persistedSessionsForBackfill(
            agentId: agentId,
            cwd: cwd,
            cutoff: cutoff,
            claudeScanner: claudeScanner,
            codexScanner: codexScanner
        ).map(\.session)
    }

    private static func persistedSessionsForBackfill(
        agentId: String,
        cwd: String,
        cutoff: Date,
        claudeScanner: ClaudeSessionScanner = .shared,
        codexScanner: CodexSessionScanner = .shared
    ) -> [BackfillSessionCandidate] {
        func claudeSessions(newerThan cutoff: Date?) -> [BackfillSessionCandidate] {
            claudeScanner.scan(cwd: cwd, newerThan: cutoff)
                .map {
                    BackfillSessionCandidate(
                        session: PersistedAgentSession(
                            agentId: TerminalAgent.claudeId,
                            sessionId: $0.sessionId,
                            cwd: $0.cwd,
                            updatedAt: $0.mtime
                        ),
                        title: $0.title,
                        assistantPreview: $0.lastAssistantSnippet,
                        userPreview: $0.lastUserSnippet
                    )
                }
        }

        func codexSessions(newerThan cutoff: Date?) -> [BackfillSessionCandidate] {
            let sessions: [CodexSessionMetadata]
            if let cutoff {
                if cutoff <= Date(timeIntervalSince1970: 1) {
                    // Reconciliation can intentionally ask for the full cwd
                    // history. Use the scanner's indexed path for that case;
                    // the uncached recent path is only for fresh-launch
                    // recovery and would re-walk ~/.codex/sessions per
                    // workspace on startup.
                    sessions = codexScanner.scan(cwd: cwd)
                } else {
                    sessions = codexScanner.scanRecentUncached(cwd: cwd, newerThan: cutoff)
                }
            } else {
                sessions = codexScanner.scan(cwd: cwd)
            }
            return sessions
                .map {
                    BackfillSessionCandidate(
                        session: PersistedAgentSession(
                            agentId: "codex",
                            sessionId: $0.sessionId,
                            cwd: $0.cwd,
                            updatedAt: $0.mtime
                        ),
                        title: $0.title,
                        assistantPreview: nil,
                        userPreview: nil
                    )
                }
        }

        switch agentId {
        case TerminalAgent.claudeId:
            return claudeSessions(newerThan: cutoff)
        case "codex":
            let recent = codexSessions(newerThan: cutoff)
            // Do not fall back to a full historical ~/.codex scan here. On
            // large installs that reads gigabytes of JSONL at app startup and
            // can pin CPU. Missing older sessions remain visible as workspaces;
            // they just are not auto-bound by the safety backfill.
            return recent
        default:
            return []
        }
    }

    static func bestBackfillSession(
        for candidate: BackfillCandidate,
        sessions: [BackfillSessionCandidate],
        usedSessionIds: Set<String>,
        candidateCountInGroup: Int
    ) -> BackfillSessionCandidate? {
        let ranked = sessions
            .filter { !usedSessionIds.contains($0.session.sessionId) }
            .map { session in
                (
                    session: session,
                    score: backfillScore(candidate: candidate, session: session)
                )
            }
            .sorted { lhs, rhs in
                if lhs.score != rhs.score {
                    return lhs.score > rhs.score
                }
                let lhsUpdatedAt = lhs.session.session.updatedAt ?? .distantPast
                let rhsUpdatedAt = rhs.session.session.updatedAt ?? .distantPast
                if lhsUpdatedAt != rhsUpdatedAt {
                    return lhsUpdatedAt > rhsUpdatedAt
                }
                return lhs.session.session.sessionId < rhs.session.session.sessionId
            }

        guard let best = ranked.first else { return nil }
        if candidate.workspaceTitle != nil,
           sessions.count > 1,
           best.score < minimumDistinctBackfillScore {
            return nil
        }
        if candidateCountInGroup > 1 {
            if best.score < minimumDistinctBackfillScore {
                return nil
            }
            if ranked.dropFirst().first?.score == best.score {
                return nil
            }
        }
        return best.session
    }

    private static func backfillScore(
        candidate: BackfillCandidate,
        session: BackfillSessionCandidate
    ) -> Int {
        var score = max(
            titleSimilarityScore(
                workspaceTitle: candidate.workspaceTitle,
                sessionTitle: session.title
            ),
            previewSimilarityScore(
                workspacePreview: candidate.lastMessagePreview,
                session: session
            )
        )
        if let startedAt = candidate.startedAt,
           let updatedAt = session.session.updatedAt {
            let ageMinutes = abs(updatedAt.timeIntervalSince(startedAt)) / 60
            score += max(0, 180 - Int(ageMinutes))
        }
        return score
    }

    private static func workspaceDisplayTitle(_ workspace: Workspace) -> String? {
        let custom = workspace.customTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let raw = custom.isEmpty ? workspace.title : custom
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func normalizedBackfillTitle(_ title: String?) -> String? {
        guard let title else { return nil }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let withoutAgentSuffix = trimmed.replacingOccurrences(
            of: #"\s+\((claude|codex|gemini)(\s+cli)?\)$"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        guard let normalized = normalizedBackfillText(withoutAgentSuffix) else {
            return nil
        }
        if normalized == "terminal" || normalized == "workspace" {
            return nil
        }
        if normalized.hasPrefix("terminal "),
           Int(normalized.split(separator: " ").last ?? "") != nil {
            return nil
        }
        return normalized
    }

    private static func normalizedBackfillText(_ text: String?) -> String? {
        guard let text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let folded = trimmed.folding(
            options: [.caseInsensitive, .diacriticInsensitive],
            locale: Locale.current
        )
        let tokens = folded
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
        guard !tokens.isEmpty else { return nil }
        return tokens.joined(separator: " ")
    }

    private static func titleSimilarityScore(
        workspaceTitle: String?,
        sessionTitle: String?
    ) -> Int {
        similarityScore(
            lhs: workspaceTitle,
            rhs: normalizedBackfillTitle(sessionTitle)
        )
    }

    private static func previewSimilarityScore(
        workspacePreview: String?,
        session: BackfillSessionCandidate
    ) -> Int {
        let normalizedWorkspacePreview = normalizedBackfillText(workspacePreview)
        return [
            normalizedBackfillText(session.assistantPreview),
            normalizedBackfillText(session.userPreview)
        ]
        .compactMap { $0 }
        .map { similarityScore(lhs: normalizedWorkspacePreview, rhs: $0) }
        .max() ?? 0
    }

    private static func similarityScore(lhs: String?, rhs: String?) -> Int {
        guard let lhs, let rhs else {
            return 0
        }
        if lhs == rhs {
            return 1_000
        }
        if rhs.contains(lhs) || lhs.contains(rhs) {
            return 800 + min(lhs.count, rhs.count)
        }

        let workspaceTokens = Set(lhs.split(separator: " ").map(String.init))
        let sessionTokens = Set(rhs.split(separator: " ").map(String.init))
        let overlap = workspaceTokens.intersection(sessionTokens).count
        guard overlap > 0 else { return 0 }
        return overlap * 80 + commonPrefixLength(lhs, rhs)
    }

    private static func commonPrefixLength(_ lhs: String, _ rhs: String) -> Int {
        zip(lhs, rhs).prefix { $0 == $1 }.count
    }

    /// Loads the TermLoop sidecar snapshot (if present) and rehydrates the
    /// stores. Called from `AppDelegate.prepareStartupSessionSnapshotIfNeeded`
    /// after upstream's session load. Wires up `onMutation` so subsequent
    /// CRUD on the stores fires a session save. If no sidecar exists, falls
    /// back to bootstrapping the Default project so legacy installs / fresh
    /// launches still have a valid catalog.
    static func loadSidecarSnapshot(alongside sessionURL: URL, onStoreMutation: @escaping () -> Void) {
        ProjectStore.shared.onMutation = onStoreMutation
        AgentEngine.shared.bootstrap(builtinBundleDir: BuiltinTemplates.bundleDir)

        let url = TermLoopSessionSnapshot.sidecarURL(for: sessionURL)
        guard FileManager.default.fileExists(atPath: url.path) else {
            // First launch after Plan A ships: no sidecar yet, bootstrap a
            // Default project so every workspace has a valid owner.
            _ = ProjectStore.shared.bootstrap(from: nil)
            return
        }
        do {
            let data = try Data(contentsOf: url)
            let snapshot = try JSONDecoder().decode(TermLoopSessionSnapshot.self, from: data)
            ProjectStore.shared.restoreFromSidecar(
                projects: snapshot.projects,
                activeProjectId: snapshot.activeProjectId.flatMap(UUID.init(uuidString:)),
                openProjectIds: snapshot.openProjectIds.compactMap(UUID.init(uuidString:))
            )

            if let restoreStamps = snapshot.workspaceRestoreStampsByPosition {
                pendingRestoreMetadata = restoreStamps.map {
                    $0.map {
                        PendingRestoreWorkspaceMetadata(
                            metadata: $0.metadata,
                            processTitle: $0.processTitle,
                            customTitle: $0.customTitle,
                            currentDirectory: $0.currentDirectory,
                            termLoopRestoreId: $0.termLoopRestoreId
                        )
                    }
                }
            } else {
                pendingRestoreMetadata = (snapshot.workspaceMetadataByPosition ?? []).map {
                    $0.map {
                        PendingRestoreWorkspaceMetadata(
                            metadata: $0,
                            processTitle: nil,
                            customTitle: nil,
                            currentDirectory: nil,
                            termLoopRestoreId: nil
                        )
                    }
                }
            }
            restoreHiddenWorkspaceMetadata(snapshot.hiddenWorkspaceMetadataById)
        } catch {
            logger.error("sidecar load failed: \(String(describing: error), privacy: .public)")
            _ = ProjectStore.shared.bootstrap(from: nil)
        }
        performWorktreeBootstrapCleanup()
        // First launch on v4 backfills terminalAgentId for every legacy
        // workspace; idempotent on subsequent launches.
        let migrated = WorkspaceAgentMigration.runIfNeeded()
        if !migrated.isEmpty {
            pendingMigrationToastWorkspaceIds.formUnion(migrated)
        }
    }

    private static func restoreHiddenWorkspaceMetadata(
        _ hiddenMetadataById: [String: WorkspaceMetadataStore.Metadata]?
    ) {
        guard let hiddenMetadataById, !hiddenMetadataById.isEmpty else { return }
        for (rawId, rawMetadata) in hiddenMetadataById {
            guard let workspaceId = UUID(uuidString: rawId) else { continue }
            var metadata = healedMetadata(
                rawMetadata,
                workspaceCurrentDirectory: nil,
                stampedCurrentDirectory: nil
            )
            metadata.isHidden = true
#if DEBUG
            dlog(
                "session.restore.hidden ws=\(workspaceId.uuidString) " +
                debugSnapshotMetadata(metadata, workspaceId: workspaceId)
            )
#endif
            WorkspaceMetadataStore.shared.restoreMetadata(metadata, forWorkspaceId: workspaceId)
        }
    }

    /// Consumes (and clears) the migration toast flag for a workspace. Phase
    /// A just returns the flag; Phase C will surface the banner.
    static func consumeMigrationToast(workspaceId: UUID) -> Bool {
        if pendingMigrationToastWorkspaceIds.contains(workspaceId) {
            pendingMigrationToastWorkspaceIds.remove(workspaceId)
            return true
        }
        return false
    }

    /// Legacy pane-close interception hook kept for test/source compatibility.
    /// TermLoop no longer blocks pane closes at this layer, so the answer is
    /// always "do not intercept".
    static func interceptUserClose(paneId: UUID) -> Bool {
        false
    }

    /// Runs `git worktree prune` for every project folder in the background,
    /// then lists the surviving worktrees and reconciles persisted worktree
    /// paths for every workspace. Reconcile is deliberately non-destructive:
    /// missing/drifted paths are preserved as product state so the UI can show
    /// a repair surface instead of silently dropping tickets, baselines, or
    /// agent sessions.
    ///
    /// The reconcile step is delayed so windows have a chance to finish
    /// restoring (`didRestoreWorkspaces` re-applies persisted branches on
    /// every window restore; if we cleared first the restore would re-add
    /// the stale branches right back).
    static func performWorktreeBootstrapCleanup() {
        let projectSnapshots = ProjectStore.shared.projects.map {
            ($0.id, $0.folderPath)
        }
        guard !projectSnapshots.isEmpty else { return }

        DispatchQueue.global(qos: .utility).async {
            var worktreesByProject: [UUID: [GitWorktreeService.ListEntry]] = [:]
            let backgroundLogger = Logger(subsystem: "com.termloop.fork", category: "hooks")
            let lock = NSLock()
            DispatchQueue.concurrentPerform(iterations: projectSnapshots.count) { idx in
                let (projectId, folder) = projectSnapshots[idx]
                let service = GitWorktreeService()
                try? service.prune(folder: folder)
                do {
                    let listed = try service.list(in: folder)
                    WorktreeRegistry.shared.record(projectFolder: folder, entries: listed)
                    lock.lock()
                    worktreesByProject[projectId] = listed
                    lock.unlock()
                } catch {
                    // Git failure is not an empty worktree list. Skip this
                    // project so transient repo/disk issues cannot destroy
                    // TermLoop-owned metadata.
                    backgroundLogger.info(
                        "worktree reconcile: skipping project \(projectId.uuidString, privacy: .public) after git list failure \(String(describing: error), privacy: .public)"
                    )
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                reconcileWorktreeMetadata(worktreesByProject: worktreesByProject)
            }
        }
    }

    /// Reconciles persisted worktree paths against Git's registered worktree
    /// list. This is intentionally non-destructive: missing, drifted, locked,
    /// and prunable worktrees keep TermLoop product state intact so the UI can
    /// surface a repair affordance instead of silently losing tickets,
    /// baselines, or persisted agent sessions.
    ///
    /// The optional `bindings` parameter is for callers/tests that captured a
    /// branch-binding snapshot before doing async Git work; `setWorktreePath`
    /// uses the captured generation as a compare-and-swap so a stale snapshot
    /// cannot overwrite a fresh attach. Normal startup callers leave it nil
    /// and reconcile the current metadata snapshot inline.
    static func reconcileWorktreeMetadata(
        worktreesByProject: [UUID: [GitWorktreeService.ListEntry]],
        bindings: [WorkspaceMetadataStore.WorktreeBranchBinding]? = nil
    ) {
        for binding in bindings ?? WorkspaceMetadataStore.shared.branchBindings() {
            guard let projectId = binding.projectId,
                  let entries = worktreesByProject[projectId] else { continue }
            let status = WorktreeReconciler.status(
                for: WorktreeReconciler.Binding(
                    expectedBranch: binding.branch,
                    worktreePath: binding.worktreePath
                ),
                entries: entries
            )
            let currentPath: String? = {
                let trimmed = binding.worktreePath?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            }()
            let normalizedCurrentPath = currentPath.map {
                URL(fileURLWithPath: $0).standardizedFileURL.path
            }

            switch status.kind {
            case .healthy, .locked:
                guard let actualPath = status.path else { continue }
                if normalizedCurrentPath != actualPath {
                    WorkspaceMetadataStore.shared.copyWorktreeScopedStateIfNeeded(
                        fromPath: normalizedCurrentPath,
                        toPath: actualPath,
                        forWorkspaceId: binding.workspaceId
                    )
                    let didRepair = WorkspaceMetadataStore.shared.setWorktreePath(
                        actualPath,
                        forWorkspaceId: binding.workspaceId,
                        expectedGeneration: binding.generation
                    )
                    if didRepair {
                        logger.info(
                            "worktree reconcile: repaired path for branch \(binding.branch, privacy: .public) on workspace \(binding.workspaceId.uuidString, privacy: .public) path=\(actualPath, privacy: .public)"
                        )
                    } else {
                        logger.info(
                            "worktree reconcile: skipped stale path repair for branch \(binding.branch, privacy: .public) on workspace \(binding.workspaceId.uuidString, privacy: .public)"
                        )
                    }
                }
            case .branchDrift, .prunable, .missingRegistration, .missingPath, .unknown:
                logger.info(
                    "worktree reconcile: preserving branch \(binding.branch, privacy: .public) on workspace \(binding.workspaceId.uuidString, privacy: .public) status=\(status.kind.rawValue, privacy: .public) path=\(status.path ?? currentPath ?? "nil", privacy: .public)"
                )
            case .unattached:
                continue
            }
        }
    }

    static func didRestoreWorkspaces(workspaces: [Workspace]) {
        let windowMetadata = pendingRestoreMetadata.isEmpty ? [] : pendingRestoreMetadata.removeFirst()
        let autoRestore = isClaudeAutoRestoreEnabled()
#if DEBUG
        dlog(
            "session.restore.didRestoreWorkspaces workspaces=\(workspaces.count) metadataEntries=\(windowMetadata.count) " +
            "autoRestoreClaude=\(autoRestore ? 1 : 0)"
        )
#endif
        let metadataByWorkspaceId = resolvedRestoreMetadata(
            entries: windowMetadata,
            workspaces: workspaces
        )

        for workspace in workspaces {
            let pendingMetadata = metadataByWorkspaceId[workspace.id]
            let rawMetadata = pendingMetadata?.metadata ?? WorkspaceMetadataStore.Metadata()
            var metadata = healedMetadata(
                rawMetadata,
                workspaceCurrentDirectory: workspace.currentDirectory,
                stampedCurrentDirectory: pendingMetadata?.currentDirectory
            )
            metadata = reconciledPersistedAgentSession(
                metadata,
                workspace: workspace,
                stampedCurrentDirectory: pendingMetadata?.currentDirectory
            )
            WorkspaceMetadataStore.shared.restoreMetadata(metadata, forWorkspaceId: workspace.id)
#if DEBUG
            dlog(
                "session.restore.metadata ws=\(workspace.id.uuidString) title=\(debugClean(workspaceDisplayTitle(workspace))) " +
                "workspaceCwd=\(debugClean(workspace.currentDirectory)) stampedCwd=\(debugClean(pendingMetadata?.currentDirectory)) " +
                "source=\(pendingMetadata == nil ? "empty" : "sidecar") \(debugMetadata(metadata))"
            )
#endif
        }
        restoreMissingWorktreeBranchBindings(workspaces: workspaces)

        let didRecoverBeforeRestore = backfillPersistedAgentSessionsIfNeeded()
#if DEBUG
        if didRecoverBeforeRestore {
            dlog("session.restore.backfill-before-agent-restore recovered=1")
        }
#endif

        // Deferred workspaces do not have their terminal panels yet. Launching
        // restore commands before those panels exist races the dispatch retry
        // window and can permanently miss auto-restore. They are restored when
        // the user selects the workspace, or by the serial background drain
        // below once launch has settled.
        let materializedWorkspaces = workspaces.filter {
            !TermLoopDeferredWorkspaceRestore.isDeferred(workspace: $0)
        }
#if DEBUG
        dlog(
            "session.restore.materialized count=\(materializedWorkspaces.count) deferred=\(workspaces.count - materializedWorkspaces.count)"
        )
#endif
        TerminalAgentLifecycle.restoreWorkspaces(materializedWorkspaces, autoRestoreClaude: autoRestore)
        // Ability-agent sessions don't survive relaunch; see
        // `TabManager+TermLoopPrune.swift` for the guard-bypass rationale.
        if let tabManager = workspaces.first?.owningTabManager {
            tabManager.pruneAbilityAgentWorkspaces()
        }
        TermLoopDeferredWorkspaceRestore.scheduleBackgroundMaterialization(for: workspaces)
        scheduleStartupAgentRestoreSelfHeal(workspaces: workspaces)
    }

    private static func resolvedRestoreMetadata(
        entries: [PendingRestoreWorkspaceMetadata],
        workspaces: [Workspace]
    ) -> [UUID: PendingRestoreWorkspaceMetadata] {
        guard !entries.isEmpty, !workspaces.isEmpty else { return [:] }

#if DEBUG
        dlog(
            "session.restore.resolve entries=\(entries.count) workspaces=\(workspaces.count)"
        )
        for (index, entry) in entries.enumerated() {
            dlog("session.restore.resolve.entry index=\(index) \(debugRestoreEntry(entry))")
        }
        for workspace in workspaces {
            dlog(
                "session.restore.resolve.workspace ws=\(workspace.id.uuidString) " +
                "title=\(debugClean(workspaceDisplayTitle(workspace))) cwd=\(debugClean(workspace.currentDirectory))"
            )
        }
#endif

        var resolved: [UUID: PendingRestoreWorkspaceMetadata] = [:]
        var usedEntryIndices = Set<Int>()

        func assign(_ entryIndex: Int, to workspace: Workspace, stage: String) {
            usedEntryIndices.insert(entryIndex)
            resolved[workspace.id] = entries[entryIndex]
#if DEBUG
            debugRestoreAssignment(
                stage: stage,
                entryIndex: entryIndex,
                workspace: workspace,
                entry: entries[entryIndex]
            )
#endif
        }

        let unassignedWorkspaceIds = { workspaces.filter { resolved[$0.id] == nil } }

        var entryIndexByRestoreId: [UUID: Int] = [:]
        var ambiguousRestoreIds = Set<UUID>()
        for (index, entry) in entries.enumerated() {
            guard let restoreId = entry.termLoopRestoreId,
                  !usedEntryIndices.contains(index),
                  !ambiguousRestoreIds.contains(restoreId) else { continue }
            if entryIndexByRestoreId[restoreId] != nil {
                entryIndexByRestoreId.removeValue(forKey: restoreId)
                ambiguousRestoreIds.insert(restoreId)
            } else {
                entryIndexByRestoreId[restoreId] = index
            }
        }

        for workspace in workspaces {
            if let index = entryIndexByRestoreId[workspace.termLoopRestoreId] {
                assign(index, to: workspace, stage: "restoreId")
            }
        }

        for workspace in workspaces {
            guard let workspaceTitle = normalizedBackfillTitle(workspaceDisplayTitle(workspace)),
                  let workspaceCwd = normalizedRestoreCwd(workspace.currentDirectory) else {
                continue
            }
            let matches = entries.enumerated().filter { index, entry in
                !usedEntryIndices.contains(index)
                    && normalizedRestoreTitle(entry) == workspaceTitle
                    && normalizedRestoreCwd(entry.currentDirectory) == workspaceCwd
            }
            if matches.count == 1, let match = matches.first {
                assign(match.offset, to: workspace, stage: "title+cwd")
            }
        }

        for workspace in unassignedWorkspaceIds() {
            guard let workspaceCwd = normalizedRestoreCwd(workspace.currentDirectory) else { continue }
            let matches = entries.enumerated().filter { index, entry in
                !usedEntryIndices.contains(index)
                    && normalizedRestoreCwd(entry.currentDirectory) == workspaceCwd
            }
            if matches.count == 1, let match = matches.first {
                assign(match.offset, to: workspace, stage: "cwd")
            }
        }

        for workspace in unassignedWorkspaceIds() {
            guard let workspaceTitle = normalizedBackfillTitle(workspaceDisplayTitle(workspace)) else { continue }
            let matches = entries.enumerated().filter { index, entry in
                !usedEntryIndices.contains(index)
                    && normalizedRestoreTitle(entry) == workspaceTitle
            }
            if matches.count == 1, let match = matches.first {
                assign(match.offset, to: workspace, stage: "title")
            }
        }

        for (index, workspace) in workspaces.enumerated() {
            guard resolved[workspace.id] == nil,
                  index < entries.count,
                  !usedEntryIndices.contains(index) else {
                continue
            }
            assign(index, to: workspace, stage: "position")
        }

        for workspace in workspaces where resolved[workspace.id] == nil {
            guard let entryIndex = entries.indices.first(where: { !usedEntryIndices.contains($0) }) else {
                break
            }
            assign(entryIndex, to: workspace, stage: "leftover")
        }

        return resolved
    }

    private static func healedMetadata(
        _ metadata: WorkspaceMetadataStore.Metadata,
        workspaceCurrentDirectory: String?,
        stampedCurrentDirectory: String? = nil
    ) -> WorkspaceMetadataStore.Metadata {
        var healed = metadata
        healed.projectId = recoveredProjectId(
            currentProjectId: metadata.projectId,
            stampedCurrentDirectory: stampedCurrentDirectory,
            workspaceCurrentDirectory: workspaceCurrentDirectory,
            persistedDirectory: metadata.persistedAgentSession?.cwd
        )
        healed.worktreePath = recoveredWorktreePath(
            currentWorktreePath: metadata.worktreePath,
            branchName: metadata.branch,
            projectId: healed.projectId,
            stampedCurrentDirectory: stampedCurrentDirectory,
            workspaceCurrentDirectory: workspaceCurrentDirectory,
            persistedDirectory: metadata.persistedAgentSession?.cwd
        )
        return healed
    }

    private static func recoveredProjectId(
        currentProjectId: UUID?,
        stampedCurrentDirectory: String?,
        workspaceCurrentDirectory: String?,
        persistedDirectory: String?
    ) -> UUID? {
        if let currentProjectId,
           ProjectStore.shared.project(id: currentProjectId) != nil {
            return currentProjectId
        }

        let candidates = [persistedDirectory, stampedCurrentDirectory, workspaceCurrentDirectory]
            .compactMap { raw -> String? in
                let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            }

        for candidate in candidates {
            if let project = ProjectStore.shared.project(containingPath: candidate) {
                return project.id
            }
        }
        return currentProjectId
    }

    private static func recoveredWorktreePath(
        currentWorktreePath: String?,
        branchName: String?,
        projectId: UUID?,
        stampedCurrentDirectory: String?,
        workspaceCurrentDirectory: String?,
        persistedDirectory: String?
    ) -> String? {
        let branch = branchName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedBranch = (branch?.isEmpty ?? true) ? nil : branch
        let current = (currentWorktreePath ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !current.isEmpty {
            guard let normalizedBranch else { return nil }
            let normalizedCurrent = URL(fileURLWithPath: current).standardizedFileURL.path
            if let projectId,
               let project = ProjectStore.shared.project(id: projectId) {
                let projectRoot = URL(fileURLWithPath: project.folderPath)
                    .standardizedFileURL
                    .path
                if normalizedCurrent == projectRoot,
                   !projectRootCheckout(projectRoot, matchesBranch: normalizedBranch) {
                    return nil
                }
            }
            return normalizedCurrent
        }
        guard let projectId,
              let project = ProjectStore.shared.project(id: projectId) else {
            return nil
        }

        let projectRoot = URL(fileURLWithPath: project.folderPath)
            .standardizedFileURL
            .path
        let candidates = [persistedDirectory, stampedCurrentDirectory, workspaceCurrentDirectory]
            .compactMap { raw -> String? in
                let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : URL(fileURLWithPath: trimmed).standardizedFileURL.path
            }

        for candidate in candidates {
            if candidate == projectRoot {
                guard let normalizedBranch,
                      projectRootCheckout(projectRoot, matchesBranch: normalizedBranch) else {
                    continue
                }
                return projectRoot
            }
            if let worktreeRoot = WorktreeResolver.worktreeRoot(
                containing: candidate,
                projectFolder: projectRoot
            ) {
                return worktreeRoot
            }
        }
        return nil
    }

    private static func projectRootCheckout(_ projectRoot: String, matchesBranch branch: String) -> Bool {
        TermLoopWorktreeHeadReader.currentBranchWithoutGit(
            checkoutPath: projectRoot
        ) == branch
    }

    private static func normalizedRestoreTitle(_ entry: PendingRestoreWorkspaceMetadata) -> String? {
        normalizedBackfillTitle(entry.customTitle ?? entry.processTitle)
    }

    private static func normalizedRestoreCwd(_ cwd: String?) -> String? {
        let trimmed = (cwd ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func reconciledPersistedAgentSession(
        _ metadata: WorkspaceMetadataStore.Metadata,
        workspace: Workspace,
        stampedCurrentDirectory: String?
    ) -> WorkspaceMetadataStore.Metadata {
        guard let persisted = metadata.persistedAgentSession,
              persisted.agentId == TerminalAgent.claudeId || persisted.agentId == "codex",
              let workspaceTitle = normalizedBackfillTitle(workspaceDisplayTitle(workspace)) else {
            return metadata
        }

        let cwd = [
            persisted.cwd,
            stampedCurrentDirectory,
            workspace.currentDirectory
        ]
            .compactMap { raw -> String? in
                let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            }
            .first
        guard let cwd else { return metadata }

        let currentTitle = persistedSessionTitle(
            agentId: persisted.agentId,
            sessionId: persisted.sessionId,
            cwd: cwd
        )
        let currentScore = titleSimilarityScore(
            workspaceTitle: workspaceTitle,
            sessionTitle: currentTitle
        )
        let minimumAcceptableScore = minimumDistinctBackfillScore
        if currentScore >= minimumAcceptableScore {
            return metadata
        }

        let candidates = persistedSessionsForBackfill(
            agentId: persisted.agentId,
            cwd: cwd,
            cutoff: .distantPast
        )
        let candidate = BackfillCandidate(
            workspaceId: workspace.id,
            agentId: persisted.agentId,
            cwd: cwd,
            startedAt: metadata.agentSpawnedAt,
            workspaceTitle: workspaceTitle,
            lastMessagePreview: metadata.lastMessagePreview
        )
        if let replacement = bestBackfillSession(
            for: candidate,
            sessions: candidates,
            usedSessionIds: [],
            candidateCountInGroup: 1
        ) {
            let replacementScore = backfillScore(candidate: candidate, session: replacement)
            if replacementScore > currentScore,
               replacementScore >= minimumAcceptableScore {
                var healed = metadata
                healed.persistedAgentSession = replacement.session
#if DEBUG
                dlog(
                    "session.restore.reconcile-persisted ws=\(workspace.id.uuidString) title=\(debugClean(workspaceDisplayTitle(workspace))) " +
                    "agent=\(persisted.agentId) oldSid=\(persisted.sessionId) oldTitle=\(debugClean(currentTitle)) oldScore=\(currentScore) " +
                    "newSid=\(replacement.session.sessionId) newTitle=\(debugClean(replacement.title)) newScore=\(replacementScore)"
                )
#endif
                return healed
            }
        }

        // Do not drop the persisted id solely because the title does not
        // match: users can rename workspace titles after a conversation starts.
        // Only rewrite when a strictly better high-confidence transcript was
        // found above.
#if DEBUG
        dlog(
            "session.restore.keep-mismatched-persisted ws=\(workspace.id.uuidString) title=\(debugClean(workspaceDisplayTitle(workspace))) " +
            "agent=\(persisted.agentId) sid=\(persisted.sessionId) sessionTitle=\(debugClean(currentTitle)) score=\(currentScore)"
        )
#endif
        return metadata
    }

    private static func persistedSessionTitle(
        agentId: String,
        sessionId: String,
        cwd: String
    ) -> String? {
        switch agentId {
        case TerminalAgent.claudeId:
            return ClaudeSessionScanner.shared.metadata(sessionId: sessionId, cwd: cwd)?.title
        case "codex":
            return CodexSessionScanner.shared.metadata(sessionId: sessionId, cwd: cwd)?.title
        default:
            return nil
        }
    }

    /// Defensive restore-time reconciliation for worktree-bound workspaces.
    /// If positional metadata came back without `branch`, infer it from the
    /// workspace cwd by matching against `git worktree list` paths.
    private static func restoreMissingWorktreeBranchBindings(workspaces: [Workspace]) {
        struct Candidate {
            let workspaceId: UUID
            let projectId: UUID
            let cwd: String
        }

        let service = GitWorktreeService()
        let candidatesByProject: [UUID: [Candidate]] = Dictionary(grouping: workspaces.compactMap { workspace in
            let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspace.id)
            let normalizedBranch = metadata.branch?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard normalizedBranch.isEmpty else { return nil }
            guard let projectId = metadata.projectId else { return nil }
            let persistedDirectory = metadata.persistedAgentSession?.cwd?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let currentDirectory = workspace.currentDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
            let spawnDirectory = (try? workspace.termLoopSpawnCwd())?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let rawCwd = [persistedDirectory, currentDirectory, spawnDirectory]
                .compactMap { $0 }
                .first(where: { !$0.isEmpty }) ?? ""
            guard !rawCwd.isEmpty else { return nil }
            return Candidate(workspaceId: workspace.id, projectId: projectId, cwd: rawCwd)
        }, by: { candidate in
            candidate.projectId
        })

        for (projectId, candidates) in candidatesByProject {
            guard let project = ProjectStore.shared.project(id: projectId) else { continue }
            guard let worktrees = try? service.list(in: project.folderPath) else { continue }

            let indexed = worktrees.compactMap { entry -> (path: String, branch: String)? in
                guard !entry.isMain else { return nil }
                let branch = entry.branch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !branch.isEmpty else { return nil }
                let normalizedPath = URL(fileURLWithPath: entry.path).standardizedFileURL.path
                return (path: normalizedPath, branch: branch)
            }
            .sorted { $0.path.count > $1.path.count }

            guard !indexed.isEmpty else { continue }

            for candidate in candidates {
                let cwd = URL(fileURLWithPath: candidate.cwd).standardizedFileURL.path
                guard let match = indexed.first(where: { entry in
                    cwd == entry.path || cwd.hasPrefix(entry.path + "/")
                }) else {
                    continue
                }
                WorkspaceMetadataStore.shared.setBranch(
                    match.branch,
                    worktreePath: match.path,
                    forWorkspaceId: candidate.workspaceId
                )
                let baseline = try? service.headRevision(worktreePath: match.path)
                WorkspaceMetadataStore.shared.setWorktreeBaselineHead(
                    baseline,
                    forWorkspaceId: candidate.workspaceId
                )
                logger.info(
                    "restore worktree branch recovered ws=\(candidate.workspaceId.uuidString, privacy: .public) branch=\(match.branch, privacy: .public)"
                )
            }
        }
    }

    static func shouldLaunchRestoredTerminalAgent(
        agentId: String?,
        persistedSession: PersistedAgentSession?
    ) -> Bool {
        TerminalAgentLifecycle.isEligibleForGenericRestoredLaunch(
            agentId: agentId,
            persistedSession: persistedSession
        )
    }

    /// True if the workspace should be dropped during restore. Today: any
    /// workspace tagged as an ability-agent session. Predicate is a seam
    /// so it can be unit tested without instantiating `TabManager`.
    static func shouldPruneOnRestore(workspaceId: UUID) -> Bool {
        WorkspaceMetadataStore.shared.isAbilityAgent(workspaceId: workspaceId)
    }

    /// Opens the in-app TermLoop settings page (full-bleed, replaces the
    /// terminal in the main area). Called from the upstream App command group
    /// via a single-line marker-wrapped hook, from the titlebar gear button,
    /// and from the command palette. Routed through `TermLoopSettingsPageStore`
    /// so the menu shortcut and the button stay in sync.
    static func openTermLoopSettingsWindow() {
        TermLoopSettingsPageStore.shared.open()
    }

    /// Titlebar gear button rendered next to the new-tab `+`. Returned as an
    /// opaque `View` so the upstream titlebar HStack can append it via a
    /// single-line marker-wrapped hook. Toggles the in-app settings page.
    @ViewBuilder
    static func titlebarSettingsButton(config: TitlebarControlsStyleConfig) -> some View {
        TitlebarControlButton(config: config, action: {
            TermLoopSettingsPageStore.shared.toggle()
        }) {
            Image(systemName: "gearshape")
                .font(.system(size: config.iconSize, weight: .semibold))
                .frame(width: config.buttonSize, height: config.buttonSize)
        }
        .accessibilityIdentifier("titlebarControl.termLoopSettings")
        .accessibilityLabel(String(
            localized: "titlebar.termLoopSettings.accessibilityLabel",
            defaultValue: "TermLoop Settings",
            table: "TermLoop"
        ))
        .help(String(
            localized: "titlebar.termLoopSettings.tooltip",
            defaultValue: "TermLoop Settings",
            table: "TermLoop"
        ))
    }

    /// Called from `ContentView.registerCommandPaletteHandlers` when the user
    /// triggers `palette.newWorkspace`. Routes through the sidebar fast-create
    /// path with the user's default agent + last-used mode when a project is
    /// active; falls back to the plain upstream `addWorkspace` path otherwise.
    static func handleNewWorkspacePaletteCommand(tabManager: TabManager) {
        if let projectId = ProjectStore.shared.activeProjectId {
            UserDefaults.standard.set(TermLoopSidebarTab.work.rawValue, forKey: TermLoopSidebarTab.storageKey)
            let defaultAgentId = TermLoopSettings.shared.defaultTerminalAgentId
            if let agent = TerminalAgentRegistry.shared.agent(id: defaultAgentId)
                ?? TerminalAgentRegistry.shared.agents.first {
                let mode = PermissionModePersistence.resolveLaunchMode(forAgentId: agent.id)
                do {
                    _ = try SidebarInlineCreateCoordinator.shared.fastCreateWorkspace(
                        agent: agent,
                        mode: mode,
                        projectId: projectId,
                        tabManager: tabManager
                    )
                    return
                } catch {
                    #if DEBUG
                    dlog("palette.newWorkspace fast-create failed: \(error). Falling back to inline rename.")
                    #endif
                }
            }
            SidebarInlineCreateCoordinator.shared.beginWorkspace(
                projectId: projectId
            )
        } else {
            tabManager.addWorkspace()
        }
    }

    /// Reserved TermLoop shutdown hook. Terminal agents live inside
    /// Ghostty panes and are torn down by upstream's own shutdown path,
    /// so the body is empty — kept as an extension point for future
    /// async-flush or persistence work.
    static func applicationWillTerminate() {}

    /// Called from `Workspace.newTerminalSurface` right after the panel is
    /// registered and its bonsplit tab exists. Seeds `panelDirectories` with
    /// the explicit spawn cwd so session snapshots capture a valid directory
    /// even when the shell integration (`precmd` → `report_pwd`) has not had
    /// a chance to fire yet (slow `.zshrc`, TUI that never returns to a
    /// prompt, app force-quit immediately after opening a tab).
    ///
    /// Without this seeding, `panelDirectories[id]` stays `nil`, the saved
    /// snapshot writes `null`, and restore falls back to
    /// `workspace.currentDirectory` (the last focused panel's cwd) — which
    /// is the "reopened terminal lands in the wrong directory" bug.
    ///
    /// No-op when `directory` is nil/empty — matches `updatePanelDirectory`
    /// contract and lets the shell report become the source of truth
    /// whenever it does arrive.
    static func seedSpawnPanelDirectory(
        workspace: Workspace,
        panelId: UUID,
        directory: String?
    ) {
        guard let raw = directory?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return }
        workspace.updatePanelDirectory(panelId: panelId, directory: raw)
    }

    /// Called from the top of `Workspace.sessionPanelSnapshot` as a
    /// defense-in-depth pass. If the live directory dictionary is empty for
    /// this panel (e.g. the spawn seed path was skipped, the dict got
    /// cleared, or the panel was created by a non-`newTerminalSurface` code
    /// path), fall back to the terminal's originally-requested spawn
    /// directory before the snapshot reads the dict.
    ///
    /// Only fills in missing values; never overwrites a live-reported cwd.
    /// Writes directly to `panelDirectories` (bypassing
    /// `updatePanelDirectory`) so this read-path hook doesn't mutate
    /// `currentDirectory` as a side effect.
    static func ensurePanelDirectoryBeforeSnapshot(
        workspace: Workspace,
        panelId: UUID
    ) {
        if let existing = workspace.panelDirectories[panelId]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !existing.isEmpty {
            return
        }
        guard let terminalPanel = workspace.panels[panelId] as? TerminalPanel,
              let requested = terminalPanel.requestedWorkingDirectory?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !requested.isEmpty else {
            return
        }
        workspace.panelDirectories[panelId] = requested
    }

    #if DEBUG
    /// Opens the live DebugEventLog viewer. DEBUG-only because the underlying
    /// ring buffer (`Bonsplit.DebugEventLog`) is wrapped in `#if DEBUG`.
    static func openDebugEventLogWindow() {
        DebugEventLogWindowController.shared.show()
    }
    #endif

    /// Conditionally swaps the terminal content for TermLoop-owned overlays.
    /// A SwiftUI `.overlay` can't visually cover TermLoop's terminal
    /// surface because Ghostty renders into a window-level AppKit portal
    /// view (`WindowTerminalHostView`) that sits above SwiftUI in the
    /// NSWindow's view tree. Removing the SwiftUI anchor entirely — by
    /// returning an overlay surface in place of the closure's content —
    /// lets the portal's own anchor-tracking logic (`isHiddenOrAncestorHidden`
    /// in TerminalWindowPortal.swift) hide the hosted terminal NSView at
    /// the window level while an overlay is active. When the overlay
    /// closes, the anchor reappears and the portal restores the hosted
    /// terminal without restarting the Ghostty session.
    static func mainAreaOverlaySwap<Content: View>(
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        AgentMainAreaOverlaySwap(content: content)
    }

    /// Mirror of `AgentMainAreaOverlaySwap.overlayMode`. Both reducers must
    /// stay in lockstep — the swap drives view rendering, this version drives
    /// titlebar overlay decisions and any other static caller. If you add a
    /// new overlay branch, update both. (Codex flagged drift on the original
    /// settings-page rollout; keep them aligned.)
    static func currentMainAreaOverlayMode() -> AgentMainAreaOverlayMode {
        let routeSelection = storedMainAreaRouteSelection()
        return AgentMainAreaOverlayMode.resolveCurrent(
            sidebarTab: routeSelection.sidebarTab,
            workSubTab: routeSelection.workSubTab,
            tabManager: AppDelegate.shared?.tabManager
        )
    }

    static func shouldHideMainAreaTitlebarOverlay() -> Bool {
        currentMainAreaOverlayMode() != .content
    }

    private static func storedMainAreaRouteSelection() -> (sidebarTab: TermLoopSidebarTab, workSubTab: WorkSubTab) {
        MainAreaPresentationCoordinator.storedRouteSelection()
    }

    static func applyMainAreaPresentation(tabManager: TabManager, reason: String) {
        guard let windowId = AppDelegate.shared?.windowId(for: tabManager) else { return }
        let routeSelection = storedMainAreaRouteSelection()
        MainAreaPresentationCoordinator.shared.applyCurrent(
            windowId: windowId,
            tabManager: tabManager,
            sidebarTab: routeSelection.sidebarTab,
            workSubTab: routeSelection.workSubTab,
            reason: reason
        )
    }

    static func mainAreaPresentationSnapshot(
        windowId: UUID,
        tabManager: TabManager,
        retiringWorkspaceId: UUID?,
        mountedWorkspaceIds: [UUID],
        handoffGeneration: UInt64,
        hasCommandPaletteOrFileDropOverlay: Bool = false
    ) -> MainAreaPresentationSnapshot {
        let routeSelection = storedMainAreaRouteSelection()
        return MainAreaPresentationCoordinator.shared.snapshot(
            windowId: windowId,
            tabManager: tabManager,
            sidebarTab: routeSelection.sidebarTab,
            workSubTab: routeSelection.workSubTab,
            retiringWorkspaceId: retiringWorkspaceId,
            mountedWorkspaceIds: mountedWorkspaceIds,
            handoffGeneration: handoffGeneration,
            hasCommandPaletteOrFileDropOverlay: hasCommandPaletteOrFileDropOverlay
        )
    }

    static func shouldKeepRetiringWorkspaceVisibleForHandoff(
        windowId: UUID,
        tabManager: TabManager,
        oldWorkspaceId: UUID,
        newWorkspaceId: UUID,
        mountedWorkspaceIds: [UUID],
        handoffGeneration: UInt64,
        hasCommandPaletteOrFileDropOverlay: Bool = false
    ) -> Bool {
        let routeSelection = storedMainAreaRouteSelection()
        let input = MainAreaPresentationCoordinator.shared.liveInput(
            windowId: windowId,
            tabManager: tabManager,
            sidebarTab: routeSelection.sidebarTab,
            workSubTab: routeSelection.workSubTab,
            retiringWorkspaceId: oldWorkspaceId,
            mountedWorkspaceIds: mountedWorkspaceIds,
            handoffGeneration: handoffGeneration,
            hasCommandPaletteOrFileDropOverlay: hasCommandPaletteOrFileDropOverlay
        ).replacingSelectedWorkspaceId(newWorkspaceId)
        return MainAreaPresentationPolicy.allowsSameProjectContentHandoff(
            input: input,
            oldWorkspaceId: oldWorkspaceId,
            newWorkspaceId: newWorkspaceId
        )
    }

    static func handleMainAreaHandoffPresentationEvent(
        notification: Notification,
        windowId: UUID,
        retiringWorkspaceId: UUID?,
        complete: (String) -> Void
    ) {
        guard let retiringWorkspaceId else { return }
        guard notification.userInfo?["windowId"] as? UUID == windowId else { return }
        if let workspaceId = notification.userInfo?["workspaceId"] as? UUID {
            guard workspaceId == retiringWorkspaceId else { return }
        }
        let reason = notification.userInfo?["reason"] as? String ?? "presentation_policy"
        complete(reason)
    }

    static func handleWorkspaceHandoffReadiness(
        notification: Notification,
        selectedWorkspaceId: UUID?,
        canComplete: (UUID) -> Bool,
        complete: (UUID, String) -> Void
    ) {
        guard let selectedWorkspaceId else { return }
        let workspaceId = notification.userInfo?["workspaceId"] as? UUID
            ?? notification.userInfo?[GhosttyNotificationKey.tabId] as? UUID
        guard workspaceId == selectedWorkspaceId else { return }
        guard canComplete(selectedWorkspaceId) else { return }
        complete(selectedWorkspaceId, notification.name == .terminalSurfaceHostedViewDidMoveToWindow ? "hosted_view_ready" : "surface_ready")
    }

    /// Footer view appended under the terminal area for a given workspace.
    /// Reserved as an TermLoop extension point — currently empty.
    @ViewBuilder
    static func workspaceFooterExtras(workspace: Workspace) -> some View {
        EmptyView()
    }

    /// Agents submenu used inside the workspace row context menu. Lists
    /// registered agent templates with attach/detach toggles + a "Run one-off"
    /// item that posts `termLoopOpenOneOff`. Dividers are managed by the caller
    /// so this hook can be positioned at the top of the menu without a leading
    /// separator.
    @ViewBuilder
    static func workspaceContextMenuExtras(workspace: Workspace) -> some View {
        PermissionModeContextMenu(workspace: workspace)
        CopyWorkspaceIdMenu(workspace: workspace)
    }

    /// Conversation-branch / handoff actions. Same-agent Claude/Codex routes
    /// surface as native "Fork Conversation"; every other target remains a
    /// context handoff into a new agent session. Hidden when multiple
    /// workspaces are selected — this is a per-workspace action.
    @ViewBuilder
    static func workspaceForkMenu(
        workspace: Workspace,
        isMulti: Bool
    ) -> some View {
        if !isMulti {
            let forkTargets = TerminalAgentRegistry.shared.agents.map { agent in
                (
                    agent: agent,
                    launchSource: preferredForkLaunchSource(
                        workspace: workspace,
                        targetAgentId: agent.id
                    )
                )
            }
            let nativeForkTargets = forkTargets.filter { $0.launchSource.isNativeFork }
            let handoffTargets = forkTargets.filter { !$0.launchSource.isNativeFork }

            if nativeForkTargets.count == 1,
               let nativeForkTarget = nativeForkTargets.first {
                Button(String(
                    localized: "contextMenu.forkConversation",
                    defaultValue: "Fork Conversation",
                    table: "TermLoop"
                )) {
                    presentForkQuickAction(
                        for: workspace,
                        agentId: nativeForkTarget.agent.id,
                        launchSource: nativeForkTarget.launchSource
                    )
                }
            } else if !nativeForkTargets.isEmpty {
                Menu(String(
                    localized: "contextMenu.forkConversation",
                    defaultValue: "Fork Conversation",
                    table: "TermLoop"
                )) {
                    ForEach(nativeForkTargets, id: \.agent.id) { target in
                        Button(target.agent.displayName) {
                            presentForkQuickAction(
                                for: workspace,
                                agentId: target.agent.id,
                                launchSource: target.launchSource
                            )
                        }
                    }
                }
            }

            if !handoffTargets.isEmpty {
                Menu(String(
                    localized: "contextMenu.handoffToNewAgent",
                    defaultValue: "Handoff to New Agent",
                    table: "TermLoop"
                )) {
                    ForEach(handoffTargets, id: \.agent.id) { target in
                        Button(target.agent.displayName) {
                            presentForkQuickAction(
                                for: workspace,
                                agentId: target.agent.id,
                                launchSource: target.launchSource
                            )
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    static func workspaceForkMenu(
        workspace: Workspace,
        snapshot: ActiveAgentWorkspaceContextMenuSnapshot,
        isMulti: Bool
    ) -> some View {
        if !isMulti {
            if snapshot.nativeForkTargets.count == 1,
               let nativeForkTarget = snapshot.nativeForkTargets.first {
                Button(String(
                    localized: "contextMenu.forkConversation",
                    defaultValue: "Fork Conversation",
                    table: "TermLoop"
                )) {
                    presentForkQuickAction(
                        for: workspace,
                        agentId: nativeForkTarget.agentId,
                        launchSource: nativeForkTarget.launchSource
                    )
                }
            } else if !snapshot.nativeForkTargets.isEmpty {
                Menu(String(
                    localized: "contextMenu.forkConversation",
                    defaultValue: "Fork Conversation",
                    table: "TermLoop"
                )) {
                    ForEach(snapshot.nativeForkTargets) { target in
                        Button(target.displayName) {
                            presentForkQuickAction(
                                for: workspace,
                                agentId: target.agentId,
                                launchSource: target.launchSource
                            )
                        }
                    }
                }
            }

            if !snapshot.handoffTargets.isEmpty {
                Menu(String(
                    localized: "contextMenu.handoffToNewAgent",
                    defaultValue: "Handoff to New Agent",
                    table: "TermLoop"
                )) {
                    ForEach(snapshot.handoffTargets) { target in
                        Button(target.displayName) {
                            presentForkQuickAction(
                                for: workspace,
                                agentId: target.agentId,
                                launchSource: target.launchSource
                            )
                        }
                    }
                }
            }
        }
    }

    @MainActor
    private static func presentForkQuickAction(
        for workspace: Workspace,
        agentId: String,
        launchSource: AgentInvocationSource
    ) {
        let rawSourceTitle = workspace.customTitle?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let sourceTitle = rawSourceTitle.isEmpty ? workspace.title : rawSourceTitle
        let defaultPrompt = defaultPromptForFork(
            workspace: workspace,
            launchSource: launchSource
        )
        DispatchQueue.main.async {
            QuickActionController.shared.present(
                prefill: QuickActionPresentationRequest(
                    initialSurface: .run,
                    targetWorkspaceId: workspace.id,
                    promptText: defaultPrompt,
                    advancedTitle: sourceTitle,
                    advancedTerminalAgentId: agentId,
                    launchSource: launchSource,
                    reasonTag: "quickAction.freePrompt"
                )
            )
        }
    }

    static func preferredForkLaunchSource(
        workspace: Workspace,
        targetAgentId: String
    ) -> AgentInvocationSource {
        guard let session = WorkspaceSessionReferenceResolver.resolve(for: workspace),
              session.agentId == targetAgentId else {
            return .workspaceFork
        }
        switch targetAgentId {
        case TerminalAgent.claudeId:
            return .claudeNativeFork
        case "codex":
            return .codexNativeFork
        default:
            return .workspaceFork
        }
    }

    static func defaultPromptForFork(
        workspace: Workspace,
        launchSource: AgentInvocationSource
    ) -> String {
        launchSource.isForkLike && launchSource != .workspaceFork
            ? ""
            : ForkHandoffPromptDefaults.prompt(for: workspace)
    }

    /// "Link to…" submenu in the workspace context menu. Lets the user
    /// pick another workspace in the same project to start a bridge.
    /// Hidden when multi-selected.
    @ViewBuilder
    static func workspaceLinkToMenu(
        workspace: Workspace,
        isMulti: Bool,
        tabManager: TabManager
    ) -> some View {
        if !isMulti {
            Menu(String(localized: "bridge.contextMenu.linkTo",
                        defaultValue: "Link to…",
                        table: "TermLoop")) {
                BridgeLinkPicker(source: workspace, tabManager: tabManager)
            }
        }
    }

    @ViewBuilder
    static func workspaceLinkToMenu(
        snapshot: ActiveAgentWorkspaceContextMenuSnapshot,
        isMulti: Bool
    ) -> some View {
        if !isMulti {
            Menu(String(
                localized: "bridge.contextMenu.linkTo",
                defaultValue: "Link to…",
                table: "TermLoop"
            )) {
                ActiveAgentWorkspaceLinkMenu(snapshot: snapshot)
            }
        }
    }

    /// "Ask To…" action in the workspace context menu. Starts a guided
    /// Claude -> helper-agent bridge flow with agent + preset selection.
    @ViewBuilder
    static func workspaceAskToMenu(
        workspace: Workspace,
        isMulti: Bool
    ) -> some View {
        if !isMulti {
            let sourceAgentId = TerminalAgentActivityStore.shared.resolvedAgentId(forWorkspace: workspace)
            if sourceAgentId == TerminalAgent.claudeId || sourceAgentId == "codex" {
                Button(String(
                    localized: "bridge.contextMenu.askTo",
                    defaultValue: "Ask To…",
                    table: "TermLoop"
                )) {
                    var userInfo: [String: Any] = ["sourceId": workspace.id.uuidString]
                    let screenPoint = NSEvent.mouseLocation
                    if let window = NSApp.keyWindow ?? NSApp.mainWindow,
                       let contentView = window.contentView {
                        let windowPoint = window.convertPoint(fromScreen: screenPoint)
                        // AppKit bottom-left origin → SwiftUI .global top-left.
                        // Use the content view height so the flip matches the
                        // coordinate space SwiftUI GeometryReader reports.
                        let topLeftY = contentView.frame.height - windowPoint.y
                        userInfo["globalPointX"] = Double(windowPoint.x)
                        userInfo["globalPointY"] = Double(topLeftY)
                    }
                    // Presenting a SwiftUI popover directly from a context-menu
                    // action is timing-sensitive on macOS: the menu teardown can
                    // swallow the state change and leave the user with a closing
                    // menu but no Ask To UI. Post on the next main-runloop tick
                    // so the sidebar root presents after the menu has dismissed.
                    DispatchQueue.main.async {
                        NotificationCenter.default.post(
                            name: .termLoopOpenAskTo,
                            object: nil,
                            userInfo: userInfo
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    static func workspaceAskToMenu(
        workspace: Workspace,
        canAskTo: Bool,
        isMulti: Bool
    ) -> some View {
        if !isMulti && canAskTo {
            Button(String(
                localized: "bridge.contextMenu.askTo",
                defaultValue: "Ask To…",
                table: "TermLoop"
            )) {
                var userInfo: [String: Any] = ["sourceId": workspace.id.uuidString]
                let screenPoint = NSEvent.mouseLocation
                if let window = NSApp.keyWindow ?? NSApp.mainWindow,
                   let contentView = window.contentView {
                    let windowPoint = window.convertPoint(fromScreen: screenPoint)
                    let topLeftY = contentView.frame.height - windowPoint.y
                    userInfo["globalPointX"] = Double(windowPoint.x)
                    userInfo["globalPointY"] = Double(topLeftY)
                }
                DispatchQueue.main.async {
                    NotificationCenter.default.post(
                        name: .termLoopOpenAskTo,
                        object: nil,
                        userInfo: userInfo
                    )
                }
            }
        }
    }

    // MARK: - B4: workspace.resumed on terminal-agent → Running

    /// Called whenever a terminal-agent status entry changes value.
    /// If the new value is `"Running"` and the workspace was in awaiting-input
    /// state, clears that flag and publishes `workspace.resumed`.
    static func notifyTerminalAgentStatusChange(workspaceId: UUID, newValue: String) {
        #if DEBUG
        dlog("bridge.notifyAgent ws=\(workspaceId.uuidString.prefix(8)) new=\(newValue)")
        #endif
        guard newValue == "Running" else { return }
        let store = WorkspaceMetadataStore.shared
        guard store.metadata(forWorkspaceId: workspaceId).awaitingInputSince != nil else { return }
        // Clear the awaiting-input flag; the other quick-reply keys are left
        // intact so mobile can still display "last seen" context.
        store.setAwaitingInputSince(nil, forWorkspaceId: workspaceId)
        let now = Int(Date().timeIntervalSince1970)
        EventBus.shared.publish(.init(
            type: "workspace.resumed",
            workspaceId: workspaceId,
            payload: ["at": now]
        ))
    }

    /// Backwards-compatible wrapper for old call sites/tests.
    static func notifyClaudeStatusChange(workspaceId: UUID, newValue: String) {
        notifyTerminalAgentStatusChange(workspaceId: workspaceId, newValue: newValue)
    }

    /// Starts the stale-status reconciler at app launch.
    static func bootstrapBlockedBin() {
        TerminalAgentActivityStore.shared.startReconcileLoop()
        ensureClaudeHooksInstalled()
        ensureCodexHooksInstalled()
        ensureGeminiHooksInstalled()
        ensureOpenCodeHooksInstalled()
        PushDispatcher.shared.start()
        #if DEBUG
        dlog("bridge.bootstrap v=2 bridges=\(WorkspaceBridgeStore.shared.bridges.count)")
        #endif
    }

    /// Called once per window from `TermLoopSidebar.Root.body.onAppear`.
    /// Idempotent (`BridgeCoordinator.start` guards `!started`), so repeated
    /// `onAppear` firings (e.g. window hide/show) are safe.
    @MainActor
    static func bootstrapSidebar(tabManager: TabManager) {
        BridgeCoordinator.shared.start(tabManager: tabManager)
        TaskQuickActionsBridge.requestFocusWorkspace = { workspaceId in
            TermLoopHooks.focusWorkspace(workspaceId: workspaceId)
        }
        TaskQuickActionsBridge.requestSelectWorkspaceInline = { workspaceId in
            TermLoopHooks.selectWorkspaceForTaskBoard(workspaceId: workspaceId)
        }
        TaskQuickActionsBridge.requestOpenWorktreePath = { path in
            WorktreeRepairCoordinator.shared.openFolder(path: path)
        }
        TaskQuickActionsBridge.requestNewAgentPanel = { context, onLaunchedWorkspaceId in
            TermLoopHooks.presentTaskAgentQuickAction(
                context: context,
                onLaunchedWorkspaceId: onLaunchedWorkspaceId
            )
        }
    }

    static func handleProjectNumberShortcut(digit: Int?, tabManager: TabManager?) -> Bool {
        guard let digit else { return false }
        return ProjectShortcutRouter.selectProject(forDigit: digit, tabManager: tabManager)
    }

    /// Silently writes the six teleport hooks into `~/.claude/settings.json`
    /// if any are missing. Idempotent — re-adds only the events that aren't
    /// already present. Runs on every launch so a user who clears their
    /// settings never ends up with a half-working push pipeline.
    ///
    /// Returns `true` when the end state is a correctly installed config
    /// (already-present or freshly installed); `false` when install threw and
    /// the state is unknown, so callers can retry later in the same process.
    @discardableResult
    private static func ensureClaudeHooksInstalled() -> Bool {
        if ClaudeHooksStatus.probe() { return true }
        do {
            try ClaudeHookInstaller.install(jsonOutput: false)
            ClaudeHooksStatus.shared.markDirty()
            return true
        } catch {
            NSLog("TermLoopHooks: auto-install of Claude hooks failed: \(error)")
            return false
        }
    }

    /// Silently writes the Codex hook bridge into `~/.codex/hooks.json` and
    /// enables `codex_hooks = true` when missing. Mirrors the Claude launch
    /// auto-heal path so Codex status doesn't disappear after config resets.
    ///
    /// `ensureGlobalCodexConfigInstalled` runs unconditionally — its marker-block
    /// helpers are idempotent AND migrate legacy unmarked `[mcp_servers.termloop]`
    /// sections into TermLoop-owned BEGIN/END blocks. Skipping it when the probe
    /// passes would leave legacy files permanently unmarked.
    @discardableResult
    private static func ensureCodexHooksInstalled() -> Bool {
        TermLoopCodexHooks.ensureGlobalCodexConfigInstalled()
        if CodexHooksStatus.probe() { return true }
        do {
            try installAgentHooksViaBundledCLI(agentName: "codex")
            CodexHooksStatus.shared.markDirty()
            return true
        } catch {
            NSLog("TermLoopHooks: auto-install of Codex hooks failed: \(error)")
            return false
        }
    }

    @discardableResult
    private static func ensureGeminiHooksInstalled() -> Bool {
        if GeminiHooksStatus.probe() { return true }
        do {
            try FileManager.default.createDirectory(
                at: URL(fileURLWithPath: GeminiHooksStatus.settingsPath()).deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: nil
            )
            try installAgentHooksViaBundledCLI(agentName: "gemini")
            GeminiHooksStatus.shared.markDirty()
            return true
        } catch {
            NSLog("TermLoopHooks: auto-install of Gemini hooks failed: \(error)")
            return false
        }
    }

    /// Dispatcher used by `UserScopeHookSync`. Returns `true` only when the
    /// install completed (or was already current) so callers can retry on
    /// failure later in the same app lifetime.
    @discardableResult
    static func ensureHooksInstalled(for agent: HookManagedAgent) -> Bool {
        switch agent {
        case .claude: return ensureClaudeHooksInstalled()
        case .codex:  return ensureCodexHooksInstalled()
        case .gemini: return ensureGeminiHooksInstalled()
        }
    }

    private static func ensureOpenCodeHooksInstalled() {
        guard !OpenCodeHooksStatus.probe() else { return }
        do {
            try installOpenCodePlugin()
            OpenCodeHooksStatus.shared.markDirty()
        } catch {
            NSLog("TermLoopHooks: auto-install of OpenCode hooks failed: \(error)")
        }
    }

    private static func installAgentHooksViaBundledCLI(agentName: String) throws {
        let executableURL: URL? = {
            if let resourceURL = Bundle.main.resourceURL {
                let bundledCLI = resourceURL.appendingPathComponent("bin/termloop")
                if FileManager.default.isExecutableFile(atPath: bundledCLI.path) {
                    return bundledCLI
                }
            }
            return Bundle.main.executableURL
        }()

        guard let executableURL else {
            throw NSError(
                domain: "TermLoopHooks",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Missing bundled executable URL for agent hook install"]
            )
        }

        let process = Process()
        process.executableURL = executableURL
        process.arguments = [agentName, "install-hooks", "--yes"]
        process.environment = ProcessInfo.processInfo.environment

        let stderr = Pipe()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = stderr

        try process.run()
        stderr.fileHandleForWriting.closeFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let errorOutput = String(
                data: stderr.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown error"
            throw NSError(
                domain: "TermLoopHooks",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: "\(agentName) hook install failed: \(errorOutput)"]
            )
        }
    }

    private static func installOpenCodePlugin() throws {
        let pluginsDirectory = URL(
            fileURLWithPath: OpenCodeHooksStatus.pluginsDirectoryPath(),
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: pluginsDirectory,
            withIntermediateDirectories: true,
            attributes: nil
        )

        let pluginURL = URL(fileURLWithPath: OpenCodeHooksStatus.pluginPath())
        let source = openCodePluginSource()
        let existing = try? String(contentsOf: pluginURL, encoding: .utf8)
        guard existing != source else { return }
        try source.write(to: pluginURL, atomically: true, encoding: .utf8)
    }

    private static func openCodePluginSource() -> String {
        #"""
export const TermLoopOpenCode = async ({ $, directory }) => {
  const sessionStatus = new Map()
  const seenUserMessageIds = new Set()

  const isEnabled = () =>
    Boolean(process.env.TERMLOOP_SURFACE_ID) &&
    process.env.TERMLOOP_OPENCODE_HOOKS_DISABLED !== "1"

  const run = async (subcommand, payload = {}) => {
    if (!isEnabled()) return
    try {
      await $`printf '%s' ${JSON.stringify(payload)} | termloop opencode-hook ${subcommand}`
    } catch {}
  }

  const sessionIdFor = (event) =>
    event?.properties?.sessionID ??
    event?.properties?.info?.id ??
    event?.properties?.info?.sessionID ??
    event?.properties?.part?.sessionID ??
    null

  const cwdFor = (event) =>
    event?.properties?.info?.directory ??
    event?.properties?.info?.path?.cwd ??
    directory

  return {
    event: async ({ event }) => {
      const sessionId = sessionIdFor(event)
      const cwd = cwdFor(event)

      switch (event.type) {
        case "session.created":
          await run("session-start", { session_id: sessionId, cwd })
          break

        case "message.updated": {
          const info = event?.properties?.info
          if (info?.role !== "user") break
          if (info?.id && seenUserMessageIds.has(info.id)) break
          if (info?.id) seenUserMessageIds.add(info.id)
          await run("prompt-submit", { session_id: sessionId, cwd })
          break
        }

        case "permission.asked":
          await run("permission", {
            session_id: sessionId,
            cwd,
            message_preview: "OpenCode permission required"
          })
          break

        case "session.error":
          await run("error", {
            session_id: sessionId,
            cwd,
            message_preview:
              event?.properties?.error?.message ??
              event?.properties?.message ??
              "OpenCode session error"
          })
          break

        case "session.status": {
          const nextStatus = event?.properties?.status?.type
          if (!sessionId || typeof nextStatus !== "string") break
          const previousStatus = sessionStatus.get(sessionId)
          sessionStatus.set(sessionId, nextStatus)
          if (nextStatus === "busy") {
            await run("prompt-submit", { session_id: sessionId, cwd })
          } else if (nextStatus === "idle" && previousStatus === "busy") {
            await run("stop", { session_id: sessionId, cwd })
          }
          break
        }

        case "session.idle":
          if (sessionId && sessionStatus.get(sessionId) === "busy") {
            sessionStatus.set(sessionId, "idle")
            await run("stop", { session_id: sessionId, cwd })
          }
          break

        case "session.deleted":
          if (sessionId) {
            sessionStatus.delete(sessionId)
            await run("session-end", { session_id: sessionId, cwd })
          }
          break

        default:
          break
      }
    }
  }
}
"""#
    }

    /// Returns true if the given string matches a known `TerminalAgent.id`
    /// in the built-in registry. Used by socket/CLI param validation.
    static func isKnownTerminalAgentId(_ id: String) -> Bool {
        TerminalAgentRegistry.shared.agent(id: id) != nil
    }

    /// Called from `TabManager.addWorkspace` at creation time. Binds the
    /// workspace's `terminalAgentId` so the metadata store tracks which
    /// agent CLI this workspace prefers. No pane marking — all panes are
    /// equal. `explicit == nil` defers to the resolver precedence chain.
    static func bindTerminalAgentOnWorkspaceCreate(
        workspace: Workspace,
        terminalAgentId explicit: String?
    ) {
        let resolvedId = TerminalAgentLifecycle.resolveAgentId(
            explicit: explicit,
            workspaceId: workspace.id
        )
        WorkspaceMetadataStore.shared.setTerminalAgentId(resolvedId, for: workspace.id)
    }

    /// Called from `TabManager.selectedTabId.didSet`. Consumes the
    /// migration toast flag so the notification fires once per legacy
    /// workspace.
    static func workspaceSelectionChanged(tabManager: TabManager, selectedTabId: UUID?) {
        guard let selectedTabId,
              let workspace = tabManager.tabs.first(where: { $0.id == selectedTabId })
        else { return }
        TermLoopDeferredWorkspaceRestore.materializeIfNeeded(workspace: workspace)
        if consumeMigrationToast(workspaceId: workspace.id) {
            surfaceMigrationToast(workspaceId: workspace.id)
        }
    }

    private static func surfaceMigrationToast(workspaceId: UUID) {
        let agentId = WorkspaceMetadataStore.shared.terminalAgentId(for: workspaceId)
            ?? TermLoopSettings.shared.defaultTerminalAgentId
        let displayName = TerminalAgentRegistry.shared.agent(id: agentId)?.displayName ?? agentId
        let title = String(
            localized: "migration.noAgentTitle",
            defaultValue: "No agent was assigned",
            table: "TermLoop"
        )
        let body = String(
            localized: "migration.noAgentBody",
            defaultValue: "Defaulted to \(displayName). Change it from the workspace menu.",
            table: "TermLoop"
        )
        // Use user notification center so the user sees it without modal
        // interruption. Fallback to logger if the app hasn't wired the
        // notification center yet (unit tests).
        logger.info("workspace \(workspaceId.uuidString, privacy: .public) migrated → \(displayName, privacy: .public)")
        NotificationCenter.default.post(
            name: .termLoopMigrationToast,
            object: nil,
            userInfo: [
                "workspaceId": workspaceId,
                "title": title,
                "body": body
            ]
        )
    }

    /// Called from `TabManager.closeWorkspaceIfRunningProcess()` before any
    /// upstream confirmation. Returns `true` if TermLoop wants to defer the
    /// close and fire `completion` later; otherwise returns `false` to let
    /// the upstream close proceed. Currently has nothing to defer.
    static func workspaceWillClose(
        workspace: Workspace,
        completion: @escaping (_ shouldClose: Bool) -> Void
    ) -> Bool {
        return false
    }

    /// Called unconditionally from `TabManager.closeWorkspace(_:)` right
    /// after the workspace is removed from `tabs`. This is the one
    /// reliable point to run cleanup for workspace-keyed TermLoop state
    /// that must not leak across close boundaries. The pre-existing
    /// `workspaceWillClose` runs only when attached agents or a worktree
    /// exist, so it is **not** a universal cleanup hook.
    ///
    /// Takes `workspaceId` (UUID) rather than `Workspace`: by the time
    /// this fires, upstream has already torn down panels, and callers
    /// may only hold the id safely. All TermLoop state is keyed on
    /// workspace id.
    static func workspaceDidClose(workspaceId: UUID) {
        TermLoopDeferredWorkspaceRestore.discard(workspaceId: workspaceId)
        BridgeCoordinator.shared.workspaceDidClose(workspaceId: workspaceId)
        WorkspaceMetadataStore.shared.forgetObservedWorkspaceTitle(workspaceId: workspaceId)
        WorkspaceMetadataStore.shared.clearAgentSession(forWorkspaceId: workspaceId)
        TaskSelectionStoreProvider.shared.closeInlineTerminals(workspaceId: workspaceId)
        MainAreaPresentationCoordinator.shared.handleNavigationEvent(.workspaceDidClose(workspaceId))
    }

    static func workspaceTitleDidChange(workspace: Workspace) {
        let custom = workspace.customTitle?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title = custom.isEmpty ? workspace.title : custom
        WorkspaceMetadataStore.shared.noteWorkspaceTitleDidChange(
            workspaceId: workspace.id,
            displayTitle: title
        )
    }

    /// Sidebar cable view rendered directly below the LEFT endpoint of a bridge.
    /// Returns `WorkspaceRowBridgeExtras` when the workspace is the left side of
    /// an active bridge; collapses to `EmptyView` otherwise (Y3: decide inside hook).
    @ViewBuilder
    static func workspaceRowBridgeExtras(workspace: Workspace, tabManager: TabManager) -> some View {
        WorkspaceRowBridgeExtras(workspace: workspace, tabManager: tabManager)
    }
}

/// Internal wrapper used by `mainAreaOverlaySwap`. Lives next to the hook so
/// upstream callers only need to import TermLoopHooks. Applies the same
/// `.frame(maxWidth: .infinity) + .layoutPriority(1)` terminalContent
/// normally carries so the HStack sibling layout stays identical when
/// an overlay replaces the terminal anchor.
extension Notification.Name {
    /// Posted by TermLoop when a legacy workspace gets a default terminal
    /// agent assigned on first open after upgrade. `userInfo` carries
    /// `workspaceId: UUID`, `title: String`, `body: String`.
    static let termLoopMigrationToast = Notification.Name("termloop.migrationToast")
}

enum AgentMainAreaOverlayMode: Equatable {
    case content
    case agents
    case ability(String)
    case markdownDocument(URL)
    case gitChanges(UUID)
    /// Full-area Context Bank right pane — file viewer or suggestion
    /// diff + Accept/Reject. Active when the TermLoop sidebar is on
    /// `.work + .contextBank` AND no higher-priority overlay is up.
    case contextBank
    case settings
    case projectEmpty
    /// Project-scoped Tasks (kanban) page. Selected when the sidebar is on
    /// `.tasks` and a project is active.
    case taskBoard(UUID)

    private static let fallbackMainAreaWindowId = UUID(
        uuidString: "00000000-0000-0000-0000-000000000001"
    )!

    var identity: String {
        switch self {
        case .content: return "content"
        case .agents: return "agents"
        case let .ability(id): return "ability:\(id)"
        case let .markdownDocument(url): return "markdownDocument:\(url.path)"
        case let .gitChanges(workspaceId): return "gitChanges:\(workspaceId.uuidString)"
        case .contextBank: return "contextBank"
        case .settings: return "settings"
        case .projectEmpty: return "projectEmpty"
        case let .taskBoard(projectId): return "taskBoard:\(projectId.uuidString)"
        }
    }

    /// Single source of truth for "which overlay should the main pane render
    /// right now?" — both the live SwiftUI swap and the static
    /// `currentMainAreaOverlayMode()` helper resolve through this so the
    /// titlebar-overlay decision and the actual rendered view never diverge.
    @MainActor
    static func resolveCurrent(
        sidebarTab: TermLoopSidebarTab,
        workSubTab: WorkSubTab,
        tabManager: TabManager?
    ) -> AgentMainAreaOverlayMode {
        guard let tabManager,
              let windowId = AppDelegate.shared?.windowId(for: tabManager) else {
            let fallbackInput = MainAreaPresentationInput(
                windowId: fallbackMainAreaWindowId,
                sidebarTab: sidebarTab,
                workSubTab: workSubTab,
                selectedWorkspaceId: nil,
                retiringWorkspaceId: nil,
                mountedWorkspaceIds: [],
                pendingBackgroundWorkspaceLoadIds: [],
                activeProjectId: nil,
                workspaceProjectIds: [:],
                settingsIsOpen: TermLoopSettingsPageStore.shared.isOpen,
                markdownDocumentURL: MarkdownDocumentStore.shared.selectedFileURL,
                gitChangesWorkspaceId: GitChangesMainAreaStore.shared.presentation?.workspaceId,
                abilityDetailId: AbilityDetailUIState.shared.selectedAbilityId,
                abilityDetailIsSplit: false,
                taskBoardInlineWorkspaceId: nil,
                hasCommandPaletteOrFileDropOverlay: false,
                handoffGeneration: 0
            )
            return MainAreaPresentationPolicy.resolveMainPage(fallbackInput).overlayMode
        }
        return MainAreaPresentationCoordinator.shared.snapshot(
            windowId: windowId,
            tabManager: tabManager,
            sidebarTab: sidebarTab,
            workSubTab: workSubTab
        ).mainPage.overlayMode
    }
}

private struct AgentMainAreaOverlaySwap<Content: View>: View {
    @ObservedObject private var markdownDocument = MarkdownDocumentStore.shared
    @ObservedObject private var gitChanges = GitChangesMainAreaStore.shared
    @ObservedObject private var abilityDetail = AbilityDetailUIState.shared
    @ObservedObject private var projectStore = ProjectStore.shared
    @ObservedObject private var workspaceMetadata = WorkspaceMetadataStore.shared
    @ObservedObject private var settingsPage = TermLoopSettingsPageStore.shared
    @EnvironmentObject private var tabManager: TabManager
    @AppStorage(TermLoopSidebarTab.storageKey) private var tabRawValue: String = TermLoopSidebarTab.work.rawValue
    @AppStorage(WorkSubTab.storageKey) private var workSubTabRaw: String = WorkSubTab.loop.rawValue
    @ViewBuilder let content: () -> Content

    private var overlayMode: AgentMainAreaOverlayMode {
        // Routes through the shared factory so this view and
        // `TermLoopHooks.currentMainAreaOverlayMode()` cannot drift —
        // the factory observes `TermLoopSettingsPageStore` (via the
        // `@ObservedObject` on this view) and resolves `.settings` /
        // `.projectEmpty` / etc. in one place.
        AgentMainAreaOverlayMode.resolveCurrent(
            sidebarTab: TermLoopSidebarTab(rawValue: tabRawValue) ?? .work,
            workSubTab: WorkSubTab(rawValue: workSubTabRaw) ?? .loop,
            tabManager: tabManager
        )
    }

    @ViewBuilder
    private func overlayContainer<Inner: View>(@ViewBuilder _ inner: () -> Inner) -> some View {
        inner()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .layoutPriority(1)
    }

    private func shouldSplitAbilityDetail(abilityId: String) -> Bool {
        guard let selectedWorkspaceId = tabManager.selectedTabId,
              let session = workspaceMetadata.abilitySession(forWorkspaceId: selectedWorkspaceId) else {
            return false
        }
        switch session.kind {
        case .abilityRefiner(let id), .abilityDiscussion(let id):
            return id == abilityId
        case .abilityCreator:
            return false
        }
    }

    private func applyPresentation(reason: String) {
        TermLoopHooks.applyMainAreaPresentation(tabManager: tabManager, reason: reason)
    }

    private func abilityDetailSplit(abilityId: String) -> some View {
        GeometryReader { proxy in
            let terminalMinHeight: CGFloat = 160
            let detailMinHeight: CGFloat = 220
            let availableHeight = max(0, proxy.size.height - 1)
            let detailHeight = max(
                detailMinHeight,
                min(availableHeight - terminalMinHeight, availableHeight * 0.5)
            )
            let terminalHeight = max(terminalMinHeight, availableHeight - detailHeight)
            VStack(spacing: 0) {
                AbilityDetailPage(abilityId: abilityId)
                    .frame(maxWidth: .infinity)
                    .frame(height: detailHeight)
                Divider()
                content()
                    .frame(maxWidth: .infinity)
                    .frame(height: terminalHeight)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

    private var taskSelectionStore: TaskSelectionStore? {
        guard TermLoopSidebarTab(rawValue: tabRawValue) == .work,
              WorkSubTab(rawValue: workSubTabRaw) == .tasks,
              let windowId = AppDelegate.shared?.windowId(for: tabManager) else {
            return nil
        }
        return TaskSelectionStoreProvider.shared.store(for: windowId)
    }

    @ViewBuilder
    private func gitChangesSurface() -> some View {
        if let selection = taskSelectionStore,
           selection.inlineTerminalWorkspaceId != nil {
            TaskGitChangesWithInlineTerminal(selection: selection, tabManager: tabManager)
        } else {
            GitChangesMainAreaHost()
        }
    }

    var body: some View {
        Group {
            switch overlayMode {
            case .agents:
                overlayContainer { AgentsCatalogMainAreaView() }
            case let .ability(id):
                if shouldSplitAbilityDetail(abilityId: id) {
                    overlayContainer { abilityDetailSplit(abilityId: id) }
                } else {
                    overlayContainer { AbilityDetailPage(abilityId: id) }
                }
            case .markdownDocument:
                if let document = markdownDocument.document {
                    overlayContainer {
                        MarkdownDocumentSurface(
                            document: document,
                            onClose: { markdownDocument.close() }
                        )
                        .id(document.id)
                    }
                } else {
                    content()
                }
            case .gitChanges:
                overlayContainer {
                    gitChangesSurface()
                }
            case .contextBank:
                overlayContainer {
                    ContextBankRightPane(store: ContextBankStore.shared)
                }
            case .settings:
                overlayContainer {
                    TermLoopSettingsPage(onClose: { settingsPage.close() })
                }
            case .content:
                content()
            case .projectEmpty:
                overlayContainer { MainAreaProjectEmptyState() }
            case let .taskBoard(projectId):
                overlayContainer {
                    TaskBoardRouteHost(
                        projectId: projectId,
                        windowId: AppDelegate.shared?.windowId(for: tabManager)
                    )
                }
            }
        }
        .id(overlayMode.identity)
        .onAppear {
            applyPresentation(reason: "appear")
        }
        .onChange(of: overlayMode) { mode in
            applyPresentation(reason: "overlayMode.\(mode.identity)")
        }
        .onChange(of: tabManager.selectedTabId) { _ in
            applyPresentation(reason: "selectedWorkspace")
        }
        .onChange(of: workspaceMetadata.agentSessionVersion) { _ in
            applyPresentation(reason: "agentSessionVersion")
        }
        .onChange(of: tabRawValue) { _ in
            MainAreaPresentationCoordinator.shared.handleNavigationEvent(
                .sidebarTopTabChanged,
                tabManager: tabManager
            )
            applyPresentation(reason: "sidebarTopTab")
        }
        .onChange(of: workSubTabRaw) { _ in
            MainAreaPresentationCoordinator.shared.handleNavigationEvent(
                .workSubTabChanged,
                tabManager: tabManager
            )
            applyPresentation(reason: "workSubTab")
        }
        .onChange(of: projectStore.activeProjectId) { newValue in
            MainAreaPresentationCoordinator.shared.handleNavigationEvent(
                .projectChanged,
                tabManager: tabManager
            )
            applyPresentation(reason: "activeProject")
            TaskBoardReconcileHook.projectDidActivate(newValue)
        }
        .task {
            // Fires once when the host view appears with whatever activeProjectId
            // is currently restored — covers the bootstrap case where .onChange
            // does not fire for the initial value.
            TaskBoardReconcileHook.projectDidActivate(projectStore.activeProjectId)
        }
    }
}

/// Tasks can open Git Changes as the top pane while preserving an already
/// opened task-agent terminal underneath. The route is still `.gitChanges`;
/// only the Tasks-tab local split is reused.
@MainActor
private struct TaskGitChangesWithInlineTerminal: View {
    @ObservedObject var selection: TaskSelectionStore
    @ObservedObject var tabManager: TabManager

    var body: some View {
        if selection.inlineTerminalWorkspaceId != nil {
            HorizontalResizableSplit(
                topMinHeight: 320,
                bottomMinHeight: 260,
                bottomPreferredFraction: 0.35,
                top: { GitChangesMainAreaHost() },
                bottom: {
                    TaskBoardEmbeddedWorkspaceTerminal(
                        tabManager: tabManager,
                        workspaceId: selection.inlineTerminalWorkspaceId
                    )
                }
            )
            .onChange(of: selection.inlineTerminalWorkspaceId) { _, _ in
                TermLoopHooks.applyMainAreaPresentation(
                    tabManager: tabManager,
                    reason: "gitChanges.taskInlineTerminalWorkspace"
                )
            }
        } else {
            GitChangesMainAreaHost()
                .onAppear {
                    TermLoopHooks.applyMainAreaPresentation(
                        tabManager: tabManager,
                        reason: "gitChanges.taskInlineTerminalClosed"
                    )
                }
        }
    }
}

/// The store holds workspace ids (not `Workspace` values) because the
/// workspace can close while the overlay is presented. The enclosing
/// `.id(overlayMode.identity)` forces a fresh view when the user jumps
/// between workspaces — same `.id(run.id)` pattern as `UILayout.md`.
@MainActor
private struct GitChangesMainAreaHost: View {
    @ObservedObject private var store = GitChangesMainAreaStore.shared
    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared

    var body: some View {
        if let presentation = store.presentation,
           let tabManager = AppDelegate.shared?.tabManager,
           let workspace = resolvedWorkspace(for: presentation, in: tabManager) {
            WorktreeChangesSheet(
                workspace: workspace,
                branch: presentation.branch,
                worktreePath: presentation.worktreePath,
                preselectedPath: presentation.preselectedPath,
                baselineHead: presentation.baselineHead,
                onClose: { store.close() }
            )
        } else {
            ContentUnavailableView(
                String(
                    localized: "worktreeAgents.changes.unavailable.title",
                    defaultValue: "Workspace Unavailable",
                    table: "TermLoop"
                ),
                systemImage: "exclamationmark.triangle",
                description: Text(String(
                    localized: "worktreeAgents.changes.unavailable.body",
                    defaultValue: "This workspace closed before its Git changes could be shown.",
                    table: "TermLoop"
                ))
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onAppear { store.close() }
        }
    }

    private func resolvedWorkspace(
        for presentation: WorktreeChangesPresentation,
        in tabManager: TabManager
    ) -> Workspace? {
        if let exact = tabManager.tabs.first(where: { $0.id == presentation.workspaceId }) {
            return exact
        }
        guard let pathKey = TaskPathNormalization.resolveDisplayAndKey(presentation.worktreePath)?.keyPath else {
            return nil
        }
        return tabManager.tabs.first { workspace in
            workspacePathKeys(workspace).contains(pathKey)
        }
    }

    private func workspacePathKeys(_ workspace: Workspace) -> Set<String> {
        Set([
            metadataStore.worktreePath(forWorkspaceId: workspace.id),
            workspace.termLoopPresentationCwd(),
            workspace.currentDirectory
        ].compactMap { TaskPathNormalization.resolveDisplayAndKey($0)?.keyPath })
    }
}

// MARK: - Initial workspace git metadata

struct TermLoopInitialWorkspaceGitMetadataSnapshot {
    let branch: String?
    let isDirty: Bool
    let changes: [SidebarGitChangeItem]
}

extension TermLoopHooks {
    nonisolated static func initialWorkspaceGitMetadataSnapshot(
        directory: String
    ) -> TermLoopInitialWorkspaceGitMetadataSnapshot? {
        guard let snapshot = GitWorktreePresentationStore.shared.snapshot(for: directory) else {
            return nil
        }
        return TermLoopInitialWorkspaceGitMetadataSnapshot(
            branch: snapshot.branch,
            isDirty: snapshot.isDirty,
            changes: snapshot.files
        )
    }
}

// MARK: - Managed terminal git environment

extension TermLoopHooks {
    nonisolated static func applyManagedGitEnvironment(
        to environment: inout [String: String],
        protectedKeys: inout Set<String>
    ) {
        // Agent terminals frequently run read-only commands (`git status`,
        // `git diff`) right before write-side commands (`git add`, `commit`,
        // provider PR scripts). Git may refresh the index for those reads and
        // briefly create index.lock unless optional locks are disabled. Required
        // write locks are unaffected, so add/commit/merge still serialize
        // normally.
        environment["GIT_OPTIONAL_LOCKS"] = "0"
        protectedKeys.insert("GIT_OPTIONAL_LOCKS")
    }
}

// MARK: - Quick Action hotkey install

extension TermLoopHooks {
    /// Called once from `AppDelegate.applicationDidFinishLaunching(_:)` via a
    /// marker-wrapped one-liner. Installs the Shift-Shift global/local event
    /// monitor and prepares the palette for first use. Idempotent.
    static func installQuickActionHotkey() {
        QuickActionController.shared.install()
    }
}

// MARK: - Workspace focus helper

extension TermLoopHooks {
    /// Brings a workspace to the foreground: selects its tab inside the
    /// owning `TabManager` and raises the window that contains it. Used by
    /// the Active Agents sidebar so clicking an agent row reveals its
    /// Ghostty terminal — even when the workspace lives in a different
    /// termloop window than the sidebar the user clicked from.
    ///
    /// Cross-window safe: uses `AppDelegate.tabManagerFor(tabId:)` to find
    /// the correct `TabManager` instead of assuming the current window's
    /// one owns the workspace.
    static func focusWorkspace(workspaceId: UUID) -> Bool {
        guard let appDelegate = AppDelegate.shared else { return false }
        guard let targetTM = appDelegate.tabManagerFor(tabId: workspaceId) else { return false }
        // Always run through the helper — even when this workspace is
        // already selected, an open overlay (AbilityDetail / Markdown
        // document / GitChanges) would otherwise outlive the focus
        // intent. The helper dedupes `selectedTabId` internally.
        MainAreaActivation.activateWorkspaceTerminal(workspaceId, on: targetTM)
        if let wid = appDelegate.windowId(for: targetTM) {
            _ = appDelegate.focusMainWindow(windowId: wid)
        }
        return true
    }


    static func selectWorkspaceForTaskBoard(workspaceId: UUID) -> Bool {
        guard let appDelegate = AppDelegate.shared else { return false }
        guard let targetTM = appDelegate.tabManagerFor(tabId: workspaceId) else { return false }
        if targetTM.selectedTabId != workspaceId {
            targetTM.selectedTabId = workspaceId
        }
        if let wid = appDelegate.windowId(for: targetTM) {
            _ = appDelegate.focusMainWindow(windowId: wid)
        }
        TermLoopHooks.applyMainAreaPresentation(
            tabManager: targetTM,
            reason: "taskBoardInlineWorkspaceActivation"
        )
        return true
    }

    static func presentTaskAgentQuickAction(workspaceId: UUID) {
        QuickActionController.shared.present(
            prefill: QuickActionPresentationRequest(
                initialSurface: .run,
                targetWorkspaceId: workspaceId,
                promptText: nil,
                launchSource: .quickAction,
                reasonTag: "quickAction.freePrompt"
            )
        )
    }

    static func presentTaskAgentQuickAction(
        context: TaskAgentLaunchContext,
        onLaunchedWorkspaceId: ((UUID) -> Void)? = nil
    ) {
        QuickActionController.shared.present(
            prefill: QuickActionPresentationRequest(
                initialSurface: .run,
                promptText: nil,
                launchSource: .quickAction,
                reasonTag: "quickAction.freePrompt",
                projectId: context.projectId,
                runTarget: .worktree(
                    projectId: context.projectId,
                    path: context.cwdPath,
                    branch: context.branchName,
                    workspaceId: context.targetWorkspaceId,
                ),
                onLaunchedWorkspace: { workspace in
                    onLaunchedWorkspaceId?(workspace.id)
                }
            )
        )
    }

    static func focusAbilityWorkspace(workspaceId: UUID, abilityId: String) {
        guard let appDelegate = AppDelegate.shared else { return }
        guard let targetTM = appDelegate.tabManagerFor(tabId: workspaceId) else { return }
        MainAreaActivation.activateAbilityWorkspaceTerminal(
            workspaceId,
            abilityId: abilityId,
            on: targetTM
        )
        if let wid = appDelegate.windowId(for: targetTM) {
            _ = appDelegate.focusMainWindow(windowId: wid)
        }
    }
}

#if DEBUG
import Combine

/// Instruments each root-level `@StateObject` publisher in `TermLoopApp` with a
/// `dlog()` tick so we can count who ticks how often during normal app use.
/// Enabled only in DEBUG builds; entirely removed in release.
///
/// Usage (in `termloopApp.swift` body, inside `WindowGroup { ContentView(...) ... }`):
/// ```
/// // MARK: termloop-hook
/// .background(TermLoopRootTickInstrumentation(
///     tabManager: tabManager,
///     notificationStore: notificationStore,
///     sidebarState: sidebarState,
///     sidebarSelectionState: sidebarSelectionState,
///     fileExplorerState: fileExplorerState,
///     termloopConfigStore: termloopConfigStore
/// ))
/// // MARK: /termloop-hook
/// ```
@MainActor
struct TermLoopRootTickInstrumentation: View {
    let tabManager: TabManager
    let notificationStore: TerminalNotificationStore
    let sidebarState: SidebarState
    let sidebarSelectionState: SidebarSelectionState
    let fileExplorerState: FileExplorerState
    let termloopConfigStore: CmuxConfigStore

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .allowsHitTesting(false)
            .onReceive(tabManager.objectWillChange) { _ in
                dlog("roottick.tabManager")
            }
            .onReceive(notificationStore.objectWillChange) { _ in
                dlog("roottick.notificationStore")
            }
            .onReceive(sidebarState.objectWillChange) { _ in
                dlog("roottick.sidebarState")
            }
            .onReceive(sidebarSelectionState.objectWillChange) { _ in
                dlog("roottick.sidebarSelectionState")
            }
            .onReceive(fileExplorerState.objectWillChange) { _ in
                dlog("roottick.fileExplorerState")
            }
            .onReceive(termloopConfigStore.objectWillChange) { _ in
                dlog("roottick.termloopConfigStore")
            }
    }
}
#endif

/// Per-workspace throttle fronting `PortScanner.scanAgentPorts(...)`.
///
/// User interactions (tab clicks, shell activity) call
/// `PortScanner.refreshAgentPortsLocked(workspaceId:agentPIDs:)` which
/// fork+execs `ps` + `lsof` on every invocation. When the user rapidly
/// switches between agents, these requests come in bursts, saturating
/// main thread with process-list parsing. This throttle collapses
/// repeat calls for the same workspace within `cooldown` seconds into a
/// single scan.
///
/// Thread safety: caller (`PortScanner.queue`) is a serial utility queue;
/// a simple lock is enough.
enum TermLoopPortScanThrottle {
    private static let cooldown: TimeInterval = 1.0

    nonisolated(unsafe) private static var lastScanAt: [UUID: Date] = [:]
    private static let lock = NSLock()

    /// Returns `true` when the caller should proceed with the scan, `false`
    /// when the previous scan for this workspace completed less than
    /// `cooldown` seconds ago.
    static func shouldScan(workspaceId: UUID) -> Bool {
        let now = Date()
        lock.lock()
        defer { lock.unlock() }
        if let previous = lastScanAt[workspaceId], now.timeIntervalSince(previous) < cooldown {
            return false
        }
        lastScanAt[workspaceId] = now
        pruneExpiredLocked(now: now)
        return true
    }

    private static func pruneExpiredLocked(now: Date) {
        guard lastScanAt.count > 128 else { return }
        lastScanAt = lastScanAt.filter { now.timeIntervalSince($0.value) < cooldown * 8 }
    }
}

@MainActor
private enum TermLoopDeferredWorkspaceRestore {
    private struct RestoreContext {
        var nextIndex: Int = 0
        let selectedIndex: Int
        let totalCount: Int
    }

    // Keep smaller restored sessions eager. The defer path saves a lot for
    // large tab sets, but eager restore is more stable for normal-sized
    // sessions because agent resume commands can run with their panels already
    // present.
    private static let eagerRestoreWorkspaceLimit = 9
    // Wait for the selected workspace's restore/layout to settle, then drain
    // one deferred workspace at a time so surface-ready and agent restore
    // callbacks are not burst-scheduled on the main actor.
    private static let backgroundMaterializeInitialDelay: TimeInterval = 5.0
    private static let backgroundMaterializeStepDelay: TimeInterval = 5.0
    private static var contextsByTabManager: [ObjectIdentifier: RestoreContext] = [:]
    private static var snapshotsByWorkspaceId: [UUID: SessionWorkspaceSnapshot] = [:]
    private static var backgroundMaterializeQueue: [UUID] = []
    private static var isBackgroundMaterializePumpScheduled = false

    static func begin(
        tabManager: TabManager,
        selectedWorkspaceIndex: Int?,
        totalWorkspaceCount: Int
    ) {
        let cappedTotalCount = min(totalWorkspaceCount, SessionPersistencePolicy.maxWorkspacesPerWindow)
        guard cappedTotalCount > 0 else {
            contextsByTabManager.removeValue(forKey: ObjectIdentifier(tabManager))
            return
        }
        let selectedIndex: Int = {
            guard let selectedWorkspaceIndex,
                  selectedWorkspaceIndex >= 0,
                  selectedWorkspaceIndex < cappedTotalCount else {
                return 0
            }
            return selectedWorkspaceIndex
        }()
        contextsByTabManager[ObjectIdentifier(tabManager)] = RestoreContext(
            selectedIndex: selectedIndex,
            totalCount: cappedTotalCount
        )
    }

    static func restore(
        workspace: Workspace,
        snapshot: SessionWorkspaceSnapshot,
        tabManager: TabManager
    ) {
        let tabManagerKey = ObjectIdentifier(tabManager)
        guard var context = contextsByTabManager[tabManagerKey] else {
            workspace.restoreSessionSnapshot(snapshot)
            return
        }

        let index = context.nextIndex
        context.nextIndex += 1
        if context.nextIndex >= context.totalCount {
            contextsByTabManager.removeValue(forKey: tabManagerKey)
        } else {
            contextsByTabManager[tabManagerKey] = context
        }

        guard shouldDefer(index: index, context: context) else {
            workspace.restoreSessionSnapshot(snapshot)
            return
        }

        applyPlaceholderMetadata(to: workspace, snapshot: snapshot)
        snapshotsByWorkspaceId[workspace.id] = snapshot
#if DEBUG
        dlog(
            "session.restore.deferWorkspace workspace=\(workspace.id.uuidString.prefix(8)) " +
            "index=\(index) selectedIndex=\(context.selectedIndex) total=\(context.totalCount) " +
            "queue=\(backgroundMaterializeQueue.count) remaining=\(snapshotsByWorkspaceId.count)"
        )
#endif
    }

    static func materializeIfNeeded(workspace: Workspace) {
        backgroundMaterializeQueue.removeAll { $0 == workspace.id }
        _ = materialize(workspace: workspace, trigger: "selection")
    }

    @discardableResult
    private static func materialize(workspace: Workspace, trigger: String) -> Bool {
        guard let snapshot = snapshotsByWorkspaceId.removeValue(forKey: workspace.id) else {
            return false
        }
#if DEBUG
        let startedAt = ProcessInfo.processInfo.systemUptime
        dlog("session.restore.materializeWorkspace.start workspace=\(workspace.id.uuidString.prefix(8)) trigger=\(trigger)")
#endif
        workspace.restoreSessionSnapshot(snapshot)
        TerminalAgentLifecycle.restoreWorkspaces(
            [workspace],
            autoRestoreClaude: TermLoopHooks.isClaudeAutoRestoreEnabled()
        )
        TermLoopHooks.scheduleStartupAgentRestoreSelfHeal(workspaces: [workspace])
#if DEBUG
        let elapsedMs = (ProcessInfo.processInfo.systemUptime - startedAt) * 1000
        dlog(
            "session.restore.materializeWorkspace.finish workspace=\(workspace.id.uuidString.prefix(8)) " +
            "ms=\(String(format: "%.2f", elapsedMs)) remaining=\(snapshotsByWorkspaceId.count) " +
            "queue=\(backgroundMaterializeQueue.count) trigger=\(trigger)"
        )
#endif
        return true
    }

    static func scheduleBackgroundMaterialization(for workspaces: [Workspace]) {
        pruneClosedSnapshots()
        let knownQueuedIds = Set(backgroundMaterializeQueue)
        let newIds = workspaces
            .map(\.id)
            .filter {
                snapshotsByWorkspaceId[$0] != nil
                    && !knownQueuedIds.contains($0)
                    && WorkspaceMetadataStore.shared.metadata(forWorkspaceId: $0).persistedAgentSession != nil
            }
        guard !newIds.isEmpty else { return }
        backgroundMaterializeQueue.append(contentsOf: newIds)
#if DEBUG
        dlog(
            "session.restore.background.enqueue added=\(newIds.count) " +
            "queue=\(backgroundMaterializeQueue.count) remaining=\(snapshotsByWorkspaceId.count)"
        )
#endif
        scheduleBackgroundMaterializePump(after: backgroundMaterializeInitialDelay)
    }

    private static func scheduleBackgroundMaterializePump(after delay: TimeInterval) {
        guard !isBackgroundMaterializePumpScheduled else { return }
        isBackgroundMaterializePumpScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            Task { @MainActor in
                isBackgroundMaterializePumpScheduled = false
                materializeNextBackgroundWorkspace()
            }
        }
    }

    private static func materializeNextBackgroundWorkspace() {
        pruneClosedSnapshots()
        while !backgroundMaterializeQueue.isEmpty {
            let workspaceId = backgroundMaterializeQueue.removeFirst()
            guard snapshotsByWorkspaceId[workspaceId] != nil else { continue }
            guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
                discard(workspaceId: workspaceId)
                continue
            }
            _ = materialize(workspace: workspace, trigger: "background")
            break
        }
        if !backgroundMaterializeQueue.isEmpty {
            scheduleBackgroundMaterializePump(after: backgroundMaterializeStepDelay)
        }
    }

    static func sessionSnapshot(
        for workspace: Workspace,
        includeScrollback: Bool
    ) -> SessionWorkspaceSnapshot {
        pruneClosedSnapshots()
        guard var deferredSnapshot = snapshotsByWorkspaceId[workspace.id] else {
            return workspace.sessionSnapshot(includeScrollback: includeScrollback)
        }

        deferredSnapshot.customTitle = workspace.customTitle
        deferredSnapshot.customDescription = workspace.customDescription
        deferredSnapshot.customColor = workspace.customColor
        deferredSnapshot.isPinned = workspace.isPinned
        deferredSnapshot.currentDirectory = workspace.currentDirectory
        deferredSnapshot.termLoopRestoreId = workspace.termLoopRestoreId
        // Match `Workspace.restoreSessionSnapshot`: status entries, agent
        // PIDs, and listening ports are ephemeral runtime state and should not
        // be re-persisted from a previous process while the workspace is still
        // only a placeholder.
        deferredSnapshot.statusEntries = []
        if !includeScrollback {
            stripTerminalScrollback(from: &deferredSnapshot)
        }
        deferredSnapshot.logEntries = workspace.logEntries.map { entry in
            SessionLogEntrySnapshot(
                message: entry.message,
                level: entry.level.rawValue,
                source: entry.source,
                timestamp: entry.timestamp.timeIntervalSince1970
            )
        }
        deferredSnapshot.progress = workspace.progress.map {
            SessionProgressSnapshot(value: $0.value, label: $0.label)
        }
        deferredSnapshot.gitBranch = workspace.gitBranch.map {
            SessionGitBranchSnapshot(branch: $0.branch, isDirty: $0.isDirty)
        }
        return deferredSnapshot
    }

    static func isDeferred(workspace: Workspace) -> Bool {
        snapshotsByWorkspaceId[workspace.id] != nil
    }

    static func discard(workspaceId: UUID) {
        snapshotsByWorkspaceId.removeValue(forKey: workspaceId)
        backgroundMaterializeQueue.removeAll { $0 == workspaceId }
    }

    private static func pruneClosedSnapshots() {
        guard !snapshotsByWorkspaceId.isEmpty,
              let openWorkspaces = AppDelegate.shared?.termLoopOpenWorkspacesInPersistenceOrder() else {
            return
        }
        let openIds = Set(openWorkspaces.map(\.id))
        snapshotsByWorkspaceId = snapshotsByWorkspaceId.filter { openIds.contains($0.key) }
        backgroundMaterializeQueue.removeAll { !openIds.contains($0) }
    }

    private static func stripTerminalScrollback(from snapshot: inout SessionWorkspaceSnapshot) {
        for index in snapshot.panels.indices {
            guard var terminal = snapshot.panels[index].terminal else { continue }
            terminal.scrollback = nil
            snapshot.panels[index].terminal = terminal
        }
    }

    private static func shouldDefer(index: Int, context: RestoreContext) -> Bool {
        context.totalCount > eagerRestoreWorkspaceLimit && index != context.selectedIndex
    }

    private static func applyPlaceholderMetadata(
        to workspace: Workspace,
        snapshot: SessionWorkspaceSnapshot
    ) {
        let normalizedCurrentDirectory = snapshot.currentDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedCurrentDirectory.isEmpty {
            workspace.currentDirectory = normalizedCurrentDirectory
        }
        workspace.applyProcessTitle(snapshot.processTitle)
        workspace.setCustomTitle(snapshot.customTitle)
        workspace.setCustomDescription(snapshot.customDescription)
        workspace.setCustomColor(snapshot.customColor)
        workspace.applyTermLoopRestoreId(snapshot.termLoopRestoreId)
        workspace.isPinned = snapshot.isPinned
        workspace.statusEntries.removeAll()
        workspace.agentPIDs.removeAll()
        workspace.agentListeningPorts.removeAll()
        workspace.logEntries = snapshot.logEntries.map { entry in
            SidebarLogEntry(
                message: entry.message,
                level: SidebarLogLevel(rawValue: entry.level) ?? .info,
                source: entry.source,
                timestamp: Date(timeIntervalSince1970: entry.timestamp)
            )
        }
        workspace.progress = snapshot.progress.map {
            SidebarProgressState(value: $0.value, label: $0.label)
        }
        workspace.gitBranch = snapshot.gitBranch.map {
            SidebarGitBranchState(branch: $0.branch, isDirty: $0.isDirty)
        }
    }
}

/// Gates the expensive pre-dispatch v2 handle-ref refresh.
///
/// `TerminalController.processV2Command` historically refreshed every known
/// window/workspace/pane/surface ref before every v2 JSON command. During
/// startup restore, bursts of MCP/mobile commands can all synchronously enter
/// the main queue while SwiftUI is laying out restored tabs. This gate skips
/// commands that cannot depend on handle refs and coalesces the remaining
/// refreshes into a short window.
enum TermLoopV2KnownRefsRefreshGate {
    private static let cooldown: TimeInterval = 0.35

    nonisolated(unsafe) private static var lastRefreshUptime: TimeInterval = 0
    private static let lock = NSLock()

    static func refreshIfNeeded(method: String, refresh: () -> Void) {
        guard mayNeedKnownRefs(method: method) else { return }

        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        let shouldRefresh = now - lastRefreshUptime >= cooldown
        if shouldRefresh {
            lastRefreshUptime = now
        }
        lock.unlock()

        guard shouldRefresh else { return }
        refresh()
    }

    private static func mayNeedKnownRefs(method: String) -> Bool {
        let normalized = method
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !normalized.isEmpty else { return false }

        if normalized.hasPrefix("agent.")
            || normalized.hasPrefix("project.")
            || normalized.hasPrefix("worktree.")
            || normalized.hasPrefix("push.")
            || normalized.hasPrefix("system.") {
            return false
        }

        switch normalized {
        case "events.subscribe",
             "events.unsubscribe",
             "internal.hook_event",
             "workspace.report_agent_activity",
             "workspace.get_jira_ticket",
             "workspace.report_claude_session",
             "workspace.clear_agent_activity",
             "workspace.clear_attention",
             "workspace.clear_claude_session",
             "workspace.kill_claude_session",
             "workspace.prepare_claude_resume",
             "workspace.spawn_claude_session",
             "workspace.agent_system_prompt":
            return false
        default:
            return true
        }
    }
}

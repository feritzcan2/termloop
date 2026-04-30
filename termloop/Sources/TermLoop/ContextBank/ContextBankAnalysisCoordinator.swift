// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Owns the lifecycle of curator-fork analyses: native-fork dispatch,
/// receiving suggestions through the termloop MCP server, and result
/// handoff to `ContextBankStore`. A single coordinator handles runs
/// across all projects so the store stays UI-facing.
///
/// The curator calls the `context_bank_propose_suggestion` and
/// `context_bank_finalize_run` MCP tools. The termloop CLI's MCP
/// server forwards each call to the running app via the Unix socket;
/// the socket dispatcher routes them here through `receiveProposal` /
/// `finalizeRun`.
@MainActor
final class ContextBankAnalysisCoordinator {
    static let shared = ContextBankAnalysisCoordinator()

    enum StartError: Error, LocalizedError {
        case noSourceSession
        case unsupportedAgent(String)
        case noTabManager
        case noProjectRoot
        case alreadyRunning
        case forkLaunchFailed(Error)

        var errorDescription: String? {
            switch self {
            case .noSourceSession:
                return "Selected workspace has no resolvable agent session yet."
            case .unsupportedAgent(let id):
                return "Send to Analyze is not supported for agent \"\(id)\" yet."
            case .noTabManager:
                return "Tab manager unavailable."
            case .noProjectRoot:
                return "Could not resolve a project root for this workspace."
            case .alreadyRunning:
                return "An analysis is already running for this project. Wait for it to finish or close its fork tab before starting another."
            case .forkLaunchFailed(let error):
                return "Fork launch failed: \(error.localizedDescription)"
            }
        }
    }

    enum ProposalError: Error, LocalizedError {
        case unknownRun(UUID)
        case missingRunContext
        case noMatchingRunForCwd(String)
        case ambiguousRunForCwd(String)
        case pathOutsideProject(String)
        case invalidContextFileName(String)
        case missingRequiredFile(String)

        var errorDescription: String? {
            switch self {
            case .unknownRun(let id):
                return "No active Context Bank analysis run owns workspace \(id.uuidString). Start from Send to Analyze before calling context_bank tools."
            case .missingRunContext:
                return "Context Bank tool call needs TERMLOOP_WORKSPACE_ID or a current working directory inside a project with one active analysis run."
            case .noMatchingRunForCwd(let cwd):
                return "No active Context Bank analysis run matches current working directory: \(cwd)"
            case .ambiguousRunForCwd(let cwd):
                return "Multiple active Context Bank analysis runs match current working directory: \(cwd)"
            case .pathOutsideProject(let path):
                return "Context Bank suggestions must target files inside the analyzed project: \(path)"
            case .invalidContextFileName(let path):
                return "Context Bank suggestions may only target CLAUDE.md, AGENTS.md, or GEMINI.md files: \(path)"
            case .missingRequiredFile(let path):
                return "Context Bank suggestion references a file that does not exist: \(path)"
            }
        }
    }

    private struct ActiveRun {
        var run: ContextBankAnalysisRun
        var watchdogTask: Task<Void, Never>
        /// Suggestions accumulated via MCP tool calls during this run.
        /// Flushed to the store on `finalizeRun` (or, on timeout, whatever
        /// arrived gets published with a `.timeout` phase).
        var pendingSuggestions: [ContextBankSuggestion] = []
    }

    private var runsByForkWorkspaceId: [UUID: ActiveRun] = [:]

    /// Maximum time we'll wait for the curator to call `finalize_run`
    /// before timing out. Generous because tool-call mode includes the
    /// curator's thinking time end-to-end.
    private let analysisDeadline: TimeInterval = 15 * 60
    /// Watchdog tick — checks fork-still-open + deadline.
    private let watchdogInterval: UInt64 = 5_000_000_000

    private init() {}

    /// Set of workspace IDs that are currently curator forks (active runs).
    /// The Loop tab's active-agents panel uses this to suppress these
    /// fork tabs from its own listing — they're surfaced exclusively in
    /// the Context Bank "Analysis Agents" panel. Terminal-phase forks are
    /// removed from the set on `finishTerminal` so a closed run no longer
    /// suppresses anything.
    var activeCuratorForkWorkspaceIds: Set<UUID> {
        Set(runsByForkWorkspaceId.keys)
    }

    // MARK: - Public surface

    /// Starts a curator-fork analysis for `source`. Returns the run on
    /// success; on failure throws a typed error the menu can surface.
    @discardableResult
    func startAnalyze(forking source: Workspace) throws -> ContextBankAnalysisRun {
        guard let sessionRef = WorkspaceSessionReferenceResolver.resolve(for: source) else {
            throw StartError.noSourceSession
        }
        guard AssistantSessionScannerRegistry.supports(agentId: sessionRef.agentId) else {
            throw StartError.unsupportedAgent(sessionRef.agentId)
        }
        guard let agent = TerminalAgentRegistry.shared.agent(id: sessionRef.agentId) else {
            throw StartError.unsupportedAgent(sessionRef.agentId)
        }
        guard let tabManager = AppDelegate.shared?.tabManager else {
            throw StartError.noTabManager
        }
        let projectRoot = Self.resolveProjectRoot(for: source)
            ?? ContextBankStore.shared.activeProjectRootURL
        guard let projectRoot else {
            throw StartError.noProjectRoot
        }
        // Same-project concurrent runs would let one run's publishSuggestions
        // drop the other's still-pending proposals (the bucket is keyed by
        // projectRoot, not by run). Reject the second start until the first
        // run finalizes or its fork tab is closed.
        if runsByForkWorkspaceId.values.contains(where: { $0.run.projectRoot == projectRoot }) {
            throw StartError.alreadyRunning
        }
        let projectId = ProjectStore.shared.project(containingPath: projectRoot.path)?.id
            ?? ProjectStore.shared.activeProjectId

        let files = ContextBankIndexer.scan(projectRoot: projectRoot)
        let rejections = ContextBankDecisionLog.shared.recentRejections(forProjectRoot: projectRoot)
        let acceptances = ContextBankDecisionLog.shared.recentAcceptances(forProjectRoot: projectRoot)
        let userPrompt = ContextBankPrompt.userPromptForFork(
            files: files,
            recentRejections: rejections,
            recentAcceptances: acceptances,
            projectRoot: projectRoot
        )

        // Curator forks run in the background; the user's source tab must
        // stay selected, and the fork only surfaces in the Context Bank
        // "Analysis Agents" panel. `select: false` plumbs through to
        // `tabManager.addWorkspace` so the new tab never becomes the
        // selected one. Loop-tab and active-agents filtering are handled
        // separately via `activeCuratorForkWorkspaceIds`.
        let fork: Workspace
        do {
            fork = try TerminalAgentLifecycle.forkWorkspace(
                tabManager: tabManager,
                from: source,
                with: agent,
                parentSessionId: sessionRef.sessionId,
                title: Self.forkTitle(for: source),
                initialPrompt: userPrompt,
                systemPrompt: ContextBankPrompt.systemPrompt,
                permission: .plan,
                select: false
            )
        } catch {
            throw StartError.forkLaunchFailed(error)
        }

        let run = ContextBankAnalysisRun(
            projectRoot: projectRoot,
            projectId: projectId,
            sourceWorkspaceId: source.id,
            sourceSessionId: sessionRef.sessionId,
            agentId: sessionRef.agentId,
            forkWorkspaceId: fork.id
        )
        let watchdog: Task<Void, Never> = Task { [weak self] in
            guard let self else { return }
            await self.runWatchdog(forkWorkspaceId: fork.id)
        }
        runsByForkWorkspaceId[fork.id] = ActiveRun(run: run, watchdogTask: watchdog)
        ContextBankStore.shared.notifyRunStarted(forProjectRoot: projectRoot)
        publishSnapshot(forForkWorkspaceId: fork.id)
        return run
    }

    /// Builds the UI-facing snapshot from the live ActiveRun + fork
    /// workspace title and pushes it to the store. Called whenever any
    /// observable property of a run changes (start, proposal received,
    /// finalize, terminal transition).
    private func publishSnapshot(forForkWorkspaceId forkWorkspaceId: UUID) {
        guard let active = runsByForkWorkspaceId[forkWorkspaceId] else { return }
        let sourceTitle: String = {
            if let source = AppDelegate.shared?.tabManager?.tabs
                .first(where: { $0.id == active.run.sourceWorkspaceId }) {
                let trimmed = source.customTitle?.trimmingCharacters(in: .whitespaces) ?? ""
                return trimmed.isEmpty ? source.title : trimmed
            }
            return "Unknown source"
        }()
        let snapshot = ContextBankRunSnapshot(
            id: active.run.forkWorkspaceId,
            projectRoot: active.run.projectRoot,
            sourceWorkspaceTitle: sourceTitle,
            agentId: active.run.agentId,
            phase: active.run.phase,
            suggestionCount: active.pendingSuggestions.count,
            startedAt: active.run.startedAt,
            endedAt: active.run.isTerminal ? Date() : nil
        )
        ContextBankStore.shared.upsertRun(
            snapshot,
            forProjectRoot: active.run.projectRoot
        )
    }

    /// Curator called `context_bank_propose_suggestion`. Append to the
    /// run's buffer; surface to the store at finalize time. Suggestions
    /// arriving for an unknown fork (run already terminated, or the call
    /// came from a non-curator workspace) are rejected so the MCP tool
    /// can report a real error instead of pretending a card was created.
    func receiveProposal(
        _ suggestion: ContextBankSuggestion,
        forForkWorkspaceId forkWorkspaceId: UUID
    ) throws {
        guard var active = runsByForkWorkspaceId[forkWorkspaceId] else {
            throw ProposalError.unknownRun(forkWorkspaceId)
        }
        try validateSuggestion(suggestion, for: active.run)
        active.pendingSuggestions.append(suggestion)
        runsByForkWorkspaceId[forkWorkspaceId] = active
        publishSnapshot(forForkWorkspaceId: forkWorkspaceId)
    }

    /// Source session id to stamp onto suggestions emitted by the fork.
    /// The MCP call only carries the fork workspace id; the original
    /// source session is run metadata.
    func sourceSessionId(forForkWorkspaceId forkWorkspaceId: UUID) -> String? {
        runsByForkWorkspaceId[forkWorkspaceId]?.run.sourceSessionId
    }

    /// Resolve the active curator fork for a Context Bank MCP call. The
    /// workspace id from the agent environment is authoritative. If it is
    /// absent, fall back to the MCP server's cwd and the invariant that a
    /// project can have at most one active analysis run.
    func resolveForkWorkspaceId(
        explicitWorkspaceId: UUID?,
        cwd: String?
    ) throws -> UUID {
        if let explicitWorkspaceId {
            guard runsByForkWorkspaceId[explicitWorkspaceId] != nil else {
                throw ProposalError.unknownRun(explicitWorkspaceId)
            }
            return explicitWorkspaceId
        }

        guard let cwd = Self.normalizedPath(cwd), !cwd.isEmpty else {
            throw ProposalError.missingRunContext
        }

        let matches = runsByForkWorkspaceId.values.compactMap { active -> (ActiveRun, Int)? in
            guard let score = Self.runMatchScore(active, forCwd: cwd) else { return nil }
            return (active, score)
        }.sorted { lhs, rhs in
            if lhs.1 == rhs.1 {
                return lhs.0.run.forkWorkspaceId.uuidString < rhs.0.run.forkWorkspaceId.uuidString
            }
            return lhs.1 > rhs.1
        }

        guard let best = matches.first else {
            throw ProposalError.noMatchingRunForCwd(cwd)
        }
        if matches.dropFirst().first?.1 == best.1 {
            throw ProposalError.ambiguousRunForCwd(cwd)
        }
        return best.0.run.forkWorkspaceId
    }

    /// Curator called `context_bank_finalize_run`. Flush the buffered
    /// suggestions to the store and tear down the run.
    @discardableResult
    func finalizeRun(
        forForkWorkspaceId forkWorkspaceId: UUID,
        summary: String? = nil
    ) -> Bool {
        guard let active = runsByForkWorkspaceId[forkWorkspaceId] else { return false }
        let projectRoot = active.run.projectRoot
        let count = active.pendingSuggestions.count
        ContextBankStore.shared.publishSuggestions(
            active.pendingSuggestions,
            forProjectRoot: projectRoot
        )
        finishTerminal(
            forkWorkspaceId: forkWorkspaceId,
            phase: .completed(suggestionCount: count)
        )
        _ = summary  // reserved for a future activity log entry
        return true
    }

    func cancel(forkWorkspaceId: UUID) {
        guard var active = runsByForkWorkspaceId[forkWorkspaceId] else { return }
        active.run.phase = .cancelled
        runsByForkWorkspaceId[forkWorkspaceId] = active
        publishSnapshot(forForkWorkspaceId: forkWorkspaceId)
        active.watchdogTask.cancel()
        runsByForkWorkspaceId.removeValue(forKey: forkWorkspaceId)
        ContextBankStore.shared.notifyRunEnded(forProjectRoot: active.run.projectRoot)
    }

    func cancelAll(forProjectRoot projectRoot: URL) {
        let matching = runsByForkWorkspaceId.values.filter { $0.run.projectRoot == projectRoot }
        for entry in matching {
            cancel(forkWorkspaceId: entry.run.forkWorkspaceId)
        }
    }

    /// Called by `TabManager` integration when a workspace is removed.
    /// No-op when the closed workspace is not a curator fork.
    func handleWorkspaceClosed(workspaceId: UUID) {
        cancel(forkWorkspaceId: workspaceId)
    }

    // MARK: - Watchdog

    /// Watches for fork-closed and deadline expiry. Tool calls flow
    /// through `receiveProposal` / `finalizeRun` directly — the
    /// watchdog's only job is making sure abandoned runs don't sit in
    /// the map forever.
    private func runWatchdog(forkWorkspaceId: UUID) async {
        guard let initial = runsByForkWorkspaceId[forkWorkspaceId] else { return }
        let deadline = initial.run.startedAt.addingTimeInterval(analysisDeadline)
        while !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: watchdogInterval)
            guard runsByForkWorkspaceId[forkWorkspaceId] != nil else { return }
            if Self.workspace(forId: forkWorkspaceId) == nil {
                finishTerminal(forkWorkspaceId: forkWorkspaceId, phase: .cancelled)
                return
            }
        }
        guard !Task.isCancelled else { return }
        // Timeout: publish any partial proposals so the user sees what
        // the curator managed before going quiet, then mark .timeout.
        if let active = runsByForkWorkspaceId[forkWorkspaceId],
           !active.pendingSuggestions.isEmpty {
            ContextBankStore.shared.publishSuggestions(
                active.pendingSuggestions,
                forProjectRoot: active.run.projectRoot
            )
        }
        finishTerminal(forkWorkspaceId: forkWorkspaceId, phase: .timeout)
    }

    private func finishTerminal(
        forkWorkspaceId: UUID,
        phase: ContextBankAnalysisRun.Phase
    ) {
        updatePhase(forkWorkspaceId: forkWorkspaceId, to: phase)
        let active = runsByForkWorkspaceId.removeValue(forKey: forkWorkspaceId)
        active?.watchdogTask.cancel()
        guard let projectRoot = active?.run.projectRoot else { return }
        let errorMessage: String? = {
            switch phase {
            case .malformed(let reason):
                return String(
                    localized: "contextBank.analyze.error.malformed",
                    defaultValue: "Curator response was malformed: \(reason)",
                    table: "TermLoop"
                )
            case .timeout:
                return String(
                    localized: "contextBank.analyze.error.timeout",
                    defaultValue: "Curator did not return a parseable response in time.",
                    table: "TermLoop"
                )
            case .completed, .cancelled, .running:
                return nil
            }
        }()
        ContextBankStore.shared.notifyRunEnded(
            forProjectRoot: projectRoot,
            error: errorMessage
        )
    }

    private func updatePhase(
        forkWorkspaceId: UUID,
        to phase: ContextBankAnalysisRun.Phase
    ) {
        guard var active = runsByForkWorkspaceId[forkWorkspaceId] else { return }
        active.run.phase = phase
        runsByForkWorkspaceId[forkWorkspaceId] = active
        publishSnapshot(forForkWorkspaceId: forkWorkspaceId)
    }

    // MARK: - Helpers

    private static func workspace(forId id: UUID) -> Workspace? {
        AppDelegate.shared?.tabManager?.tabs.first(where: { $0.id == id })
    }

    private static func normalizedPath(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return URL(fileURLWithPath: (trimmed as NSString).expandingTildeInPath)
            .standardizedFileURL
            .path
    }

    private static func path(_ candidate: String, isInside root: String) -> Bool {
        let normalizedCandidate = normalizedPath(candidate) ?? candidate
        let normalizedRoot = normalizedPath(root) ?? root
        return normalizedCandidate == normalizedRoot
            || normalizedCandidate.hasPrefix(normalizedRoot + "/")
    }

    private static func runMatchScore(_ active: ActiveRun, forCwd cwd: String) -> Int? {
        var best: Int?

        func consider(root: String, bonus: Int = 0) {
            guard let normalizedRoot = normalizedPath(root), path(cwd, isInside: normalizedRoot) else { return }
            let score = bonus + normalizedRoot.count
            best = max(best ?? Int.min, score)
        }

        let projectRoot = active.run.projectRoot.path

        // Curator forks normally run in a terminal cwd/worktree under the
        // project root. Prefer the fork's actual cwd when available; it
        // uniquely identifies the live run and avoids title/position
        // heuristics.
        if let fork = workspace(forId: active.run.forkWorkspaceId) {
            if let spawnCwd = try? fork.termLoopSpawnCwd() {
                consider(root: spawnCwd, bonus: 2_000_000)
            }
            consider(root: fork.currentDirectory, bonus: 2_000_000)
        }

        if let worktreeRoot = WorktreeResolver.worktreeRoot(
            containing: cwd,
            projectFolder: projectRoot
        ) {
            consider(root: worktreeRoot, bonus: 1_000_000)
        }

        consider(root: projectRoot)
        return best
    }

    private static func resolveProjectRoot(for workspace: Workspace) -> URL? {
        let cwd = (try? workspace.termLoopSpawnCwd()) ?? workspace.currentDirectory
        guard !cwd.isEmpty else { return nil }
        if let project = ProjectStore.shared.project(containingPath: cwd) {
            return URL(fileURLWithPath: project.folderPath)
        }
        return URL(fileURLWithPath: cwd)
    }

    private static func forkTitle(for source: Workspace) -> String {
        let trimmed = source.customTitle?.trimmingCharacters(in: .whitespaces) ?? ""
        let base = trimmed.isEmpty ? source.title : trimmed
        return String(
            localized: "contextBank.analyze.forkTitlePrefix",
            defaultValue: "Analyze: \(base)",
            table: "TermLoop"
        )
    }

    private func validateSuggestion(
        _ suggestion: ContextBankSuggestion,
        for run: ContextBankAnalysisRun
    ) throws {
        let targetMustExist = suggestion.action != .add
        try validateContextBankPath(
            suggestion.targetPath,
            projectRoot: run.projectRoot,
            mustExist: targetMustExist
        )

        for mirrorPath in suggestion.mirrorPaths {
            try validateContextBankPath(
                mirrorPath,
                projectRoot: run.projectRoot,
                mustExist: true
            )
        }

        if let fromPath = suggestion.fromPath {
            try validateContextBankPath(
                fromPath,
                projectRoot: run.projectRoot,
                mustExist: true
            )
        }
    }

    private func validateContextBankPath(
        _ path: String,
        projectRoot: URL,
        mustExist: Bool
    ) throws {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard ContextBankFile.Kind.from(fileName: url.lastPathComponent) != nil else {
            throw ProposalError.invalidContextFileName(path)
        }
        let rootPath = projectRoot.standardizedFileURL.path
        guard Self.path(url.path, isInsideOrEqualTo: rootPath) else {
            throw ProposalError.pathOutsideProject(path)
        }

        let exists = FileManager.default.fileExists(atPath: url.path)
        if exists {
            let resolved = (url.path as NSString).resolvingSymlinksInPath
            guard Self.path(resolved, isInsideOrEqualTo: rootPath) else {
                throw ProposalError.pathOutsideProject(path)
            }
        } else if mustExist {
            throw ProposalError.missingRequiredFile(path)
        }
    }

    private static func path(_ path: String, isInsideOrEqualTo rootPath: String) -> Bool {
        let normalizedRoot = URL(fileURLWithPath: rootPath).standardizedFileURL.path
        let normalizedPath = URL(fileURLWithPath: path).standardizedFileURL.path
        return normalizedPath == normalizedRoot
            || normalizedPath.hasPrefix(normalizedRoot + "/")
    }
}

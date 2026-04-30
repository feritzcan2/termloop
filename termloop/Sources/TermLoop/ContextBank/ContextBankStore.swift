// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI
#if DEBUG
import Bonsplit
#endif

/// Owns Context Bank state for the active project: indexed files, pending
/// curator suggestions, selected file. Analysis lifecycle (fork dispatch,
/// MCP tool ingest, lifecycle bookkeeping) lives in
/// `ContextBankAnalysisCoordinator`; this store is UI-facing — it only
/// consumes the coordinator's `notifyRun*` callbacks and
/// `publishSuggestions(_:forProjectRoot:)` handoff.
///
/// The single entry point for "analyze a session" is the sidebar's
/// "Send to Analyze" context menu, which routes through the coordinator.
/// There is intentionally no panel-level analyze button — analyses target
/// a specific source workspace, not the project as a whole.
@MainActor
final class ContextBankStore: ObservableObject {
    static let shared = ContextBankStore()

    enum AnalyzerPhase: Equatable {
        case idle
        case analyzing(step: String)
        case error(String)

        var isAnalyzing: Bool {
            if case .analyzing = self { return true }
            return false
        }

        var analyzingStep: String? {
            if case .analyzing(let step) = self { return step }
            return nil
        }
    }

    @Published private(set) var files: [ContextBankFile] = []
    /// Pre-built tree derived from `files`. Published alongside so the
    /// view doesn't rebuild the trie on every SwiftUI body pass.
    @Published private(set) var tree: [ContextBankTreeNode] = []
    @Published private(set) var suggestions: [ContextBankSuggestion] = []
    /// Active + recently-terminated curator-fork runs for the visible
    /// project. Coordinator pushes snapshots via `upsertRun(_:forProjectRoot:)`
    /// on lifecycle transitions; the agents panel reads this directly.
    /// Terminal runs are kept until cleared so the user sees the outcome.
    @Published private(set) var activeRuns: [ContextBankRunSnapshot] = []
    @Published private(set) var analyzerPhase: AnalyzerPhase = .idle
    /// Drives the right pane: file content (when a file row is selected)
    /// or suggestion preview (when a suggestion row is selected). The
    /// tree view writes to this via `Binding<ContextBankSelection>`.
    @Published var selection: ContextBankSelection = .none

    private var currentProjectRoot: URL?
    private var scanTask: Task<Void, Never>?
    /// Background-published suggestions keyed by project root. Curator forks
    /// can complete after the user has already switched projects; queue the
    /// result here so it surfaces when they switch back. The active
    /// project's slice is mirrored into `suggestions` for the UI.
    private var suggestionsByProjectRoot: [URL: [ContextBankSuggestion]] = [:]
    /// Run snapshots keyed by project root. Active project's slice is
    /// mirrored into `activeRuns` so the agents panel stays in sync.
    private var runsByProjectRoot: [URL: [ContextBankRunSnapshot]] = [:]
    /// Number of in-flight coordinator runs per project. Drives
    /// `analyzerPhase` for the active project — a non-zero count surfaces
    /// the "Curator is thinking…" banner.
    private var activeRunsByProjectRoot: [URL: Int] = [:]
    /// Latest analyzer-error message keyed by project. Project-scoped so
    /// switching to a clean project doesn't surface the previous
    /// project's error, and switching back restores it untouched.
    private var errorsByProjectRoot: [URL: String] = [:]

    private init() {}

    var activeProjectRootURL: URL? { currentProjectRoot }

    var selectedFile: ContextBankFile? {
        if case .file(let url) = selection {
            return files.first(where: { $0.url == url })
        }
        return files.first
    }

    /// Resolves a `.suggestion(id)` selection to the live suggestion in
    /// the published array. Returns nil if the suggestion was already
    /// accepted/rejected (in which case the right pane should show empty
    /// state, not stale data).
    var selectedSuggestion: ContextBankSuggestion? {
        if case .suggestion(let id) = selection {
            return suggestions.first(where: { $0.id == id && $0.status == .pending })
        }
        return nil
    }

    func bind(to projectRoot: URL?) {
        guard currentProjectRoot != projectRoot else { return }
        if let oldRoot = currentProjectRoot {
            // Stash any pending suggestions for the previous project so a
            // later switch back restores them.
            if !suggestions.isEmpty {
                suggestionsByProjectRoot[oldRoot] = suggestions
            } else {
                suggestionsByProjectRoot.removeValue(forKey: oldRoot)
            }
            // Same stash treatment for run snapshots.
            if !activeRuns.isEmpty {
                runsByProjectRoot[oldRoot] = activeRuns
            } else {
                runsByProjectRoot.removeValue(forKey: oldRoot)
            }
        }
        currentProjectRoot = projectRoot
        scanTask?.cancel()
        scanTask = nil
        suggestions = projectRoot.flatMap { suggestionsByProjectRoot[$0] } ?? []
        activeRuns = projectRoot.flatMap { runsByProjectRoot[$0] } ?? []
        recomputeAnalyzerPhase()
        refresh()
    }

    // MARK: - Run snapshot mutations (coordinator-facing)

    /// Inserts or updates a run snapshot for `projectRoot`. Coordinator
    /// calls this on start, on each `receiveProposal`, on finalize, and on
    /// terminal phase transitions. The active project's slice is mirrored
    /// into `activeRuns` so SwiftUI subscribers re-render.
    func upsertRun(
        _ snapshot: ContextBankRunSnapshot,
        forProjectRoot projectRoot: URL
    ) {
        var bucket = (currentProjectRoot == projectRoot ? activeRuns : runsByProjectRoot[projectRoot]) ?? []
        if let idx = bucket.firstIndex(where: { $0.id == snapshot.id }) {
            if bucket[idx] == snapshot { return }
            bucket[idx] = snapshot
        } else {
            bucket.append(snapshot)
        }
        if currentProjectRoot == projectRoot {
            activeRuns = bucket
        }
        runsByProjectRoot[projectRoot] = bucket
    }

    /// Removes a run snapshot. Used when the user dismisses a finished run
    /// or when the project is switched. Coordinator does NOT auto-remove on
    /// terminal phase — the panel keeps the row until the user dismisses
    /// (`× ` button) so they see the outcome.
    func removeRun(forkWorkspaceId: UUID, forProjectRoot projectRoot: URL) {
        if currentProjectRoot == projectRoot {
            activeRuns.removeAll { $0.id == forkWorkspaceId }
            runsByProjectRoot[projectRoot] = activeRuns
        } else {
            var bucket = runsByProjectRoot[projectRoot] ?? []
            bucket.removeAll { $0.id == forkWorkspaceId }
            runsByProjectRoot[projectRoot] = bucket
        }
    }

    /// Coordinator handoff for curator-fork results. Routes to the right
    /// per-project bucket and, when the project is active, mirrors into
    /// the UI-facing `suggestions` array. Resolved entries (accepted /
    /// rejected) survive — they make up the historical tail shown beneath
    /// the active list. Stale **pending** from prior runs are dropped on
    /// purpose: a new analyze run produces a fresh recommendation set, and
    /// keeping yesterday's pending alongside today's would mean the user
    /// has to triage suggestions the curator no longer endorses.
    func publishSuggestions(
        _ incoming: [ContextBankSuggestion],
        forProjectRoot projectRoot: URL
    ) {
        if currentProjectRoot == projectRoot {
            let resolvedTail = suggestions.filter { $0.status != .pending }
            suggestions = incoming + resolvedTail
            suggestionsByProjectRoot[projectRoot] = suggestions
            rebuildTreeForCurrentSuggestions()
        } else {
            let existing = suggestionsByProjectRoot[projectRoot] ?? []
            let resolvedTail = existing.filter { $0.status != .pending }
            suggestionsByProjectRoot[projectRoot] = incoming + resolvedTail
        }
    }

    // MARK: - Coordinator lifecycle hooks

    /// Increments the active-run count for `projectRoot` and refreshes the
    /// analyzer phase. The "Curator is thinking…" banner stays up while
    /// any run is active for the visible project.
    func notifyRunStarted(forProjectRoot projectRoot: URL) {
        activeRunsByProjectRoot[projectRoot, default: 0] += 1
        recomputeAnalyzerPhase()
    }

    /// Decrements the active-run count for `projectRoot`. When the count
    /// reaches zero, the banner clears unless an error was reported.
    func notifyRunEnded(
        forProjectRoot projectRoot: URL,
        error: String? = nil
    ) {
        let next = max(0, (activeRunsByProjectRoot[projectRoot] ?? 0) - 1)
        if next == 0 {
            activeRunsByProjectRoot.removeValue(forKey: projectRoot)
        } else {
            activeRunsByProjectRoot[projectRoot] = next
        }
        if let error {
            errorsByProjectRoot[projectRoot] = error
        }
        recomputeAnalyzerPhase()
    }

    private func recomputeAnalyzerPhase() {
        guard let root = currentProjectRoot else {
            analyzerPhase = .idle
            return
        }
        // Error preservation is project-scoped: a stored error for the
        // active project shows until clearError, but switching to another
        // project surfaces THAT project's state, not this one's error.
        if let stored = errorsByProjectRoot[root] {
            analyzerPhase = .error(stored)
            return
        }
        let count = activeRunsByProjectRoot[root] ?? 0
        if count > 0 {
            analyzerPhase = .analyzing(step: String(
                localized: "contextBank.analyze.step.waiting",
                defaultValue: "Curator is thinking…",
                table: "TermLoop"
            ))
        } else {
            analyzerPhase = .idle
        }
    }

    func refresh() {
        guard let root = currentProjectRoot else {
            if !files.isEmpty { files = [] }
            if !tree.isEmpty { tree = [] }
            if !suggestions.isEmpty { suggestions = [] }
            if selection != .none { selection = .none }
            return
        }
        scanTask?.cancel()
        let pending = suggestions.filter { $0.status == .pending }
        scanTask = Task.detached(priority: .userInitiated) { [weak self] in
            let scanned = ContextBankIndexer.scan(projectRoot: root)
            if Task.isCancelled { return }
            let builtTree = ContextBankTreeBuilder.build(from: scanned, suggestions: pending)
            if Task.isCancelled { return }
            await self?.applyScan(scanned, tree: builtTree, for: root)
        }
    }

    private func applyScan(_ scanned: [ContextBankFile], tree builtTree: [ContextBankTreeNode], for root: URL) {
        guard currentProjectRoot == root else { return }
        let filesChanged = scanned != files
        let treeChanged = builtTree != tree
        guard filesChanged || treeChanged else { return }
        files = scanned
        tree = builtTree
        // Validate selection: file URL must still exist; suggestion id
        // must still be pending. Otherwise reset to the first file (matches
        // the previous default-selection behavior).
        let selectionValid: Bool = {
            switch selection {
            case .none: return true
            case .file(let url): return scanned.contains { $0.url == url }
            case .suggestion(let id): return suggestions.contains { $0.id == id && $0.status == .pending }
            }
        }()
        if !selectionValid {
            selection = scanned.first.map { .file($0.url) } ?? .none
        }
    }

    /// Re-runs `ContextBankTreeBuilder.build(from:suggestions:)` whenever
    /// the suggestion list changes, so the inline child rows show up
    /// without waiting for the next file scan. Cheap (synchronous, in-
    /// memory grouping) so we keep it on the main actor.
    private func rebuildTreeForCurrentSuggestions() {
        guard let _ = currentProjectRoot else { return }
        let pending = suggestions.filter { $0.status == .pending }
        let rebuilt = ContextBankTreeBuilder.build(from: files, suggestions: pending)
        if rebuilt != tree {
            tree = rebuilt
        }
    }

    func accept(_ suggestion: ContextBankSuggestion) {
        #if DEBUG
        dlog("contextbank.accept.enter id=\(suggestion.id.uuidString) action=\(suggestion.action.rawValue) target=\(suggestion.targetPath) mirrors=\(suggestion.mirrorPaths.count)")
        #endif
        do {
            try ContextBankApplier.apply(suggestion) { [weak self] url in
                self?.files.first(where: { $0.url == url })?.lineLimit
                    ?? ContextBankLineLimits.defaultRootLimit
            }
            #if DEBUG
            dlog("contextbank.accept.apply.ok id=\(suggestion.id.uuidString)")
            #endif
            updateStatus(suggestion.id, to: .accepted)
            ContextBankDecisionLog.shared.record(suggestion, decision: .accepted, projectRoot: currentProjectRoot)
            refresh()
        } catch {
            #if DEBUG
            dlog("contextbank.accept.apply.error id=\(suggestion.id.uuidString) err=\(error.localizedDescription)")
            #endif
            analyzerPhase = .error(error.localizedDescription)
        }
    }

    func reject(_ suggestion: ContextBankSuggestion) {
        updateStatus(suggestion.id, to: .rejected)
        ContextBankDecisionLog.shared.record(suggestion, decision: .rejected, projectRoot: currentProjectRoot)
    }

    func clearError() {
        guard let root = currentProjectRoot else {
            analyzerPhase = .idle
            return
        }
        errorsByProjectRoot.removeValue(forKey: root)
        recomputeAnalyzerPhase()
    }

    var pendingSuggestionCount: Int {
        suggestions.filter { $0.status == .pending }.count
    }

    var isAnalyzing: Bool { analyzerPhase.isAnalyzing }
    var currentAnalyzeStep: String? { analyzerPhase.analyzingStep }

    private func updateStatus(_ id: UUID, to status: ContextBankSuggestion.Status) {
        guard let idx = suggestions.firstIndex(where: { $0.id == id }) else { return }
        suggestions[idx].status = status
        // Resolved suggestion drops out of the tree's pending child list.
        rebuildTreeForCurrentSuggestions()
        // Clear selection if it pointed at this suggestion — the right
        // pane should fall back to empty state, not show a stale card.
        if selection == .suggestion(id) {
            selection = .none
        }
    }
}

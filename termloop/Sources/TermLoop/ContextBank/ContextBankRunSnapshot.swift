// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// UI-facing view of an in-flight (or recently terminated) curator-fork run.
/// Mirrors `ContextBankAnalysisRun` but trims it to what the agents panel
/// actually displays — title, phase, count, timestamps. Coordinator pushes
/// snapshots to `ContextBankStore.upsertRun(...)` on lifecycle changes.
struct ContextBankRunSnapshot: Identifiable, Equatable {
    /// Same UUID as `ContextBankAnalysisRun.forkWorkspaceId` — the fork tab
    /// the curator is running in. Stable for the run's lifetime.
    let id: UUID
    let projectRoot: URL
    let sourceWorkspaceTitle: String
    let agentId: String
    var phase: ContextBankAnalysisRun.Phase
    var suggestionCount: Int
    let startedAt: Date
    var endedAt: Date?

    var isTerminal: Bool {
        switch phase {
        case .completed, .malformed, .timeout, .cancelled: return true
        case .running: return false
        }
    }
}

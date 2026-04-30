// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// One in-flight curator analysis. Created when the user picks "Send to
/// Analyze" on a workspace row; lives until the curator calls the
/// `context_bank_finalize_run` MCP tool, the user closes the fork tab,
/// the project is switched, or the watchdog deadline passes.
struct ContextBankAnalysisRun: Identifiable, Equatable {
    enum Phase: Equatable {
        case running
        case completed(suggestionCount: Int)
        case malformed(reason: String)
        case timeout
        case cancelled
    }

    let id: UUID
    let projectRoot: URL
    let projectId: UUID?
    let sourceWorkspaceId: UUID
    let sourceSessionId: String
    let agentId: String
    let forkWorkspaceId: UUID
    var phase: Phase
    var startedAt: Date

    var isTerminal: Bool {
        switch phase {
        case .completed, .malformed, .timeout, .cancelled:
            return true
        case .running:
            return false
        }
    }

    init(
        id: UUID = UUID(),
        projectRoot: URL,
        projectId: UUID?,
        sourceWorkspaceId: UUID,
        sourceSessionId: String,
        agentId: String,
        forkWorkspaceId: UUID,
        startedAt: Date = Date()
    ) {
        self.id = id
        self.projectRoot = projectRoot
        self.projectId = projectId
        self.sourceWorkspaceId = sourceWorkspaceId
        self.sourceSessionId = sourceSessionId
        self.agentId = agentId
        self.forkWorkspaceId = forkWorkspaceId
        self.phase = .running
        self.startedAt = startedAt
    }
}

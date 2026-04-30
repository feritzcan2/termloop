// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct TerminalAgentLiveSession: Identifiable, Equatable {
    let core: AgentRowPresentationSnapshot
    let updatedAt: Date

    var id: UUID { core.workspaceId }

    var phaseSortOrder: Int {
        core.displayState.activeAgentsSortPriority
    }

    /// Elapsed-label anchor: prefer presentation `since`, fall back to
    /// `updatedAt` when presentation has none (first spawn, pre-report).
    var since: Date { core.since ?? updatedAt }
}

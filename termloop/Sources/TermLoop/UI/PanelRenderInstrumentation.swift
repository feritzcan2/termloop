// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
#if DEBUG
import Bonsplit
#endif

enum PanelRenderID: String {
    case activeAgents = "active-agents"
    case worktreeAgents = "worktree-agents"
    case ticketWorktrees = "ticket-worktrees"
}

/// Render counter + duration sampler for sidebar panel snapshot builders. In
/// DEBUG, logs per-panel call frequency and build duration every 2s via `dlog`
/// (greppable: `panel.render`). In Release, `measure` collapses to a direct
/// passthrough — the closure is non-escaping and inlines away.
@MainActor
enum PanelRenderInstrumentation {
    #if DEBUG
    private struct State {
        var total: Int = 0
        var deltaSinceLog: Int = 0
        var totalDurationNs: UInt64 = 0
        var maxDurationNs: UInt64 = 0
        var lastLogAt: Date = .distantPast
    }

    private static var byPanel: [PanelRenderID: State] = [:]

    private static func record(_ panel: PanelRenderID, durationNs: UInt64) {
        var state = byPanel[panel] ?? State()
        state.total += 1
        state.deltaSinceLog += 1
        state.totalDurationNs &+= durationNs
        if durationNs > state.maxDurationNs { state.maxDurationNs = durationNs }
        let now = Date()
        if now.timeIntervalSince(state.lastLogAt) >= 2.0 {
            let avgUs = state.deltaSinceLog > 0
                ? state.totalDurationNs / UInt64(state.deltaSinceLog) / 1_000
                : 0
            let maxUs = state.maxDurationNs / 1_000
            dlog("panel.render \(panel.rawValue) total=\(state.total) delta=\(state.deltaSinceLog) avg=\(avgUs)us max=\(maxUs)us window=2s")
            state.deltaSinceLog = 0
            state.totalDurationNs = 0
            state.maxDurationNs = 0
            state.lastLogAt = now
        }
        byPanel[panel] = state
    }
    #endif

    static func measure<T>(_ panel: PanelRenderID, _ work: () -> T) -> T {
        #if DEBUG
        let start = DispatchTime.now().uptimeNanoseconds
        let result = work()
        let end = DispatchTime.now().uptimeNanoseconds
        record(panel, durationNs: end &- start)
        return result
        #else
        return work()
        #endif
    }
}

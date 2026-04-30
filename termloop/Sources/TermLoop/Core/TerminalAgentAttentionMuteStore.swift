// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation

/// Per-workspace "mute this attention until the next update" state.
///
/// When a terminal agent session is in an attention phase (`needsInput`,
/// `error`, a completed notification) it shows up in `ActiveAgentsPanel`
/// with a notification style. Clicking the × on that row records the
/// session's current `updatedAt` here; `isMuted` then reports true until
/// the session's `updatedAt` advances past the stored value — i.e., until
/// the next update arrives. No persistence; this is deliberately session-
/// scoped so the dismissal doesn't leak across app restarts.
@MainActor
final class TerminalAgentAttentionMuteStore: ObservableObject {
    static let shared = TerminalAgentAttentionMuteStore()

    @Published private var mutedUpdatedAtByWorkspace: [UUID: Date] = [:]
    @Published private(set) var version: Int = 0

    private init() {}

    /// Returns true when the caller should suppress this session's
    /// attention row — equivalent to "user dismissed it and nothing new
    /// has happened since".
    func isMuted(workspaceId: UUID, currentUpdatedAt: Date) -> Bool {
        guard let muted = mutedUpdatedAtByWorkspace[workspaceId] else { return false }
        return currentUpdatedAt <= muted
    }

    /// Records the session's current `updatedAt` so subsequent calls to
    /// `isMuted` return true until `updatedAt` advances.
    func mute(workspaceId: UUID, atUpdatedAt updatedAt: Date) {
        mutedUpdatedAtByWorkspace[workspaceId] = updatedAt
        version &+= 1
    }

    /// Rare, but: if a workspace is closed or agent restarted, wipe the
    /// entry so a fresh session doesn't inherit a stale mute.
    func clear(workspaceId: UUID) {
        guard mutedUpdatedAtByWorkspace.removeValue(forKey: workspaceId) != nil else { return }
        version &+= 1
    }
}

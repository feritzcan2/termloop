// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum TerminalAgentDisplayState: String, Equatable {
    case idle
    case ready
    case running
    case needsInput
    case completed
    case error

    var sidebarLabel: String? {
        switch self {
        case .idle:
            return nil
        case .ready:
            return "Ready"
        case .running:
            return "Running"
        case .needsInput:
            return "Needs input"
        case .completed:
            return "Completed"
        case .error:
            return "Error"
        }
    }

    var sidebarIcon: String? {
        switch self {
        case .idle:
            return nil
        case .ready:
            return "circle.fill"
        case .running:
            return "bolt.fill"
        case .needsInput:
            return "bell.fill"
        case .completed:
            return "checkmark.circle.fill"
        case .error:
            return "exclamationmark.triangle.fill"
        }
    }

    var sidebarColorHex: String? {
        switch self {
        case .idle:
            return nil
        case .ready:
            return "#9AA0A6"
        case .running:
            return "#4C8DFF"
        case .needsInput:
            return "#EF8F1A"
        case .completed:
            return "#2FBF71"
        case .error:
            return "#FF5A5F"
        }
    }

    var aggregatePriority: Int {
        switch self {
        case .error:
            return 0
        case .needsInput:
            return 1
        case .running:
            return 2
        case .completed:
            return 3
        case .ready:
            return 4
        case .idle:
            return 5
        }
    }

    var activeAgentsSortPriority: Int {
        switch self {
        case .needsInput:
            return 0
        case .error:
            return 1
        case .running:
            return 2
        case .completed:
            return 3
        case .ready:
            return 4
        case .idle:
            return 5
        }
    }

    var isVisibleActivity: Bool {
        self != .idle
    }

    var isWaitingLike: Bool {
        self == .needsInput || self == .error
    }

    var isAttentionWorthy: Bool {
        self == .needsInput || self == .completed || self == .error
    }

    /// The agent has stopped writing — `idle`, `completed`, paused on
    /// `needsInput`, or ended with `error`. `ready` is excluded as the
    /// pre-first-turn quiescent state. Used by the bridge auto-forward
    /// edge detector; `forwardLatestMessage` already no-ops when the
    /// extractor has nothing fresh, so including `error` here just
    /// recovers a partial assistant reply that preceded the failure
    /// instead of dropping it.
    var isSettled: Bool {
        self == .idle
            || self == .completed
            || self == .needsInput
            || self == .error
    }
}

struct TerminalAgentDisplayPresentation: Equatable {
    let state: TerminalAgentDisplayState
    let label: String?
    let icon: String?
    let colorHex: String?
}

struct TerminalAgentAggregateSummary: Equatable {
    let runningCount: Int
    let needsInputCount: Int
    let completedCount: Int
    let errorCount: Int
    let dominantState: TerminalAgentDisplayState
    let latestActivityAt: Date?

    var visibleCount: Int {
        runningCount + needsInputCount + completedCount + errorCount
    }

    var hasVisibleActivity: Bool {
        visibleCount > 0
    }
}

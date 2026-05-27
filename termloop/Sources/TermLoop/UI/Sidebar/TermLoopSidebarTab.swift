// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum TermLoopSidebarTab: String, CaseIterable, Identifiable {
    case work, agents, integrations

    static let storageKey = "termloop.sidebarTab"

    var id: String { rawValue }

    var displayTitle: String {
        switch self {
        case .work:
            return String(localized: "sidebar.tab.work",
                          defaultValue: "WORK", table: "TermLoop")
        case .agents:
            return String(localized: "sidebar.tab.agents",
                          defaultValue: "CATALOG", table: "TermLoop")
        case .integrations:
            return String(localized: "sidebar.tab.integrations",
                          defaultValue: "INTEGR.", table: "TermLoop")
        }
    }

    /// Restore from UserDefaults with fallback to `.work` for unknown raw values.
    static func restore(from defaults: UserDefaults = .standard) -> TermLoopSidebarTab {
        guard let raw = defaults.string(forKey: storageKey),
              let value = TermLoopSidebarTab(rawValue: raw) else {
            return .work
        }
        return value
    }
}

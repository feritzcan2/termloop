// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum TermLoopSidebarTab: String, CaseIterable, Identifiable {
    case work, agents, integrations, plan

    static let storageKey = "termloop.sidebarTab"

    var id: String { rawValue }

    var displayTitle: String {
        switch self {
        case .work:
            return String(localized: "sidebar.tab.work",
                          defaultValue: "WORK", table: "TermLoop")
        case .agents:
            return String(localized: "sidebar.tab.agents",
                          defaultValue: "AGENTS", table: "TermLoop")
        case .integrations:
            return String(localized: "sidebar.tab.integrations",
                          defaultValue: "INTEGR.", table: "TermLoop")
        case .plan:
            return String(localized: "sidebar.tab.plan",
                          defaultValue: "PLAN", table: "TermLoop")
        }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct Recommendation: Identifiable, Hashable {
    enum Action: Hashable {
        case add(presetId: String?)
        case fix(step: String)
        case configure
    }

    enum Severity: Int, Comparable, Hashable {
        case info = 0
        case suggest = 1
        case warning = 2
        static func < (a: Severity, b: Severity) -> Bool { a.rawValue < b.rawValue }
    }

    let id: String
    let kind: IntegrationKind
    let itemName: String
    let reason: String
    let action: Action
    let severity: Severity
}

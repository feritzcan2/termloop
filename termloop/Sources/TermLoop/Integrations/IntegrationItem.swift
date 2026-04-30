// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct IntegrationItem: Identifiable, Hashable {
    let id: String
    let kind: IntegrationKind
    let displayName: String
    var summary: String
    var source: Source
    var status: Status
    var lastTestedAt: Date?
    var lastTestDurationMs: Int?
    var capabilities: [String]
    var configRef: ConfigRef?
    var attachedToActiveSpawn: Bool
    var binaryPath: String?
    var version: String?
    var authSubject: String?
    /// Which agent families' configs declare this integration. Populated by
    /// per-agent discovery parsers (MCP scans Claude/Codex/Gemini configs
    /// independently). Empty when not relevant (e.g. CLI binaries on PATH
    /// are agent-agnostic). Merged via set union when the same id is
    /// discovered in multiple sources.
    var availableForAgents: Set<AbilityAgentFamily> = []

    enum Source: Hashable {
        case userScope
        case projectScope(URL)
        case systemPath(URL)
        case termLoop

        var precedence: Int {
            switch self {
            case .projectScope: return 3
            case .systemPath: return 2
            case .userScope: return 1
            case .termLoop: return 0
            }
        }
    }

    enum Status: Hashable {
        case idle
        case running
        case ok(message: String)
        case fail(reason: String)
        case notConfigured

        var sortRank: Int {
            switch self {
            case .fail: return 0
            case .notConfigured: return 1
            case .idle: return 2
            case .running: return 3
            case .ok: return 4
            }
        }

        /// True for statuses where a connection has been verified or is
        /// actively running. `idle` (PATH-discovered, never probed) and
        /// failure modes return false.
        var isReady: Bool {
            switch self {
            case .ok, .running: return true
            case .idle, .fail, .notConfigured: return false
            }
        }
    }

    struct ConfigRef: Hashable, Codable {
        let presetId: String
        let keychainAccounts: [String]
        let jsonPath: URL?
    }

    static func makeId(kind: IntegrationKind, name: String) -> String {
        "\(kind.rawValue):\(name)"
    }

    /// Combine two snapshots of the same id (same kind+name) discovered by
    /// independent parsers/sources. Higher-precedence source wins on
    /// scalar fields; `availableForAgents` is unioned so per-agent
    /// membership reported by lower-precedence parsers isn't lost.
    func merged(with other: IntegrationItem) -> IntegrationItem {
        var out = self
        out.availableForAgents.formUnion(other.availableForAgents)
        if other.source.precedence > out.source.precedence {
            out.source = other.source
            out.summary = other.summary
            out.binaryPath = other.binaryPath
        }
        return out
    }
}

struct IntegrationTestResult {
    let success: Bool
    let message: String
    let durationMs: Int
    let capabilities: [String]
    let logPath: URL?

    static func failure(_ reason: String, durationMs: Int = 0) -> IntegrationTestResult {
        IntegrationTestResult(success: false, message: reason, durationMs: durationMs,
                              capabilities: [], logPath: nil)
    }
}

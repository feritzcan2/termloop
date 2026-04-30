// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct ContextBankFile: Identifiable, Equatable, Hashable {
    enum Kind: String, CaseIterable {
        case claude
        case agents
        case gemini

        var displayName: String {
            switch self {
            case .claude: return "CLAUDE.md"
            case .agents: return "AGENTS.md"
            case .gemini: return "GEMINI.md"
            }
        }

        static let allFileNames: [String] = Kind.allCases.map { $0.displayName }

        static func from(fileName: String) -> Kind? {
            switch fileName {
            case "CLAUDE.md": return .claude
            case "AGENTS.md": return .agents
            case "GEMINI.md": return .gemini
            default: return nil
            }
        }
    }

    let url: URL
    let relativePath: String
    let kind: Kind
    let content: String
    let lineCount: Int
    let lineLimit: Int
    let mtime: Date
    let isSymlink: Bool
    let symlinkTargetName: String?

    var id: URL { url }

    var isOverLimit: Bool { lineCount > lineLimit }

    var fillRatio: Double {
        guard lineLimit > 0 else { return 0 }
        return min(Double(lineCount) / Double(lineLimit), 1.5)
    }

    /// Inline display for tree rows: `42/200`.
    var capacityLabel: String { "\(lineCount)/\(lineLimit)" }
}

enum ContextBankLineLimits {
    static let defaultRootLimit = 200
    static let defaultNestedLimit = 100

    /// Default limit inferred from path depth. Files directly under the
    /// project root get a higher budget than nested per-folder files.
    static func defaultLimit(for url: URL, projectRoot: URL) -> Int {
        let rootComponents = projectRoot.standardizedFileURL.pathComponents
        let fileComponents = url.standardizedFileURL.deletingLastPathComponent().pathComponents
        let depth = max(0, fileComponents.count - rootComponents.count)
        return depth == 0 ? defaultRootLimit : defaultNestedLimit
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct ContextBankSuggestion: Identifiable, Equatable, Codable {
    enum Action: String, Codable {
        case add
        case replace
        case move
    }

    enum Status: String, Codable {
        case pending
        case accepted
        case rejected
    }

    let id: UUID
    let createdAt: Date
    let sourceSessionId: String?
    let action: Action
    let targetPath: String
    /// Additional files that should receive the same `addText` verbatim.
    /// Only meaningful for `.add` — collapsing the common pattern where
    /// `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` are kept identical across a
    /// project. Empty for `.replace` / `.move`. Decoded as missing-OK so old
    /// decision-log entries continue to parse.
    let mirrorPaths: [String]
    let fromPath: String?
    let addText: String?
    let replaceOldText: String?
    let reasoning: String
    let sourceQuote: String?
    let confidence: Double
    var status: Status

    init(
        id: UUID = UUID(),
        createdAt: Date = Date(),
        sourceSessionId: String?,
        action: Action,
        targetPath: String,
        mirrorPaths: [String] = [],
        fromPath: String? = nil,
        addText: String? = nil,
        replaceOldText: String? = nil,
        reasoning: String,
        sourceQuote: String? = nil,
        confidence: Double,
        status: Status = .pending
    ) {
        self.id = id
        self.createdAt = createdAt
        self.sourceSessionId = sourceSessionId
        self.action = action
        self.targetPath = targetPath
        self.mirrorPaths = mirrorPaths
        self.fromPath = fromPath
        self.addText = addText
        self.replaceOldText = replaceOldText
        self.reasoning = reasoning
        self.sourceQuote = sourceQuote
        self.confidence = confidence
        self.status = status
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(UUID.self, forKey: .id)
        self.createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.sourceSessionId = try c.decodeIfPresent(String.self, forKey: .sourceSessionId)
        self.action = try c.decode(Action.self, forKey: .action)
        self.targetPath = try c.decode(String.self, forKey: .targetPath)
        self.mirrorPaths = try c.decodeIfPresent([String].self, forKey: .mirrorPaths) ?? []
        self.fromPath = try c.decodeIfPresent(String.self, forKey: .fromPath)
        self.addText = try c.decodeIfPresent(String.self, forKey: .addText)
        self.replaceOldText = try c.decodeIfPresent(String.self, forKey: .replaceOldText)
        self.reasoning = try c.decode(String.self, forKey: .reasoning)
        self.sourceQuote = try c.decodeIfPresent(String.self, forKey: .sourceQuote)
        self.confidence = try c.decode(Double.self, forKey: .confidence)
        self.status = try c.decode(Status.self, forKey: .status)
    }

    var targetURL: URL { URL(fileURLWithPath: targetPath) }
    var fromURL: URL? { fromPath.map { URL(fileURLWithPath: $0) } }
    var allTargetPaths: [String] { [targetPath] + mirrorPaths }
    var allTargetURLs: [URL] { allTargetPaths.map { URL(fileURLWithPath: $0) } }

    var actionTitle: String {
        switch action {
        case .add: return "ADD"
        case .replace: return "REPLACE"
        case .move: return "MOVE"
        }
    }
}

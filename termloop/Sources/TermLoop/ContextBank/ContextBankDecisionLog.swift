// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Append-only JSONL log of accepted/rejected suggestion decisions.
/// Used to (a) remember user preference so we don't re-propose rejected
/// ideas and (b) audit which suggestions have been applied. Entries carry
/// the `projectRoot` they belong to so curator prompts only see decisions
/// from the same project — preventing project A's rejection list from
/// leaking into project B's analyze run.
final class ContextBankDecisionLog {
    struct Entry: Codable {
        let timestamp: Date
        let decision: String
        let suggestion: ContextBankSuggestion
        let projectRoot: String?

        enum CodingKeys: String, CodingKey {
            case timestamp, decision, suggestion, projectRoot
        }

        init(
            timestamp: Date,
            decision: String,
            suggestion: ContextBankSuggestion,
            projectRoot: String?
        ) {
            self.timestamp = timestamp
            self.decision = decision
            self.suggestion = suggestion
            self.projectRoot = projectRoot
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.timestamp = try c.decode(Date.self, forKey: .timestamp)
            self.decision = try c.decode(String.self, forKey: .decision)
            self.suggestion = try c.decode(ContextBankSuggestion.self, forKey: .suggestion)
            self.projectRoot = try c.decodeIfPresent(String.self, forKey: .projectRoot)
        }
    }

    static let shared = ContextBankDecisionLog()

    private let fileURL: URL
    private let queue = DispatchQueue(label: "termloop.contextbank.decisionlog")

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let appSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first ?? URL(fileURLWithPath: NSHomeDirectory())
            let dir = appSupport
                .appendingPathComponent("termloop", isDirectory: true)
                .appendingPathComponent("contextbank", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            self.fileURL = dir.appendingPathComponent("decisions.jsonl")
        }
    }

    func record(
        _ suggestion: ContextBankSuggestion,
        decision: ContextBankSuggestion.Status,
        projectRoot: URL?
    ) {
        let entry = Entry(
            timestamp: Date(),
            decision: decision.rawValue,
            suggestion: suggestion,
            projectRoot: projectRoot?.path
        )
        queue.async { [fileURL] in
            guard let data = try? Self.encoder.encode(entry) else { return }
            var line = data
            line.append(0x0A)
            if FileManager.default.fileExists(atPath: fileURL.path) {
                if let handle = try? FileHandle(forWritingTo: fileURL) {
                    defer { try? handle.close() }
                    _ = try? handle.seekToEnd()
                    try? handle.write(contentsOf: line)
                }
            } else {
                try? line.write(to: fileURL)
            }
        }
    }

    /// Returns recent rejected-target-text pairs so the analyzer can avoid
    /// re-proposing them. Filters to the supplied project so project A's
    /// rejections don't leak into project B's curator prompt. Pre-scoped
    /// entries (no projectRoot field) are excluded — old global log
    /// entries are conservatively dropped rather than risk contaminating a
    /// fresh analysis. Cheap: parses entire file; call sparingly.
    func recentRejections(forProjectRoot projectRoot: URL?, limit: Int = 50) -> [String] {
        descriptors(matching: .rejected, projectRoot: projectRoot, limit: limit)
    }

    /// Returns recent accepted entries scoped to a project. Fed to the
    /// curator alongside rejections so it stops re-proposing things
    /// already in this project's bank. "Already accepted" is a stronger
    /// signal than line-count for discouraging duplicates — knowing the
    /// entry shipped tells the curator the topic is already covered.
    func recentAcceptances(forProjectRoot projectRoot: URL?, limit: Int = 50) -> [String] {
        descriptors(matching: .accepted, projectRoot: projectRoot, limit: limit)
    }

    private func descriptors(
        matching status: ContextBankSuggestion.Status,
        projectRoot: URL?,
        limit: Int
    ) -> [String] {
        guard let data = try? Data(contentsOf: fileURL),
              let text = String(data: data, encoding: .utf8) else { return [] }
        let needle = status.rawValue
        let scope = projectRoot?.path
        var out: [String] = []
        for line in text.split(separator: "\n").reversed() {
            guard let d = line.data(using: .utf8),
                  let entry = try? Self.decoder.decode(Entry.self, from: d),
                  entry.decision == needle
            else { continue }
            // Project-scope: only feed back entries from the same project.
            // Pre-scoped entries (entry.projectRoot == nil) are dropped
            // when a scope is requested — historical log entries had no
            // project tag, so we cannot trust them not to belong to a
            // different project.
            if let scope, entry.projectRoot != scope { continue }
            let descriptor = "\(entry.suggestion.action.rawValue) @ \(entry.suggestion.targetPath): \(entry.suggestion.reasoning)"
            out.append(descriptor)
            if out.count >= limit { break }
        }
        return out
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}

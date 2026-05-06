// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum TaskMarkdownFileWriter {
    private static let remoteStart = "<!-- termloop:remote-work-item:start -->"
    private static let remoteEnd = "<!-- termloop:remote-work-item:end -->"

    static func writeRemoteSnapshot(
        _ snapshot: RemoteWorkItemSnapshot,
        taskId: UUID,
        projectRoot: URL
    ) throws -> String {
        let dir = projectRoot
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("tasks", isDirectory: true)
            .appendingPathComponent(taskId.uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let url = dir.appendingPathComponent("task.md", isDirectory: false)
        let prior = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        let markdown = remoteMarkdown(for: snapshot) + preservedUserSection(from: prior)
        try markdown.write(to: url, atomically: true, encoding: .utf8)
        return url.path
    }

    private static func remoteMarkdown(for snapshot: RemoteWorkItemSnapshot) -> String {
        var lines: [String] = []
        lines.append(remoteStart)
        lines.append("# \(snapshot.reference.key) — \(snapshot.title)")
        lines.append("")
        lines.append("- Provider: \(snapshot.reference.provider.rawValue)")
        if let status = trimmed(snapshot.statusLabel) { lines.append("- Status: \(status)") }
        if let url = trimmed(snapshot.reference.url) { lines.append("- URL: \(url)") }
        if !snapshot.assignees.isEmpty { lines.append("- Assignees: \(snapshot.assignees.joined(separator: ", "))") }
        if !snapshot.labels.isEmpty { lines.append("- Labels: \(snapshot.labels.joined(separator: ", "))") }
        lines.append("- Fetched: \(ISO8601DateFormatter().string(from: snapshot.fetchedAt))")
        lines.append("")
        lines.append("## Description")
        lines.append("")
        lines.append(trimmed(snapshot.bodyMarkdown) ?? "_No description._")
        lines.append(remoteEnd)
        lines.append("")
        return lines.joined(separator: "\n")
    }

    private static func preservedUserSection(from prior: String) -> String {
        guard !prior.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return defaultNotesSection()
        }

        if let endRange = prior.range(of: remoteEnd) {
            let suffix = String(prior[endRange.upperBound...])
            if !suffix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return suffix.hasPrefix("\n") ? suffix : "\n" + suffix
            }
            return defaultNotesSection()
        }

        // The file existed before TermLoop started managing a remote block.
        // Keep the whole thing below the generated section instead of
        // overwriting user-authored notes.
        return "\n## Notes\n\n" + prior.trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
    }

    private static func defaultNotesSection() -> String {
        "\n## Notes\n\n"
    }

    private static func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

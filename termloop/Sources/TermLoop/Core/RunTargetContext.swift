// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct RunTargetContextEntry: Equatable {
    let labelForAgent: String
    let displayValue: String
    let url: String?
    let updatedAt: Date
}

struct RunTargetContextSnapshot: Equatable {
    let entries: [RunTargetContextEntry]
    var isEmpty: Bool { entries.isEmpty }
}

@MainActor
enum RunTargetContextSnapshotBuilder {
    static func build(
        workspaceId: UUID?,
        projectId: UUID?,
        runCwd: URL? = nil
    ) -> RunTargetContextSnapshot {
        guard let path = resolveWorktreeRoot(
            workspaceId: workspaceId,
            projectId: projectId,
            runCwd: runCwd
        ) else {
            return RunTargetContextSnapshot(entries: [])
        }

        let entries = RunTargetStore.shared.targets(forPath: path).compactMap { target -> RunTargetContextEntry? in
            guard let safeLabel = sanitizeShortText(target.label) else { return nil }
            var display = safeLabel
            if let safeStatus = sanitizeShortText(target.status) {
                display += " · \(safeStatus)"
            }
            return RunTargetContextEntry(
                labelForAgent: "Run target \(sanitizeIdentifier(target.id) ?? "target")",
                displayValue: display,
                url: sanitizeURL(target.url),
                updatedAt: target.reportedAt
            )
        }
        return RunTargetContextSnapshot(entries: entries)
    }

    static func composeBlock(_ snapshot: RunTargetContextSnapshot) -> String? {
        guard !snapshot.entries.isEmpty else { return nil }
        let lines = snapshot.entries.map { entry -> String in
            let urlSuffix = (entry.url?.isEmpty == false) ? " (\(entry.url!))" : ""
            return "\(entry.labelForAgent): \(entry.displayValue)\(urlSuffix)"
        }
        return "<system-reminder>\n" + lines.joined(separator: "\n") + "\n</system-reminder>"
    }

    private static func resolveWorktreeRoot(
        workspaceId: UUID?,
        projectId: UUID?,
        runCwd: URL?
    ) -> String? {
        if let workspaceId,
           let path = WorkspaceMetadataStore.shared.reportedStatePath(forWorkspaceId: workspaceId) {
            return path
        }
        guard let runCwd else { return nil }
        if let projectId,
           let project = ProjectStore.shared.project(id: projectId) {
            let projectPath = URL(fileURLWithPath: project.folderPath, isDirectory: true)
                .standardizedFileURL
                .path
            let cwdPath = runCwd.standardizedFileURL.path
            let marker = projectPath + "/.termloop-worktrees/"
            if cwdPath.hasPrefix(marker) {
                let remainder = String(cwdPath.dropFirst(marker.count))
                if let leaf = remainder.split(separator: "/").first {
                    return marker + leaf
                }
            }
        }
        return runCwd.standardizedFileURL.path
    }

    private static func sanitizeShortText(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(160))
    }

    private static func sanitizeIdentifier(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return trimmed
            .map { char in
                char.isLetter || char.isNumber || char == "-" || char == "_" ? char : "-"
            }
            .reduce(into: "") { result, char in
                if char == "-", result.last == "-" { return }
                result.append(char)
            }
            .trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
    }

    private static func sanitizeURL(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" || scheme == "file" else {
            return nil
        }
        return url.absoluteString
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

enum SkillSource: Equatable { case project, global }
enum SkillKind: Equatable { case skill, command }

struct SkillEntry: Identifiable, Equatable {
    let id: String
    let name: String
    let displayPath: String
    let description: String?
    let body: String
    let source: SkillSource
    let kind: SkillKind
    let fileURL: URL
}

/// Per-popover store. Scans the filesystem for skills and commands in both
/// the user's `~/.claude/` directory and the active project's `.claude/`.
/// Owners create a fresh instance each time the popover opens so there is no
/// stale state or file-system watcher to clean up.
@MainActor
final class SkillCatalog: ObservableObject {
    @Published private(set) var skills: [SkillEntry] = []
    @Published private(set) var commands: [SkillEntry] = []
    @Published private(set) var isRefreshing: Bool = false

    private static let fileSizeCap: Int = 512 * 1024

    func refresh(projectFolderPath: URL?) {
        isRefreshing = true
        let projectURL = projectFolderPath
        let home = FileManager.default.homeDirectoryForCurrentUser
        Task.detached(priority: .userInitiated) {
            let result = SkillCatalog.scan(home: home, projectURL: projectURL)
            await MainActor.run {
                self.skills = result.skills
                self.commands = result.commands
                self.isRefreshing = false
            }
        }
    }

    // MARK: - Scanning (nonisolated so it can run off-main)

    private struct ScanResult: Sendable {
        var skills: [SkillEntry]
        var commands: [SkillEntry]
    }

    nonisolated private static func scan(home: URL, projectURL: URL?) -> ScanResult {
        var skills: [SkillEntry] = []
        var commands: [SkillEntry] = []

        if let projectURL {
            for projectSkillRoot in [
                ".termloop",
                ".claude",
                ".codex",
                ".agents"
            ] {
                let root = projectURL.appendingPathComponent(projectSkillRoot, isDirectory: true)
                skills.append(contentsOf: scanSkills(in: root, source: .project))
            }
            let pClaude = projectURL.appendingPathComponent(".claude", isDirectory: true)
            commands.append(contentsOf: scanCommands(in: pClaude, source: .project))
        }

        for globalSkillRoot in [
            ".codex",
            ".agents",
            ".claude"
        ] {
            let root = home.appendingPathComponent(globalSkillRoot, isDirectory: true)
            skills.append(contentsOf: scanSkills(in: root, source: .global))
        }
        let gClaude = home.appendingPathComponent(".claude", isDirectory: true)
        commands.append(contentsOf: scanCommands(in: gClaude, source: .global))

        skills = dedupeEntries(skills)
        commands = dedupeEntries(commands)
        skills.sort(by: sortOrder)
        commands.sort(by: sortOrder)
        return ScanResult(skills: skills, commands: commands)
    }

    nonisolated private static func sortOrder(_ lhs: SkillEntry, _ rhs: SkillEntry) -> Bool {
        if lhs.source != rhs.source {
            return lhs.source == .project // project first
        }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }

    nonisolated private static func dedupeEntries(_ entries: [SkillEntry]) -> [SkillEntry] {
        var seen = Set<String>()
        return entries.filter { entry in
            let key = dedupeKey(for: entry)
            return seen.insert(key).inserted
        }
    }

    nonisolated private static func dedupeKey(for entry: SkillEntry) -> String {
        let normalizedName = normalizeIdentity(entry.name)
        let normalizedPath = normalizeIdentity(entry.displayPath)
        let fileStem = normalizeIdentity(entry.fileURL.deletingPathExtension().lastPathComponent)
        return "\(entry.kind):\(normalizedName.isEmpty ? normalizedPath : normalizedName):\(fileStem)"
    }

    nonisolated private static func normalizeIdentity(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
    }

    nonisolated private static func scanSkills(in claudeDir: URL, source: SkillSource) -> [SkillEntry] {
        // FileManager.contentsOfDirectory(at:) returns ENOTDIR on a URL that
        // is itself a symlink to a directory (e.g. ~/.claude/skills → ~/Documents/...).
        // Resolve symlinks in the path before opening.
        let skillsDir = claudeDir.appendingPathComponent("skills", isDirectory: true)
            .resolvingSymlinksInPath()
        let contents: [URL]
        do {
            contents = try FileManager.default.contentsOfDirectory(
                at: skillsDir,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
        } catch {
            return []
        }

        var results: [SkillEntry] = []
        for dir in contents {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir),
                  isDir.boolValue else { continue }
            let skillMD = dir.appendingPathComponent("SKILL.md")
            guard FileManager.default.fileExists(atPath: skillMD.path) else { continue }
            guard let entry = makeEntry(
                fileURL: skillMD,
                kind: .skill,
                source: source,
                fallbackName: dir.lastPathComponent,
                displayPath: dir.lastPathComponent
            ) else { continue }
            results.append(entry)
        }
        return results
    }

    nonisolated private static func scanCommands(in claudeDir: URL, source: SkillSource) -> [SkillEntry] {
        // Same symlink caveat as scanSkills — enumerator silently returns
        // zero items when the root URL is a symlink, so resolve first.
        let commandsDir = claudeDir.appendingPathComponent("commands", isDirectory: true)
            .resolvingSymlinksInPath()
        guard let enumerator = FileManager.default.enumerator(
            at: commandsDir,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        let commandsBaseComponents = commandsDir.standardizedFileURL.pathComponents
        var results: [SkillEntry] = []
        for case let url as URL in enumerator {
            guard url.pathExtension.lowercased() == "md" else { continue }
            let fileComponents = url.deletingPathExtension().standardizedFileURL.pathComponents
            var displayPath: String
            if fileComponents.count > commandsBaseComponents.count,
               Array(fileComponents.prefix(commandsBaseComponents.count)) == commandsBaseComponents {
                let relative = fileComponents.suffix(from: commandsBaseComponents.count)
                displayPath = relative.joined(separator: ":")
            } else {
                displayPath = url.deletingPathExtension().lastPathComponent
            }
            let fallbackName = url.deletingPathExtension().lastPathComponent
            if displayPath.isEmpty { displayPath = fallbackName }
            guard let entry = makeEntry(
                fileURL: url,
                kind: .command,
                source: source,
                fallbackName: fallbackName,
                displayPath: displayPath
            ) else { continue }
            results.append(entry)
        }
        return results
    }

    nonisolated private static func makeEntry(
        fileURL: URL,
        kind: SkillKind,
        source: SkillSource,
        fallbackName: String,
        displayPath: String
    ) -> SkillEntry? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        let limited: Data = data.count > fileSizeCap ? data.prefix(fileSizeCap) : data
        guard let raw = String(data: limited, encoding: .utf8) else { return nil }

        var parsed = SkillFrontmatterParser.parse(raw)
        if data.count > fileSizeCap {
            parsed = SkillFrontmatter(
                name: parsed.name,
                description: parsed.description,
                body: parsed.body + "\n\n…"
            )
        }

        let displayName = (parsed.name?.isEmpty == false) ? parsed.name! : fallbackName
        let id = "\(source):\(kind):\(fileURL.standardizedFileURL.path)"
        return SkillEntry(
            id: id,
            name: displayName,
            displayPath: displayPath,
            description: parsed.description,
            body: parsed.body,
            source: source,
            kind: kind,
            fileURL: fileURL
        )
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation

struct PlanFolderSpec: Identifiable, Hashable {
    let path: String
    let sectionTitle: String
    let resolvedURL: URL

    var id: String { path }

    fileprivate static func make(path: String, projectRoot: URL) -> PlanFolderSpec? {
        let normalized = PlanFolderSettings.normalize(path: path)
        guard !normalized.isEmpty else { return nil }

        let resolvedURL: URL
        if normalized.hasPrefix("/") {
            resolvedURL = URL(fileURLWithPath: normalized, isDirectory: true)
        } else if normalized == "." {
            resolvedURL = projectRoot
        } else {
            resolvedURL = projectRoot.appendingPathComponent(normalized, isDirectory: true)
        }

        return PlanFolderSpec(
            path: normalized,
            sectionTitle: sectionTitle(for: normalized),
            resolvedURL: resolvedURL
        )
    }

    private static func sectionTitle(for path: String) -> String {
        switch path {
        case "docs/superpowers/specs":
            return String(localized: "plan.section.specs",
                          defaultValue: "SPECS", table: "TermLoop")
        case "docs/superpowers/plans":
            return String(localized: "plan.section.plans",
                          defaultValue: "PLANS", table: "TermLoop")
        case ".":
            return String(localized: "plan.section.projectRoot",
                          defaultValue: "PROJECT ROOT", table: "TermLoop")
        default:
            let lastComponent = URL(fileURLWithPath: path).lastPathComponent
            let base = lastComponent.isEmpty ? path : lastComponent
            return base.replacingOccurrences(of: "-", with: " ").uppercased()
        }
    }
}

@MainActor
final class PlanFolderSettings: ObservableObject {
    static let shared = PlanFolderSettings()

    static let defaultFolderPaths: [String] = [
        "docs/superpowers/specs",
        "docs/superpowers/plans",
    ]

    @Published private(set) var folderPaths: [String] {
        didSet {
            defaults.set(folderPaths, forKey: Self.defaultsKey)
        }
    }

    private static let defaultsKey = "termloop.plan.folderPaths"
    private let defaults = UserDefaults.standard

    private init() {
        let stored = (UserDefaults.standard.array(forKey: Self.defaultsKey) as? [String] ?? [])
            .map(Self.normalize(path:))
            .filter { !$0.isEmpty }

        if stored.isEmpty {
            self.folderPaths = Self.defaultFolderPaths
        } else {
            self.folderPaths = Self.uniquePaths(stored)
        }
    }

    var refreshSignature: String {
        folderPaths.joined(separator: "\n")
    }

    func folderSpecs(projectRoot: URL?) -> [PlanFolderSpec] {
        guard let projectRoot else { return [] }
        return folderPaths.compactMap { PlanFolderSpec.make(path: $0, projectRoot: projectRoot) }
    }

    func addFolder(from selectedURL: URL, projectRoot: URL?) -> AddFolderResult {
        let normalized = Self.persistedPath(for: selectedURL, projectRoot: projectRoot)
        guard !normalized.isEmpty else { return .invalidPath }
        if folderPaths.contains(where: { $0.caseInsensitiveCompare(normalized) == .orderedSame }) {
            return .duplicate
        }
        folderPaths.append(normalized)
        return .added
    }

    func removeFolder(path: String) {
        folderPaths.removeAll { $0 == path }
        if folderPaths.isEmpty {
            folderPaths = Self.defaultFolderPaths
        }
    }

    func resetToDefaults() {
        folderPaths = Self.defaultFolderPaths
    }

    nonisolated static func normalize(path: String) -> String {
        let trimmed = path
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
        guard !trimmed.isEmpty else { return "" }
        if trimmed == "." { return "." }

        let components = trimmed.split(separator: "/", omittingEmptySubsequences: true)
        let rebuilt = components.joined(separator: "/")
        if trimmed.hasPrefix("/") {
            return "/" + rebuilt
        }
        return rebuilt
    }

    nonisolated private static func uniquePaths(_ paths: [String]) -> [String] {
        var seen: [String] = []
        for path in paths where !seen.contains(where: { $0.caseInsensitiveCompare(path) == .orderedSame }) {
            seen.append(path)
        }
        return seen
    }

    nonisolated private static func persistedPath(for selectedURL: URL, projectRoot: URL?) -> String {
        let selectedPath = selectedURL.standardizedFileURL.path
        guard let projectRoot else { return normalize(path: selectedPath) }

        let rootPath = projectRoot.standardizedFileURL.path
        if selectedPath == rootPath {
            return "."
        }

        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        if selectedPath.hasPrefix(prefix) {
            let relative = String(selectedPath.dropFirst(prefix.count))
            return normalize(path: relative)
        }

        return normalize(path: selectedPath)
    }

    enum AddFolderResult {
        case added
        case duplicate
        case invalidPath
    }
}

struct PlanFileEntry: Identifiable, Hashable {
    let url: URL
    let folder: PlanFolderSpec
    let datePrefix: String?

    var id: String { url.path }
    var filename: String { url.lastPathComponent }
    var displayTitle: String {
        let name = url.deletingPathExtension().lastPathComponent
        if let date = datePrefix, name.hasPrefix(date + "-") {
            return String(name.dropFirst(date.count + 1))
        }
        return name
    }

    init(url: URL, folder: PlanFolderSpec) {
        self.url = url
        self.folder = folder
        self.datePrefix = Self.parseDatePrefix(url)
    }

    private static func parseDatePrefix(_ url: URL) -> String? {
        let name = url.deletingPathExtension().lastPathComponent
        guard name.count >= 10 else { return nil }
        let prefix = String(name.prefix(10))
        let parts = prefix.split(separator: "-")
        guard parts.count == 3,
              parts[0].count == 4, parts[0].allSatisfy(\.isNumber),
              parts[1].count == 2, parts[1].allSatisfy(\.isNumber),
              parts[2].count == 2, parts[2].allSatisfy(\.isNumber) else { return nil }
        return prefix
    }
}

enum PlanFileScanner {
    static func scan(projectRoot: URL, folders: [PlanFolderSpec]) -> [PlanFolderSpec: [PlanFileEntry]] {
        var result: [PlanFolderSpec: [PlanFileEntry]] = [:]
        for folder in folders {
            result[folder] = sortedEntries(in: folder.resolvedURL, folder: folder)
        }
        return result
    }

    private static func sortedEntries(
        in directory: URL,
        folder: PlanFolderSpec
    ) -> [PlanFileEntry] {
        let entries = markdownFiles(in: directory)
            .map { PlanFileEntry(url: $0, folder: folder) }
        return entries.sorted { lhs, rhs in
            switch (lhs.datePrefix, rhs.datePrefix) {
            case let (l?, r?) where l != r: return l > r
            default: return lhs.filename < rhs.filename
            }
        }
    }

    private static func markdownFiles(in directory: URL) -> [URL] {
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        return contents.filter { $0.pathExtension == "md" }
    }
}

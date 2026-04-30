// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Item kinds that can appear in the `@` autocomplete popup inside the
/// QuickAction composer.
enum QuickActionAutocompleteKind {
    case folder
    case workspace
    case markdown
}

struct QuickActionAutocompleteItem: Identifiable, Hashable {
    let id: String
    let displayName: String
    let insertText: String
    let subtitle: String?
    let kind: QuickActionAutocompleteKind
}

/// Context the controller needs to build the candidate list. All values are
/// captured lazily via the provider closure so the composer does not need to
/// hold a direct reference to the view model.
struct QuickActionAutocompleteContext {
    var projectId: UUID?
    var targetWorkspaceId: UUID?
    /// Filesystem path used for `git ls-files '*.md'`. nil disables markdown.
    var targetWorkspacePath: String?
}

/// Caches `git ls-files '*.md'` per working tree path with a short TTL so the
/// popup does not re-shell on every keystroke.
actor MarkdownFileIndex {
    static let shared = MarkdownFileIndex()

    private struct Entry {
        let paths: [String]
        let expiresAt: Date
    }

    private var cache: [String: Entry] = [:]
    private let ttl: TimeInterval = 30
    private let maxResults = 500

    func paths(for workingTree: String) async -> [String] {
        if let entry = cache[workingTree], entry.expiresAt > Date() {
            return entry.paths
        }
        let paths = await Self.runGitLsFiles(at: workingTree, limit: maxResults)
        cache[workingTree] = Entry(paths: paths, expiresAt: Date().addingTimeInterval(ttl))
        return paths
    }

    func invalidate(workingTree: String) {
        cache.removeValue(forKey: workingTree)
    }

    private static func runGitLsFiles(at path: String, limit: Int) async -> [String] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let output: String
                do {
                    output = try GitCommandRunner.runThrowing(
                        ["ls-files", "*.md", "**/*.md"],
                        in: path,
                        kind: .genericRead,
                        caller: "QuickActionAutocompleteSource.markdownFiles",
                        timeout: 5
                    )
                } catch {
                    continuation.resume(returning: [])
                    return
                }
                var seen = Set<String>()
                var results: [String] = []
                for line in output.split(separator: "\n") {
                    let rel = String(line)
                    if seen.insert(rel).inserted {
                        results.append(rel)
                        if results.count >= limit { break }
                    }
                }
                continuation.resume(returning: results)
            }
        }
    }
}

enum QuickActionAutocompleteSource {
    static let maxResults = 500

    /// Gather candidates for the given context. Folder/workspace lists are
    /// resolved on the main actor; markdown is pulled from the actor cache.
    @MainActor
    static func candidates(
        for context: QuickActionAutocompleteContext
    ) async -> [QuickActionAutocompleteItem] {
        var items: [QuickActionAutocompleteItem] = []

        if let projectId = context.projectId {
            if let tabs = AppDelegate.shared?.tabManager?.tabs {
                let workspaces = tabs.filter { $0.projectId == projectId }
                    .sorted {
                        QuickActionWorkspaceTargetPill
                            .workspaceDisplayName($0)
                            .localizedCaseInsensitiveCompare(
                                QuickActionWorkspaceTargetPill.workspaceDisplayName($1)
                            ) == .orderedAscending
                    }
                for ws in workspaces {
                    let name = QuickActionWorkspaceTargetPill.workspaceDisplayName(ws)
                    let insert = escapeInsert(name)
                    items.append(QuickActionAutocompleteItem(
                        id: "ws:\(ws.id.uuidString)",
                        displayName: name,
                        insertText: insert,
                        subtitle: String(
                            localized: "quickAction.autocomplete.kind.workspace",
                            defaultValue: "workspace",
                            table: "TermLoop"
                        ),
                        kind: .workspace
                    ))
                }
            }
        }

        if let path = context.targetWorkspacePath {
            let paths = await MarkdownFileIndex.shared.paths(for: path)
            let disambiguationCounts = Dictionary(grouping: paths, by: { ($0 as NSString).lastPathComponent })
                .mapValues { $0.count }
            for rel in paths {
                let filename = (rel as NSString).lastPathComponent
                let display: String
                if (disambiguationCounts[filename] ?? 0) > 1 {
                    display = rel
                } else {
                    display = filename
                }
                items.append(QuickActionAutocompleteItem(
                    id: "md:\(rel)",
                    displayName: display,
                    insertText: escapeInsert(display),
                    subtitle: rel,
                    kind: .markdown
                ))
            }
        }

        return items
    }

    /// Substring match, case-insensitive. Entries whose name starts with the
    /// query rank above pure substring hits. Stable within each bucket.
    static func filter(
        _ items: [QuickActionAutocompleteItem],
        query: String
    ) -> [QuickActionAutocompleteItem] {
        let trimmed = query.lowercased()
        if trimmed.isEmpty {
            return Array(items.prefix(maxResults))
        }
        var prefixHits: [QuickActionAutocompleteItem] = []
        var substringHits: [QuickActionAutocompleteItem] = []
        for item in items {
            let lower = item.displayName.lowercased()
            if lower.hasPrefix(trimmed) {
                prefixHits.append(item)
            } else if lower.contains(trimmed) {
                substringHits.append(item)
            }
        }
        var combined = prefixHits
        combined.append(contentsOf: substringHits)
        if combined.count > maxResults {
            combined = Array(combined.prefix(maxResults))
        }
        return combined
    }

    /// If the name contains whitespace the LLM-facing serialization would
    /// break on the first space, so wrap it in quotes. Otherwise return as-is.
    private static func escapeInsert(_ raw: String) -> String {
        let needsQuoting = raw.rangeOfCharacter(from: .whitespacesAndNewlines) != nil
        return needsQuoting ? "\"\(raw)\"" : raw
    }
}

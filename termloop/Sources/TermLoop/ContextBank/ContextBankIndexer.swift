// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Scans a project root for `CLAUDE.md` / `AGENTS.md` files.
/// Walks the tree but prunes well-known noisy directories (git metadata,
/// worktree checkouts, dependency caches) so the tree stays focused on
/// human-authored context.
enum ContextBankIndexer {
    static let targetNames: Set<String> = Set(ContextBankFile.Kind.allFileNames)

    /// Directory names that should never be walked when searching for
    /// context files. Shared between the indexer and the symlink planner so
    /// both see the same project tree.
    static let prunedDirectoryNames: Set<String> = [
        ".git",
        ".build",
        ".svn",
        ".hg",
        "node_modules",
        "DerivedData",
        ".termloop-worktrees",
        "Pods",
        ".venv",
        "venv",
        "__pycache__",
        ".next",
        "dist",
        "build",
    ]

    static func scan(projectRoot: URL) -> [ContextBankFile] {
        let fm = FileManager.default
        var results: [ContextBankFile] = []

        let keys: [URLResourceKey] = [
            .isDirectoryKey,
            .contentModificationDateKey,
            .nameKey,
            .isSymbolicLinkKey,
        ]

        guard let enumerator = fm.enumerator(
            at: projectRoot.standardizedFileURL,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles]
        ) else { return [] }

        for case let url as URL in enumerator {
            if Task.isCancelled { return [] }
            let values = try? url.resourceValues(forKeys: Set(keys))
            let isDir = values?.isDirectory ?? false
            let name = values?.name ?? url.lastPathComponent

            if isDir {
                if prunedDirectoryNames.contains(name) {
                    enumerator.skipDescendants()
                }
                continue
            }

            guard targetNames.contains(name) else { continue }

            guard let content = try? String(contentsOf: url, encoding: .utf8) else { continue }
            let lineCount = content.split(separator: "\n", omittingEmptySubsequences: false).count
            guard let kind = ContextBankFile.Kind.from(fileName: name) else { continue }
            let mtime = values?.contentModificationDate ?? .distantPast
            let relative = Self.relativePath(of: url, from: projectRoot)
            let limit = ContextBankLineLimits.defaultLimit(for: url, projectRoot: projectRoot)
            let isSymlink = values?.isSymbolicLink ?? false
            let target = isSymlink
                ? (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path))
                : nil

            results.append(ContextBankFile(
                url: url,
                relativePath: relative,
                kind: kind,
                content: content,
                lineCount: lineCount,
                lineLimit: limit,
                mtime: mtime,
                isSymlink: isSymlink,
                symlinkTargetName: target
            ))
        }

        results.sort { lhs, rhs in
            if lhs.relativePath == rhs.relativePath { return false }
            return lhs.relativePath < rhs.relativePath
        }
        return results
    }

    /// Cheap fingerprint of a scan result. Lets the store skip re-publishing
    /// `files`/`tree` when nothing meaningful changed, without paying the
    /// cost of comparing every file's `content` string on the main actor.
    static func signature(of files: [ContextBankFile]) -> Int {
        var hasher = Hasher()
        hasher.combine(files.count)
        for file in files {
            hasher.combine(file.url)
            hasher.combine(file.mtime)
            hasher.combine(file.lineCount)
            hasher.combine(file.lineLimit)
            hasher.combine(file.isSymlink)
            hasher.combine(file.symlinkTargetName)
        }
        return hasher.finalize()
    }

    private static func relativePath(of url: URL, from root: URL) -> String {
        let rootPath = root.standardizedFileURL.path
        let filePath = url.standardizedFileURL.path
        guard filePath.hasPrefix(rootPath) else { return filePath }
        let tail = String(filePath.dropFirst(rootPath.count))
        return tail.hasPrefix("/") ? String(tail.dropFirst()) : tail
    }
}

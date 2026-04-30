// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Rendered row in the Context Bank tree view. Branches:
///
/// - `folder` — directory header (possibly compressed chain `a/b/c`).
/// - `file` — existing context file leaf.
/// - `newFile` — virtual leaf for an `add` proposal whose `target_path`
///    does not yet exist on disk; user accept will create it.
/// - `suggestion` — child of a `file` or `newFile`; the curator's
///    proposed entry (add/replace/move). One suggestion per row.
indirect enum ContextBankTreeNode: Identifiable, Equatable {
    case folder(id: String, label: String, depth: Int, children: [ContextBankTreeNode])
    case file(file: ContextBankFile, depth: Int, hasProposals: Bool)
    case newFile(path: String, depth: Int)
    case suggestion(suggestion: ContextBankSuggestion, depth: Int)

    var id: String {
        switch self {
        case .folder(let id, _, _, _): return "dir:" + id
        case .file(let f, _, _): return "file:" + f.url.path
        case .newFile(let path, _): return "newfile:" + path
        case .suggestion(let s, _): return "sugg:" + s.id.uuidString
        }
    }

    var depth: Int {
        switch self {
        case .folder(_, _, let d, _): return d
        case .file(_, let d, _): return d
        case .newFile(_, let d): return d
        case .suggestion(_, let d): return d
        }
    }
}

/// Builds a compact tree out of a flat file list and a set of pending
/// suggestions. Linear folder chains are merged into a single row so
/// `a/b/c/CLAUDE.md` surfaces as one folder header `a/b/c` instead of
/// three nested disclosure rows. Suggestions are attached as child rows
/// of their target file (or as a virtual `newFile` row when the target
/// path is not yet on disk).
enum ContextBankTreeBuilder {
    private final class BuildNode {
        let name: String
        var children: [String: BuildNode] = [:]
        var files: [ContextBankFile] = []
        /// Suggestions whose `target_path` matches the absolute path of a
        /// file in this directory. Keyed by absolute path so multiple
        /// suggestions targeting the same file group naturally.
        var newFileSuggestions: [String: [ContextBankSuggestion]] = [:]
        init(name: String) { self.name = name }
    }

    /// Convenience for the existing call site that doesn't yet pass
    /// suggestions. Equivalent to `build(from:files, suggestions: [])`.
    static func build(from files: [ContextBankFile]) -> [ContextBankTreeNode] {
        return build(from: files, suggestions: [])
    }

    static func build(
        from files: [ContextBankFile],
        suggestions: [ContextBankSuggestion]
    ) -> [ContextBankTreeNode] {
        let pending = suggestions.filter { $0.status == .pending }
        let existingPaths = Set(files.map { $0.url.path })

        // Group pending suggestions by target file path.
        var suggestionsByExistingPath: [String: [ContextBankSuggestion]] = [:]
        var newFileSuggestionsByPath: [String: [ContextBankSuggestion]] = [:]
        for suggestion in pending {
            let resolvedTargetPath = (suggestion.targetPath as NSString).resolvingSymlinksInPath
            if existingPaths.contains(suggestion.targetPath)
                || files.contains(where: { (($0.url.path as NSString).resolvingSymlinksInPath) == resolvedTargetPath }) {
                // Existing file (possibly via symlink resolution).
                let canonical = files.first(where: {
                    $0.url.path == suggestion.targetPath
                        || ($0.url.path as NSString).resolvingSymlinksInPath == resolvedTargetPath
                })?.url.path ?? suggestion.targetPath
                suggestionsByExistingPath[canonical, default: []].append(suggestion)
            } else {
                newFileSuggestionsByPath[suggestion.targetPath, default: []].append(suggestion)
            }
        }

        let root = BuildNode(name: "")
        // Insert existing files into their directory chain.
        for file in files {
            let parts = file.relativePath
                .split(separator: "/", omittingEmptySubsequences: true)
                .map(String.init)
            let dirParts = parts.dropLast()
            var node = root
            for dir in dirParts {
                if let child = node.children[dir] {
                    node = child
                } else {
                    let child = BuildNode(name: dir)
                    node.children[dir] = child
                    node = child
                }
            }
            node.files.append(file)
        }

        // Insert virtual new-file proposals into their directory chain.
        // The path is interpreted relative to the project root if possible
        // (longest common prefix with any existing file's url) else as an
        // absolute path's basename — but for simplicity we just split by
        // '/' from a heuristic project root: the deepest common ancestor
        // shared with any existing file. This isn't exact, but fine for
        // grouping in the tree.
        let projectRootPath = inferProjectRootPath(from: files)
        for (newFileAbsPath, suggestions) in newFileSuggestionsByPath {
            let relative: String
            if let projectRootPath, newFileAbsPath.hasPrefix(projectRootPath + "/") {
                relative = String(newFileAbsPath.dropFirst(projectRootPath.count + 1))
            } else {
                relative = (newFileAbsPath as NSString).lastPathComponent
            }
            let parts = relative
                .split(separator: "/", omittingEmptySubsequences: true)
                .map(String.init)
            let dirParts = parts.dropLast()
            var node = root
            for dir in dirParts {
                if let child = node.children[dir] {
                    node = child
                } else {
                    let child = BuildNode(name: dir)
                    node.children[dir] = child
                    node = child
                }
            }
            node.newFileSuggestions[newFileAbsPath, default: []].append(contentsOf: suggestions)
        }

        return convertChildren(
            of: root,
            parentId: "",
            depth: 0,
            suggestionsByExistingPath: suggestionsByExistingPath
        )
    }

    private static func inferProjectRootPath(from files: [ContextBankFile]) -> String? {
        guard let first = files.first else { return nil }
        // Heuristic: `relativePath` is `<a>/<b>/...`. Project root path is
        // `url.path` minus that suffix.
        let absPath = first.url.path
        let rel = first.relativePath
        guard absPath.hasSuffix(rel) else { return nil }
        let trimmed = String(absPath.dropLast(rel.count))
        return trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
    }

    private static func convertChildren(
        of node: BuildNode,
        parentId: String,
        depth: Int,
        suggestionsByExistingPath: [String: [ContextBankSuggestion]]
    ) -> [ContextBankTreeNode] {
        var result: [ContextBankTreeNode] = []

        let sortedDirs = node.children.keys.sorted()
        for dirName in sortedDirs {
            guard let directChild = node.children[dirName] else { continue }

            var label = dirName
            var current = directChild
            while current.files.isEmpty
                && current.newFileSuggestions.isEmpty
                && current.children.count == 1 {
                guard let (nextName, nextChild) = current.children.first else { break }
                label += "/" + nextName
                current = nextChild
            }

            let id = parentId.isEmpty ? label : parentId + "/" + label
            let children = convertChildren(
                of: current,
                parentId: id,
                depth: depth + 1,
                suggestionsByExistingPath: suggestionsByExistingPath
            )
            result.append(.folder(id: id, label: label, depth: depth, children: children))
        }

        let sortedFiles = node.files.sorted { lhs, rhs in
            lhs.url.lastPathComponent < rhs.url.lastPathComponent
        }
        for file in sortedFiles {
            let attached = suggestionsByExistingPath[file.url.path] ?? []
            result.append(.file(file: file, depth: depth, hasProposals: !attached.isEmpty))
            for suggestion in attached {
                result.append(.suggestion(suggestion: suggestion, depth: depth + 1))
            }
        }

        let sortedNewFiles = node.newFileSuggestions.keys.sorted {
            ($0 as NSString).lastPathComponent < ($1 as NSString).lastPathComponent
        }
        for newFilePath in sortedNewFiles {
            result.append(.newFile(path: newFilePath, depth: depth))
            for suggestion in node.newFileSuggestions[newFilePath] ?? [] {
                result.append(.suggestion(suggestion: suggestion, depth: depth + 1))
            }
        }

        return result
    }

    /// Flattens the tree into the sequence of visible rows given a
    /// `collapsedIds` set. Nodes inside a collapsed folder are skipped.
    static func flatten(
        _ nodes: [ContextBankTreeNode],
        collapsedIds: Set<String>
    ) -> [ContextBankTreeNode] {
        var out: [ContextBankTreeNode] = []
        for node in nodes {
            out.append(node)
            if case .folder(let id, _, _, let children) = node,
               !collapsedIds.contains(id) {
                out.append(contentsOf: flatten(children, collapsedIds: collapsedIds))
            }
        }
        return out
    }
}

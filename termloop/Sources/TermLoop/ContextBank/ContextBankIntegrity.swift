// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct ContextBankIntegrityIssue: Identifiable, Equatable {
    enum Kind: String, Equatable {
        case contextSymlink
        case brokenSymlink
        case divergentSiblings
    }

    let kind: Kind
    let relativePath: String
    let message: String

    var id: String { "\(kind.rawValue):\(relativePath)" }
}

enum ContextBankIntegrityChecker {
    private enum EntryKind: Equatable {
        case regular(Data)
        case symlink(target: String, targetExists: Bool)
        case other
    }

    private struct Entry {
        let url: URL
        let directoryPath: String
        let name: String
        let kind: EntryKind
    }

    static func scan(projectRoot: URL) -> [ContextBankIntegrityIssue] {
        let entries = contextEntries(projectRoot: projectRoot)
        var issues: [ContextBankIntegrityIssue] = []

        for entry in entries {
            switch entry.kind {
            case .symlink(let target, let targetExists):
                let relative = relativePath(of: entry.url, from: projectRoot)
                if targetExists {
                    issues.append(ContextBankIntegrityIssue(
                        kind: .contextSymlink,
                        relativePath: relative,
                        message: "\(relative) is a symlink to \(target). Convert it to a real file copy."
                    ))
                } else {
                    issues.append(ContextBankIntegrityIssue(
                        kind: .brokenSymlink,
                        relativePath: relative,
                        message: "\(relative) is a broken symlink to \(target)."
                    ))
                }
            case .regular, .other:
                continue
            }
        }

        let grouped = Dictionary(grouping: entries) { $0.directoryPath }
        for (dir, entries) in grouped {
            let regulars = entries.compactMap { entry -> (name: String, data: Data)? in
                if case .regular(let data) = entry.kind {
                    return (entry.name, data)
                }
                return nil
            }
            guard regulars.count > 1, let baseline = regulars.first?.data else { continue }
            guard regulars.contains(where: { $0.data != baseline }) else { continue }
            let names = regulars.map(\.name).sorted().joined(separator: ", ")
            let relativeDir = relativePath(of: URL(fileURLWithPath: dir, isDirectory: true), from: projectRoot)
            issues.append(ContextBankIntegrityIssue(
                kind: .divergentSiblings,
                relativePath: relativeDir.isEmpty ? "." : relativeDir,
                message: "\(relativeDir.isEmpty ? "." : relativeDir): context siblings differ (\(names)). Reconcile before mirroring."
            ))
        }

        return issues.sorted {
            if $0.relativePath == $1.relativePath {
                return $0.kind.rawValue < $1.kind.rawValue
            }
            return $0.relativePath < $1.relativePath
        }
    }

    private static func contextEntries(projectRoot: URL) -> [Entry] {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.isDirectoryKey, .nameKey]
        guard let enumerator = fm.enumerator(
            at: projectRoot.standardizedFileURL,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var entries: [Entry] = []
        for case let url as URL in enumerator {
            if Task.isCancelled { return [] }
            let values = try? url.resourceValues(forKeys: Set(keys))
            let name = values?.name ?? url.lastPathComponent
            let isDir = values?.isDirectory ?? false

            if isDir {
                if ContextBankIndexer.prunedDirectoryNames.contains(name) {
                    enumerator.skipDescendants()
                }
                continue
            }

            guard ContextBankIndexer.targetNames.contains(name) else { continue }
            entries.append(Entry(
                url: url,
                directoryPath: url.deletingLastPathComponent().path,
                name: name,
                kind: kind(at: url)
            ))
        }
        return entries
    }

    private static func kind(at url: URL) -> EntryKind {
        let path = url.path
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let type = attrs[.type] as? FileAttributeType
        else { return .other }

        switch type {
        case .typeSymbolicLink:
            let target = (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) ?? ""
            let targetPath: String
            if target.hasPrefix("/") {
                targetPath = target
            } else {
                targetPath = (url.deletingLastPathComponent().path as NSString)
                    .appendingPathComponent(target)
            }
            return .symlink(target: target, targetExists: isRegularFile(at: targetPath))
        case .typeRegular:
            guard let data = try? Data(contentsOf: url) else { return .other }
            return .regular(data)
        default:
            return .other
        }
    }

    private static func isRegularFile(at path: String) -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let type = attrs[.type] as? FileAttributeType
        else { return false }
        return type == .typeRegular
    }

    private static func relativePath(of url: URL, from root: URL) -> String {
        let path = (url.path as NSString).standardizingPath
        let rootPath = [
            root.path,
            root.standardizedFileURL.path,
            (root.path as NSString).resolvingSymlinksInPath,
        ]
            .map { ($0 as NSString).standardizingPath }
            .filter { path.hasPrefix($0) }
            .max(by: { $0.count < $1.count })

        guard let rootPath else { return path }
        let tail = String(path.dropFirst(rootPath.count))
        return tail.hasPrefix("/") ? String(tail.dropFirst()) : tail
    }
}

// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public struct TaskResolvedWorktreePath: Equatable, Sendable {
    /// Canonical idempotency key for persisted task/worktree matching.
    public let keyPath: String
    /// Standardized absolute path used when talking to existing UI/git stores.
    public let displayPath: String
    /// Short human-facing label for compact UI rows.
    public let leafName: String
}

public enum TaskPathNormalization {
    public static func resolveDisplayAndKey(
        _ path: String?,
        relativeTo projectRoot: URL? = nil
    ) -> TaskResolvedWorktreePath? {
        let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }

        let displayURL = absoluteURL(trimmed, relativeTo: projectRoot)
            .standardizedFileURL
        let displayPath = stripTrailingSlash(displayURL.path)
        let keyPath = normalize(trimmed, relativeTo: projectRoot)
        return TaskResolvedWorktreePath(
            keyPath: keyPath,
            displayPath: displayPath,
            leafName: displayURL.lastPathComponent
        )
    }

    /// Resolve a possibly-relative or symlinked path to a canonical absolute path
    /// suitable for use as part of an idempotency key.
    /// Trailing slashes are stripped. On case-insensitive volumes the result is
    /// lowercased; on case-sensitive volumes the original case is preserved.
    public static func normalize(
        _ path: String,
        relativeTo projectRoot: URL? = nil
    ) -> String {
        let url = absoluteURL(path, relativeTo: projectRoot)
            .standardized
            .resolvingSymlinksInPath()

        var result = url.path
        result = stripTrailingSlash(result)

        if isCaseInsensitiveVolume(at: url) {
            result = result.lowercased()
        }
        return result
    }

    private static func absoluteURL(_ path: String, relativeTo projectRoot: URL?) -> URL {
        if path.hasPrefix("/") { return URL(fileURLWithPath: path) }
        let base = projectRoot ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        return URL(fileURLWithPath: path, relativeTo: base).absoluteURL
    }

    private static func stripTrailingSlash(_ path: String) -> String {
        var result = path
        while result.hasSuffix("/") && result != "/" {
            result.removeLast()
        }
        return result
    }

    private static func isCaseInsensitiveVolume(at url: URL) -> Bool {
        var values: URLResourceValues?
        do {
            values = try url.resourceValues(forKeys: [.volumeSupportsCaseSensitiveNamesKey])
        } catch {
            return true // safer default on macOS
        }
        if let supports = values?.volumeSupportsCaseSensitiveNames {
            return supports == false
        }
        return true
    }
}

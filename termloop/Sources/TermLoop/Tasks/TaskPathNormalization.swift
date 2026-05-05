// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public enum TaskPathNormalization {
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
        while result.hasSuffix("/") && result != "/" {
            result.removeLast()
        }

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

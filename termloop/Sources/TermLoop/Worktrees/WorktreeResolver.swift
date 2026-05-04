// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import CryptoKit

/// Pure path-resolution helper. Given a project folder and branch name,
/// computes the canonical worktree directory. Does not touch the filesystem.
enum WorktreeResolver {
    static let worktreesDirName = ".termloop-worktrees"

    static func normalizePath(_ rawPath: String?) -> String? {
        let trimmed = rawPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return URL(fileURLWithPath: trimmed).standardizedFileURL.path
    }

    static func path(projectFolder: String, branch: String) -> String? {
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBranch.isEmpty else { return nil }
        guard let normalizedFolder = normalizePath(projectFolder) else { return nil }

        let base = sanitize(trimmedBranch)
        let suffix = (base == trimmedBranch) ? "" : "-" + shortHash(of: trimmedBranch)
        let leaf = base + suffix
        return "\(normalizedFolder)/\(worktreesDirName)/\(leaf)"
    }

    static func worktreeRoot(containing rawPath: String?, projectFolder: String? = nil) -> String? {
        guard let normalized = normalizePath(rawPath) else {
            return nil
        }
        let projectPrefix: String
        if let projectFolder {
            guard let projectRoot = normalizePath(projectFolder) else { return nil }
            projectPrefix = projectRoot + "/" + worktreesDirName + "/"
        } else {
            let marker = "/" + worktreesDirName + "/"
            guard let range = normalized.range(of: marker, options: .backwards) else {
                return nil
            }
            projectPrefix = String(normalized[..<range.upperBound])
        }
        guard normalized.hasPrefix(projectPrefix) else { return nil }
        let remainder = normalized.dropFirst(projectPrefix.count)
        let parts = remainder.split(separator: "/", omittingEmptySubsequences: true)
        guard let leaf = parts.first else { return nil }
        return projectPrefix + String(leaf)
    }

    static func sanitize(_ branch: String) -> String {
        var result = ""
        for scalar in branch.unicodeScalars {
            let c = Character(scalar)
            if c == "/" {
                result.append("__")
            } else if c.isLetter || c.isNumber || c == "." || c == "-" || c == "_" {
                result.append(c)
            } else {
                result.append("_")
            }
        }
        return result
    }

    private static func shortHash(of input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.prefix(2).map { String(format: "%02x", $0) }.joined()
    }
}

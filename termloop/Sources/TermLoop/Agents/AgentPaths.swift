// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Central source of truth for the on-disk locations TermLoop Agents uses.
@MainActor
enum AgentPaths {
    /// `~/Library/Application Support/termloop/agent-templates/`
    static var userTemplatesDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("termloop", isDirectory: true)
                   .appendingPathComponent("agent-templates", isDirectory: true)
    }

    static func ensureDirectoriesExist() throws {
        try FileManager.default.createDirectory(at: userTemplatesDir, withIntermediateDirectories: true)
    }

    /// Returns `<repoRoot>/.termloop/templates` when the given URL lives in a
    /// git-tracked repo; otherwise falls back to `<path>/.termloop/templates`.
    /// Catalog authoring should work for every project folder, not only git
    /// repositories. Walks up to 20 levels looking for `.git`.
    static func projectLocalTemplatesDir(near path: URL) -> URL? {
        let base = path.standardizedFileURL
        var cursor = base
        for _ in 0..<20 {
            let git = cursor.appendingPathComponent(".git")
            if FileManager.default.fileExists(atPath: git.path) {
                return cursor.appendingPathComponent(".termloop", isDirectory: true)
                             .appendingPathComponent("templates", isDirectory: true)
            }
            let parent = cursor.deletingLastPathComponent()
            if parent == cursor { break }
            cursor = parent
        }
        return base.appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("templates", isDirectory: true)
    }
}

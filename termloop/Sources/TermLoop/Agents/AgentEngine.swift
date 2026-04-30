// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// One-stop main-actor singleton the socket/CLI/UI talk to for template access.
@MainActor
final class AgentEngine {
    static let shared = AgentEngine()

    private init() {
        try? AgentPaths.ensureDirectoriesExist()
    }

    /// Called once on app launch from TermLoopHooks after sidecar load.
    func bootstrap(builtinBundleDir: URL?) {
        copyBuiltinsToUserDirIfAbsent(from: builtinBundleDir)
        AgentTemplateStore.shared.startWatching(
            builtinDir: builtinBundleDir,
            userDir: AgentPaths.userTemplatesDir,
            projectDir: nil
        )
    }

    /// Seeds `~/Library/Application Support/termloop/agent-templates/` with bundled
    /// built-ins on first launch. Existing files (including user edits) are
    /// preserved — a template is only copied if the destination does not
    /// already exist. Safe to call on every launch.
    private func copyBuiltinsToUserDirIfAbsent(from bundleDir: URL?) {
        guard let src = bundleDir,
              let files = try? FileManager.default.contentsOfDirectory(
                at: src, includingPropertiesForKeys: nil) else { return }
        try? FileManager.default.createDirectory(
            at: AgentPaths.userTemplatesDir, withIntermediateDirectories: true)
        for f in files where f.pathExtension == "md" {
            let dst = AgentPaths.userTemplatesDir.appendingPathComponent(f.lastPathComponent)
            guard !FileManager.default.fileExists(atPath: dst.path) else { continue }
            try? FileManager.default.copyItem(at: f, to: dst)
        }
    }

    /// Swap project-local template dir when the active workspace changes.
    func updateProjectLocalDir(_ dir: URL?) {
        AgentTemplateStore.shared.startWatching(
            builtinDir: BuiltinTemplates.bundleDir,
            userDir: AgentPaths.userTemplatesDir,
            projectDir: dir
        )
    }
}

enum BuiltinTemplates {
    static var bundleDir: URL? {
        Bundle.main.url(forResource: "BuiltinTemplates", withExtension: nil)
    }
}

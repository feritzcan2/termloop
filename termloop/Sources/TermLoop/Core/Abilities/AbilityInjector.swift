// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Loads project ability bundles used by the agent-input composer.
enum AbilityInjector {
    /// Reads ability files directly from `<projectRoot>/.termloop/abilities`.
    /// This intentionally bypasses `AbilityStore.shared`, which only mirrors
    /// the *active* project's abilities in memory.
    static func loadAbilities(projectFolderPath: String?) -> [Ability] {
        guard let projectFolderPath,
              !projectFolderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return []
        }
        let dir = URL(fileURLWithPath: projectFolderPath, isDirectory: true)
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("abilities", isDirectory: true)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir),
              isDir.boolValue else {
            return []
        }
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        return entries.compactMap { url in
            guard url.hasDirectoryPath else { return nil }
            return try? AbilityBundleStore.load(from: url)
        }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Computes whether `runCwd` sits under the project's `.termloop-worktrees/`
    /// directory (the convention `WorktreeCoordinator` creates). Returns
    /// `false` when either path is missing or the cwd is outside the project.
    static func computeIsWorktree(projectFolder: String?, runCwd: String) -> Bool {
        guard let projectFolder, !projectFolder.isEmpty else { return false }
        let normalizedProject = (projectFolder as NSString).standardizingPath
        let normalizedCwd = (runCwd as NSString).standardizingPath
        return WorktreeResolver.worktreeRoot(
            containing: normalizedCwd,
            projectFolder: normalizedProject
        ) != nil
    }

    /// Resolves the outer project folder used for shared ability lookup. When
    /// a workspace has already been attached into `.termloop-worktrees/<branch>`,
    /// the project metadata may be missing or stale; in that case infer the
    /// owning project by stripping the `.termloop-worktrees/...` suffix.
    @MainActor
    static func resolveProjectFolderPath(projectFolderPath: String?, runCwd: String?) -> String? {
        if let projectFolderPath,
           !projectFolderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let normalizedProjectFolder = (projectFolderPath as NSString).standardizingPath
            if let owningProject = owningProjectFolder(fromWorktreePath: normalizedProjectFolder) {
                return owningProject
            }
            return normalizedProjectFolder
        }
        guard let runCwd,
              !runCwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        let normalizedCwd = (runCwd as NSString).standardizingPath
        guard let owningProject = owningProjectFolder(fromWorktreePath: normalizedCwd) else {
            return nil
        }
        return registeredProjectFolder(matching: owningProject)
    }

    private static func owningProjectFolder(fromWorktreePath path: String) -> String? {
        let marker = "/\(WorktreeResolver.worktreesDirName)/"
        guard let range = path.range(of: marker, options: .backwards) else { return nil }
        return String(path[..<range.lowerBound])
    }

    @MainActor
    private static func registeredProjectFolder(matching folderPath: String) -> String? {
        let normalized = (folderPath as NSString).standardizingPath
        return ProjectStore.shared.projects
            .map(\.folderPath)
            .map { ($0 as NSString).standardizingPath }
            .first { $0 == normalized }
    }

    @MainActor
    static func projectFolderPath(for workspace: Workspace) -> String? {
        guard let projectId = workspace.projectId else { return nil }
        return ProjectStore.shared.project(id: projectId)?.folderPath
    }

    @MainActor
    static func projectFolderPath(matchingRunCwd runCwd: String?) -> String? {
        guard let runCwd,
              !runCwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        let normalizedCwd = (runCwd as NSString).standardizingPath
        return ProjectStore.shared.projects
            .map(\.folderPath)
            .map { ($0 as NSString).standardizingPath }
            .filter { projectPath in
                normalizedCwd == projectPath || normalizedCwd.hasPrefix(projectPath + "/")
            }
            .max(by: { $0.count < $1.count })
    }

    @MainActor
    static func resolvedProjectFolderPath(for workspace: Workspace, runCwd: String?) -> String? {
        projectFolderPath(for: workspace).flatMap {
            resolveProjectFolderPath(projectFolderPath: $0, runCwd: runCwd)
        }
            ?? resolveProjectFolderPath(projectFolderPath: nil, runCwd: runCwd)
            ?? projectFolderPath(matchingRunCwd: runCwd)
    }

    @MainActor
    static func resolvedProjectFolderPath(forWorkspaceId workspaceId: UUID, runCwd: String?) -> String? {
        if let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) {
            return resolvedProjectFolderPath(for: workspace, runCwd: runCwd)
        }
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
        if let projectId = metadata.projectId,
           let folderPath = ProjectStore.shared.project(id: projectId)?.folderPath {
            return resolveProjectFolderPath(projectFolderPath: folderPath, runCwd: runCwd)
                ?? folderPath
        }
        return resolveProjectFolderPath(projectFolderPath: nil, runCwd: runCwd)
            ?? projectFolderPath(matchingRunCwd: runCwd)
    }
}

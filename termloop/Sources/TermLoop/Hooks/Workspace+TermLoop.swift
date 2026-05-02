// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

#if DEBUG
private let workspaceTermLoopLogger = Logger(
    subsystem: "com.termloop.fork",
    category: "worktree-binding"
)

private func workspaceTermLoopDebugLog(_ message: String) {
    workspaceTermLoopLogger.debug("\(message, privacy: .public)")
}
#endif

struct TermLoopWorktreeExpectation: Equatable, Sendable {
    let path: String
    let branch: String

    var environment: [String: String] {
        [
            "TERMLOOP_WORKTREE_BRANCH": branch,
            "TERMLOOP_WORKTREE_PATH": path
        ]
    }
}

enum TermLoopWorktreeBindingResolver {
    static func resolvePath(
        projectFolder: String,
        branch: String,
        service _: GitWorktreeService = GitWorktreeService()
    ) throws -> String {
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBranch.isEmpty else {
            throw WorktreeError.invalidParams(reason: "branch is empty")
        }
        #if DEBUG
        workspaceTermLoopDebugLog("worktree.binding.resolve.begin projectFolder=\(projectFolder) branch=\(trimmedBranch)")
        #endif

        guard let candidate = WorktreeResolver.path(
            projectFolder: projectFolder,
            branch: trimmedBranch
        ) else {
            throw WorktreeError.invalidParams(reason: "could not resolve path")
        }
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate, isDirectory: &isDir),
           isDir.boolValue {
            #if DEBUG
            workspaceTermLoopDebugLog("worktree.binding.resolve.hit candidate=\(candidate) reason=directoryExists")
            #endif
            return candidate
        }

        if currentBranchWithoutGit(projectFolder: projectFolder) == trimmedBranch {
            let normalizedProject = URL(fileURLWithPath: projectFolder)
                .standardizedFileURL
                .path
            var projectIsDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: normalizedProject, isDirectory: &projectIsDir),
               projectIsDir.boolValue {
                #if DEBUG
                workspaceTermLoopDebugLog("worktree.binding.resolve.hit candidate=\(normalizedProject) reason=projectRootBranchMatch")
                #endif
                return normalizedProject
            }
        }

        #if DEBUG
        workspaceTermLoopDebugLog("worktree.binding.resolve.fail projectFolder=\(projectFolder) branch=\(trimmedBranch) candidate=\(candidate)")
        #endif
        throw WorktreeError.worktreeMissingOnDisk(path: candidate)
    }

    /// Best-effort branch read for the main checkout without spawning git.
    ///
    /// Restore/startup paths call this resolver on the main actor. Shelling out
    /// to `git worktree list` from there can hang the whole app if git or pipe
    /// draining stalls, so the resolver only uses TermLoop's canonical
    /// worktree path plus direct `.git/HEAD` file reads.
    private static func currentBranchWithoutGit(projectFolder: String) -> String? {
        let folderURL = URL(fileURLWithPath: projectFolder).standardizedFileURL
        let gitURL = folderURL.appendingPathComponent(".git")
        let headURL: URL

        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: gitURL.path, isDirectory: &isDir),
           isDir.boolValue {
            headURL = gitURL.appendingPathComponent("HEAD")
        } else if let gitFile = try? String(contentsOf: gitURL, encoding: .utf8),
                  let gitDirLine = gitFile
                    .split(whereSeparator: { $0.isNewline })
                    .first(where: { $0.lowercased().hasPrefix("gitdir:") }) {
            let rawGitDir = gitDirLine
                .dropFirst("gitdir:".count)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rawGitDir.isEmpty else { return nil }
            let gitDirURL: URL
            if rawGitDir.hasPrefix("/") {
                gitDirURL = URL(fileURLWithPath: rawGitDir)
            } else {
                gitDirURL = folderURL.appendingPathComponent(rawGitDir)
            }
            headURL = gitDirURL.standardizedFileURL.appendingPathComponent("HEAD")
        } else {
            return nil
        }

        guard let head = try? String(contentsOf: headURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
              head.hasPrefix("ref: refs/heads/") else {
            return nil
        }
        return String(head.dropFirst("ref: refs/heads/".count))
    }

    static func resolveExpectation(
        projectFolder: String?,
        branch: String?
    ) throws -> TermLoopWorktreeExpectation? {
        guard let projectFolder,
              let branch = branch?.trimmingCharacters(in: .whitespacesAndNewlines),
              !projectFolder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !branch.isEmpty else {
            return nil
        }
        return TermLoopWorktreeExpectation(
            path: try resolvePath(projectFolder: projectFolder, branch: branch),
            branch: branch
        )
    }
}

extension Workspace {
    var projectId: UUID? {
        WorkspaceMetadataStore.shared.projectId(forWorkspaceId: id)
    }

    @MainActor
    func termLoopRepoRootPath() -> String? {
        guard let projectId,
              let project = ProjectStore.shared.project(id: projectId) else { return nil }
        return project.folderPath
    }

    /// Working directory to use for brand-new terminal tabs in this workspace.
    /// Returns nil when the workspace has no attached branch — the caller then
    /// falls back to upstream defaults.
    @MainActor
    var termLoopNewTabCwd: String? {
        guard let branch = WorkspaceMetadataStore.shared.branch(for: self),
              let repoRootPath = termLoopRepoRootPath()
        else { return nil }
        if let recorded = termLoopRecordedWorktreeCwd() {
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.newTabCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=recorded path=\(recorded)")
            #endif
            return recorded
        }
        if let liveWorktree = termLoopLiveWorktreeCwd(repoRootPath: repoRootPath) {
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.newTabCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=live path=\(liveWorktree)")
            #endif
            return liveWorktree
        }
        let resolved = try? TermLoopWorktreeBindingResolver.resolvePath(
            projectFolder: repoRootPath,
            branch: branch
        )
        #if DEBUG
        workspaceTermLoopDebugLog("workspace.newTabCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=resolved path=\(resolved ?? "nil")")
        #endif
        return resolved
    }

    /// Trimmed, nil-if-empty variant of `termLoopNewTabCwd`.
    @MainActor
    var termLoopNewTabCwdTrimmed: String? {
        let trimmed = termLoopNewTabCwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Working directory to use when spawning an agent from this workspace.
    /// Attached workspaces must resolve to a real worktree path; otherwise
    /// we fail closed instead of silently falling back to the main checkout.
    /// Unattached workspaces prefer the project root so agent runs stay
    /// deterministic even when panels have drifted elsewhere.
    @MainActor
    func termLoopSpawnCwd() throws -> String? {
        if let branch = WorkspaceMetadataStore.shared.branch(for: self),
           let repoRootPath = termLoopRepoRootPath() {
            if let recorded = termLoopRecordedWorktreeCwd() {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.spawnCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=recorded path=\(recorded)")
                #endif
                return recorded
            }
            if let liveWorktree = termLoopLiveWorktreeCwd(repoRootPath: repoRootPath) {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.spawnCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=live path=\(liveWorktree)")
                #endif
                return liveWorktree
            }
            let resolved = try TermLoopWorktreeBindingResolver.resolvePath(
                projectFolder: repoRootPath,
                branch: branch
            )
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.spawnCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=resolved path=\(resolved)")
            #endif
            return resolved
        }
        if let repoRootPath = termLoopRepoRootPath() {
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.spawnCwd ws=\(id.uuidString.prefix(8)) source=repoRoot path=\(repoRootPath)")
            #endif
            return repoRootPath
        }
        let fallback = panelDirectories.values.first(where: {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        })
        #if DEBUG
        workspaceTermLoopDebugLog("workspace.spawnCwd ws=\(id.uuidString.prefix(8)) source=panelFallback path=\(fallback ?? "nil")")
        #endif
        return fallback
    }

    /// Presentation-only cwd for previews and labels.
    ///
    /// Unlike `termLoopSpawnCwd()`, this never shells out to git, so it is
    /// safe to call from SwiftUI render/update paths. If an attached branch's
    /// canonical worktree directory is missing on disk, prefer the live
    /// shell-reported `.termloop-worktrees/` cwd before falling back to the
    /// project root for display purposes.
    @MainActor
    func termLoopPresentationCwd() -> String? {
        if let branch = WorkspaceMetadataStore.shared.branch(for: self),
           let repoRootPath = termLoopRepoRootPath() {
            if let recorded = termLoopRecordedWorktreeCwd() {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.presentationCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=recorded path=\(recorded)")
                #endif
                return recorded
            }
            if let liveWorktree = termLoopLiveWorktreeCwd(repoRootPath: repoRootPath) {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.presentationCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=live path=\(liveWorktree)")
                #endif
                return liveWorktree
            }
            if let resolved = try? TermLoopWorktreeBindingResolver.resolvePath(
                projectFolder: repoRootPath,
                branch: branch
            ) {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.presentationCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=resolved path=\(resolved)")
                #endif
                return resolved
            }
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.presentationCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=repoRoot path=\(repoRootPath)")
            #endif
            return repoRootPath
        }
        if let repoRootPath = termLoopRepoRootPath() {
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.presentationCwd ws=\(id.uuidString.prefix(8)) source=repoRoot path=\(repoRootPath)")
            #endif
            return repoRootPath
        }
        let fallback = panelDirectories.values.first(where: {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        })
        #if DEBUG
        workspaceTermLoopDebugLog("workspace.presentationCwd ws=\(id.uuidString.prefix(8)) source=panelFallback path=\(fallback ?? "nil")")
        #endif
        return fallback
    }

    @MainActor
    private func termLoopRecordedWorktreeCwd() -> String? {
        guard let raw = WorkspaceMetadataStore.shared.worktreePath(for: self) else { return nil }
        let normalized = URL(fileURLWithPath: raw)
            .standardizedFileURL
            .path
        guard Self.termLoopDirectoryExists(normalized) else { return nil }
        #if DEBUG
        workspaceTermLoopDebugLog("workspace.recordedWorktree ws=\(id.uuidString.prefix(8)) path=\(normalized)")
        #endif
        return normalized
    }

    @MainActor
    private func termLoopLiveWorktreeCwd(repoRootPath: String) -> String? {
        let projectNorm = URL(fileURLWithPath: repoRootPath)
            .standardizedFileURL
            .path
        var seen = Set<String>()
        let candidates = [currentDirectory] + Array(panelDirectories.values)

        for candidate in candidates {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let normalized = URL(fileURLWithPath: trimmed)
                .standardizedFileURL
                .path
            guard seen.insert(normalized).inserted else { continue }
            guard let worktreeRoot = WorktreeResolver.worktreeRoot(
                containing: normalized,
                projectFolder: projectNorm
            ) else { continue }
            guard Self.termLoopDirectoryExists(worktreeRoot) else { continue }
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.liveWorktree ws=\(id.uuidString.prefix(8)) candidate=\(normalized) root=\(worktreeRoot)")
            #endif
            return worktreeRoot
        }

        return nil
    }

    private static func termLoopDirectoryExists(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir)
            && isDir.boolValue
    }

    @MainActor
    func termLoopWorktreeExpectation() throws -> TermLoopWorktreeExpectation? {
        if let branch = WorkspaceMetadataStore.shared.branch(for: self),
           let repoRootPath = termLoopRepoRootPath() {
            if let recorded = termLoopRecordedWorktreeCwd() {
                return TermLoopWorktreeExpectation(path: recorded, branch: branch)
            }
            if let liveWorktree = termLoopLiveWorktreeCwd(repoRootPath: repoRootPath) {
                return TermLoopWorktreeExpectation(path: liveWorktree, branch: branch)
            }
        }
        return try TermLoopWorktreeBindingResolver.resolveExpectation(
            projectFolder: termLoopRepoRootPath(),
            branch: WorkspaceMetadataStore.shared.branch(for: self)
        )
    }

    /// Panels whose shell-reported cwd sits under the project folder but is
    /// not the currently-attached worktree path. Empty when no branch is
    /// attached or every panel is aligned. Panels outside the project (user
    /// navigated to `~/Documents` etc.) are intentionally excluded — those
    /// aren't drift, they're deliberate navigation.
    ///
    /// Read from SwiftUI rows (`WorktreeBadge`) and from menu actions in
    /// `WorktreeMenuItems`. Pure: does not touch disk.
    @MainActor
    var divergentPanelPaths: [(panelId: UUID, path: String)] {
        guard let branch = WorkspaceMetadataStore.shared.branch(for: self),
              let repoRootPath = termLoopRepoRootPath()
        else { return [] }

        let worktree = termLoopRecordedWorktreeCwd()
            ?? termLoopLiveWorktreeCwd(repoRootPath: repoRootPath)
            ?? (try? TermLoopWorktreeBindingResolver.resolvePath(
                projectFolder: repoRootPath,
                branch: branch
            ))
            ?? repoRootPath
        let target = URL(fileURLWithPath: worktree).standardizedFileURL.path
        let projectNorm = URL(fileURLWithPath: repoRootPath)
            .standardizedFileURL.path

        var out: [(UUID, String)] = []
        for (panelId, reported) in panelDirectories {
            let trimmed = reported.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let normalized = URL(fileURLWithPath: trimmed).standardizedFileURL.path
            if normalized == target { continue }
            let isInsideProject = normalized == projectNorm
                || normalized.hasPrefix(projectNorm + "/")
            guard isInsideProject else { continue }
            out.append((panelId, trimmed))
        }
        return out
    }
}

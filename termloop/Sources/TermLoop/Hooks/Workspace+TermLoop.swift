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

enum TermLoopWorktreeHeadReader {
    /// Best-effort branch read for a checkout without spawning git.
    ///
    /// Restore/startup paths call this on the main actor. Shelling out to
    /// `git` from there can hang the whole app if git or pipe draining stalls,
    /// so this only uses direct `.git/HEAD` file reads.
    static func currentBranchWithoutGit(checkoutPath: String) -> String? {
        let folderURL = URL(fileURLWithPath: checkoutPath).standardizedFileURL
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
        if let recorded = termLoopRecordedWorktreeCwd(
            projectRootPath: repoRootPath,
            expectedBranch: branch
        ) {
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.newTabCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=recorded path=\(recorded)")
            #endif
            return recorded
        }
        if let liveWorktree = termLoopLiveWorktreeCwd(
            repoRootPath: repoRootPath,
            expectedBranch: branch
        ) {
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.newTabCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=live path=\(liveWorktree)")
            #endif
            return liveWorktree
        }
        #if DEBUG
        workspaceTermLoopDebugLog("workspace.newTabCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=missing")
        #endif
        return nil
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
            if let status = termLoopCachedWorktreeStatus(),
               status.isAttached,
               !status.permitsAgentLaunch {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.spawnCwd.blocked ws=\(id.uuidString.prefix(8)) branch=\(branch) status=\(status.kind.rawValue)")
                #endif
                throw WorktreeError.worktreeMissingOnDisk(
                    path: status.path ?? WorkspaceMetadataStore.shared.worktreePath(for: self) ?? branch
                )
            }
            if let recorded = termLoopRecordedWorktreeCwd(
                projectRootPath: repoRootPath,
                expectedBranch: branch
            ) {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.spawnCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=recorded path=\(recorded)")
                #endif
                return recorded
            }
            if let liveWorktree = termLoopLiveWorktreeCwd(
                repoRootPath: repoRootPath,
                expectedBranch: branch
            ) {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.spawnCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=live path=\(liveWorktree)")
                #endif
                return liveWorktree
            }
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.spawnCwd.fail ws=\(id.uuidString.prefix(8)) branch=\(branch) source=missing")
            #endif
            throw WorktreeError.worktreeMissingOnDisk(
                path: WorkspaceMetadataStore.shared.worktreePath(for: self) ?? branch
            )
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
    /// safe to call from SwiftUI render/update paths. Attached workspaces do
    /// not fall back to the project root when their physical checkout is
    /// broken; returning nil lets callers show a broken/unknown state instead
    /// of silently presenting `main` as the worktree.
    @MainActor
    func termLoopPresentationCwd() -> String? {
        if let branch = WorkspaceMetadataStore.shared.branch(for: self),
           let repoRootPath = termLoopRepoRootPath() {
            if let recorded = termLoopRecordedWorktreeCwd(
                projectRootPath: repoRootPath,
                expectedBranch: branch
            ) {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.presentationCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=recorded path=\(recorded)")
                #endif
                return recorded
            }
            if let liveWorktree = termLoopLiveWorktreeCwd(
                repoRootPath: repoRootPath,
                expectedBranch: branch
            ) {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.presentationCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=live path=\(liveWorktree)")
                #endif
                return liveWorktree
            }
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.presentationCwd ws=\(id.uuidString.prefix(8)) branch=\(branch) source=missing")
            #endif
            return nil
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
    private func termLoopRecordedWorktreeCwd(
        projectRootPath: String? = nil,
        expectedBranch: String? = nil
    ) -> String? {
        guard let raw = WorkspaceMetadataStore.shared.worktreePath(for: self) else { return nil }
        let normalized = URL(fileURLWithPath: raw)
            .standardizedFileURL
            .path
        guard Self.termLoopRegisteredCheckoutExists(
            normalized,
            projectRootPath: projectRootPath
        ) else { return nil }
        guard Self.termLoopCheckout(
            at: normalized,
            matchesExpectedBranch: expectedBranch
        ) else {
            #if DEBUG
            workspaceTermLoopDebugLog("workspace.recordedWorktree.drift ws=\(id.uuidString.prefix(8)) expected=\(expectedBranch ?? "nil") path=\(normalized)")
            #endif
            return nil
        }
        #if DEBUG
        workspaceTermLoopDebugLog("workspace.recordedWorktree ws=\(id.uuidString.prefix(8)) path=\(normalized)")
        #endif
        return normalized
    }

    @MainActor
    private func termLoopLiveWorktreeCwd(
        repoRootPath: String,
        expectedBranch: String? = nil
    ) -> String? {
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
            guard Self.termLoopRegisteredCheckoutExists(
                worktreeRoot,
                projectRootPath: projectNorm
            ) else { continue }
            guard Self.termLoopCheckout(
                at: worktreeRoot,
                matchesExpectedBranch: expectedBranch
            ) else {
                #if DEBUG
                workspaceTermLoopDebugLog("workspace.liveWorktree.drift ws=\(id.uuidString.prefix(8)) expected=\(expectedBranch ?? "nil") root=\(worktreeRoot)")
                #endif
                continue
            }
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

    private static func termLoopRegisteredCheckoutExists(
        _ path: String,
        projectRootPath: String?
    ) -> Bool {
        guard termLoopDirectoryExists(path) else { return false }

        let normalized = URL(fileURLWithPath: path).standardizedFileURL.path
        let projectRoot = projectRootPath.map {
            URL(fileURLWithPath: $0).standardizedFileURL.path
        }
        if normalized == projectRoot {
            return checkoutHasGitMetadata(at: normalized)
        }

        let gitURL = URL(fileURLWithPath: normalized).appendingPathComponent(".git")
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: gitURL.path, isDirectory: &isDir) {
            if isDir.boolValue {
                return projectRoot == nil
            }
            guard let gitDirURL = linkedGitDirURL(gitFileURL: gitURL) else {
                return false
            }
            guard FileManager.default.fileExists(atPath: gitDirURL.path) else {
                return false
            }
            guard let projectRoot else { return true }
            return commonDir(forGitDir: gitDirURL).map {
                $0.resolvingSymlinksInPath().standardizedFileURL.path
            } == URL(fileURLWithPath: projectRoot)
                .appendingPathComponent(".git")
                .resolvingSymlinksInPath()
                .standardizedFileURL
                .path
        }
        return false
    }

    private static func checkoutHasGitMetadata(at path: String) -> Bool {
        let gitURL = URL(fileURLWithPath: path).appendingPathComponent(".git")
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: gitURL.path, isDirectory: &isDir) {
            return isDir.boolValue || linkedGitDirURL(gitFileURL: gitURL) != nil
        }
        return false
    }

    private static func linkedGitDirURL(gitFileURL: URL) -> URL? {
        guard let gitFile = try? String(contentsOf: gitFileURL, encoding: .utf8),
              let gitDirLine = gitFile
                  .split(whereSeparator: { $0.isNewline })
                  .first(where: { $0.lowercased().hasPrefix("gitdir:") }) else {
            return nil
        }
        let rawGitDir = gitDirLine
            .dropFirst("gitdir:".count)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawGitDir.isEmpty else { return nil }
        if rawGitDir.hasPrefix("/") {
            return URL(fileURLWithPath: rawGitDir).standardizedFileURL
        }
        return gitFileURL
            .deletingLastPathComponent()
            .appendingPathComponent(rawGitDir)
            .standardizedFileURL
    }

    private static func commonDir(forGitDir gitDirURL: URL) -> URL? {
        let commonDirURL = gitDirURL.appendingPathComponent("commondir")
        guard let raw = try? String(contentsOf: commonDirURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty else {
            return nil
        }
        if raw.hasPrefix("/") {
            return URL(fileURLWithPath: raw).standardizedFileURL
        }
        return gitDirURL.appendingPathComponent(raw).standardizedFileURL
    }

    private static func termLoopCheckout(
        at path: String,
        matchesExpectedBranch expectedBranch: String?
    ) -> Bool {
        let expected = expectedBranch?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !expected.isEmpty else { return true }
        return TermLoopWorktreeHeadReader.currentBranchWithoutGit(checkoutPath: path) == expected
    }

    @MainActor
    func termLoopWorktreeExpectation() throws -> TermLoopWorktreeExpectation? {
        if let branch = WorkspaceMetadataStore.shared.branch(for: self),
           let repoRootPath = termLoopRepoRootPath() {
            if let recorded = termLoopRecordedWorktreeCwd(
                projectRootPath: repoRootPath,
                expectedBranch: branch
            ) {
                return TermLoopWorktreeExpectation(path: recorded, branch: branch)
            }
            if let liveWorktree = termLoopLiveWorktreeCwd(
                repoRootPath: repoRootPath,
                expectedBranch: branch
            ) {
                return TermLoopWorktreeExpectation(path: liveWorktree, branch: branch)
            }
        }
        return nil
    }

    /// Cached read-only worktree status for presentation/diagnostics. This is
    /// intentionally non-blocking: it never shells out to Git and returns nil
    /// until `WorktreeRegistry` has refreshed the project off-main.
    @MainActor
    func termLoopCachedWorktreeStatus(maximumAge: TimeInterval? = nil) -> WorktreeStatus? {
        guard let projectId,
              let project = ProjectStore.shared.project(id: projectId),
              let snapshot = WorktreeRegistry.shared.cachedSnapshot(
                  projectFolder: project.folderPath,
                  maximumAge: maximumAge
              )
        else {
            return nil
        }
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: id)
        return WorktreeReconciler.status(
            for: WorktreeReconciler.Binding(
                expectedBranch: metadata.branch,
                worktreePath: metadata.worktreePath
            ),
            entries: snapshot.entries
        )
    }

    /// Schedules a background Git refresh and reports the reduced status on
    /// the main queue. Product state is not mutated here; this is the safe
    /// bridge for future badges/modals.
    @MainActor
    func termLoopRefreshWorktreeStatus(
        reason: String = "workspaceStatus",
        completion: @escaping (WorktreeStatus) -> Void
    ) {
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: id)
        let binding = WorktreeReconciler.Binding(
            expectedBranch: metadata.branch,
            worktreePath: metadata.worktreePath
        )
        guard let projectId,
              let project = ProjectStore.shared.project(id: projectId) else {
            completion(
                WorktreeReconciler.status(
                    for: binding,
                    failure: WorktreeStatusLookupError.missingProject
                )
            )
            return
        }
        WorktreeRegistry.shared.refresh(
            projectFolder: project.folderPath,
            reason: reason
        ) { result in
            switch result {
            case .success(let snapshot):
                completion(WorktreeReconciler.status(for: binding, entries: snapshot.entries))
            case .failure(let error):
                completion(WorktreeReconciler.status(for: binding, failure: error))
            }
        }
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
        let attachedBranch = WorkspaceMetadataStore.shared.branch(for: self)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !attachedBranch.isEmpty,
              let repoRootPath = termLoopRepoRootPath()
        else { return [] }

        guard let worktree = termLoopRecordedWorktreeCwd(
            projectRootPath: repoRootPath,
            expectedBranch: attachedBranch
        ) ?? termLoopLiveWorktreeCwd(
            repoRootPath: repoRootPath,
            expectedBranch: attachedBranch
        )
        else { return [] }
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

private enum WorktreeStatusLookupError: Error, CustomStringConvertible {
    case missingProject

    var description: String {
        switch self {
        case .missingProject:
            return "workspace has no project"
        }
    }
}

// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Bonsplit
import Foundation

@MainActor
public final class TaskBoardReconcileScheduler {
    public static let shared = TaskBoardReconcileScheduler()

    private var states: [UUID: ProjectState] = [:]
    private var gitInvalidationToken: GitPresentationInvalidationCenter.ObservationToken?

    private init() {}

    public func start() {
        guard gitInvalidationToken == nil else { return }
        gitInvalidationToken = GitPresentationInvalidationCenter.observe { event in
            Task { @MainActor in
                TaskBoardReconcileScheduler.shared.handleGitInvalidation(event)
            }
        }
    }

    public func request(projectId: UUID?, reason: String) {
        guard let projectId else { return }
        var state = states[projectId, default: ProjectState()]
        state.pendingReasons.insert(reason)
        state.debounceTask?.cancel()
        state.debounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            self?.run(projectId: projectId)
        }
        states[projectId] = state
    }

    private func run(projectId: UUID) {
        var state = states[projectId, default: ProjectState()]
        state.debounceTask = nil
        if state.isRunning {
            state.needsRerun = true
            states[projectId] = state
            return
        }

        state.isRunning = true
        let reasons = state.pendingReasons.sorted().joined(separator: ",")
        state.pendingReasons.removeAll()
        states[projectId] = state

        Task { @MainActor [weak self] in
            defer { self?.finish(projectId: projectId) }
            guard let store = TaskBoardStoreProvider.shared.store(for: projectId),
                  let workspaces = TaskBoardStoreProvider.shared.workspaceLister else {
                return
            }
            do {
                let startedAt = Date()
                let summary = try await TaskBoardImportReconciler(store: store, workspaces: workspaces).run()
                let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
                #if DEBUG
                dlog(
                    "TaskBoardReconcileScheduler: complete " +
                    "project=\(projectId) reasons=\(reasons) durationMs=\(durationMs) " +
                    "authoritative=\(summary.isAuthoritative) descriptors=\(summary.descriptorCount) " +
                    "changed=\(summary.changed) pruned=\(summary.prunedCount) updated=\(summary.updatedCount) " +
                    "interrupted=\(summary.interruptedCount) archived=\(summary.archivedCount) " +
                    "detached=\(summary.detachedCount) missing=\(summary.missingCount) imported=\(summary.importedCount)"
                )
                #endif
            } catch {
                #if DEBUG
                dlog("TaskBoardReconcileScheduler: reconcile failed for \(projectId): \(error)")
                #endif
            }
        }
    }

    private func finish(projectId: UUID) {
        var state = states[projectId, default: ProjectState()]
        state.isRunning = false
        let shouldRerun = state.needsRerun
        state.needsRerun = false
        states[projectId] = state
        if shouldRerun {
            request(projectId: projectId, reason: "rerun")
        }
    }

    private func handleGitInvalidation(_ event: GitInvalidationEvent) {
        let projects = ProjectStore.shared.projects
        var matched = Set<UUID>()
        for target in event.targets {
            for project in projects where target.matchesProjectFolder(project.folderPath) {
                matched.insert(project.id)
            }
        }
        for projectId in matched {
            request(projectId: projectId, reason: "git:\(event.reason)")
        }
    }

    private struct ProjectState {
        var debounceTask: Task<Void, Never>?
        var isRunning = false
        var needsRerun = false
        var pendingReasons = Set<String>()
    }
}

private extension GitInvalidationTarget {
    func matchesProjectFolder(_ folder: String) -> Bool {
        let project = WorktreeResolver.normalizePath(folder) ?? folder
        switch normalized {
        case .all:
            return true
        case .project(let path):
            return path == project
        case .worktree(let path), .directory(let path):
            return path == project || path.hasPrefix(project + "/")
        }
    }
}

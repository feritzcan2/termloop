// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

actor TaskSyncService {
    let projectId: UUID
    private let store: TaskStore
    private let git: GitStateProvider
    private let pullRequests: TaskPullRequestClient
    private let remoteIdentityResolver: (String) -> GitRemoteIdentity?
    private let projectRoot: String
    private let trackedResolver: TrackedBranchesResolver
    private let explicitTrackedBranches: [String]?

    private var isRunning = false
    private var lastRemoteTickAt: Date?
    private var consecutiveSuccessByTask: [UUID: Int] = [:]
    private let remoteTTL: TimeInterval = 300
    private let remoteName = "origin"

    init(
        projectId: UUID,
        store: TaskStore,
        git: GitStateProvider,
        pullRequests: TaskPullRequestClient,
        remoteIdentityResolver: @escaping (String) -> GitRemoteIdentity?,
        projectRoot: String,
        trackedResolver: TrackedBranchesResolver,
        explicitTrackedBranches: [String]?
    ) {
        self.projectId = projectId
        self.store = store
        self.git = git
        self.pullRequests = pullRequests
        self.remoteIdentityResolver = remoteIdentityResolver
        self.projectRoot = projectRoot
        self.trackedResolver = trackedResolver
        self.explicitTrackedBranches = explicitTrackedBranches
    }

    func localTick() async {
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        let tasks = await MainActor.run { store.tasks(for: projectId) }
        // Prune success counters for tasks that have been deleted from the
        // store; otherwise this dict grows unboundedly over a session.
        let activeIds = Set(tasks.map(\.id))
        consecutiveSuccessByTask = consecutiveSuccessByTask.filter { activeIds.contains($0.key) }
        guard !tasks.isEmpty else { return }

        let tracked = trackedResolver.resolve(
            explicit: explicitTrackedBranches, projectRoot: projectRoot
        )

        for task in tasks {
            var updated = task
            let hasUpstream = git.hasRemoteBranch(task.branch, directory: projectRoot)
            if hasUpstream {
                let ab = git.aheadBehind(
                    branch: task.branch,
                    upstream: "\(remoteName)/\(task.branch)",
                    worktreePath: task.worktreePath
                )
                updated.mergeState.aheadBy = ab?.ahead
                updated.mergeState.behindBy = ab?.behind
            } else {
                updated.mergeState.aheadBy = nil
                updated.mergeState.behindBy = nil
            }
            updated.mergeState.mergedInto = tracked.filter { tr in
                let ref = git.hasRemoteBranch(tr, directory: projectRoot) ? "\(remoteName)/\(tr)" : tr
                return git.isAncestor(branch: task.branch, of: ref, projectRoot: projectRoot)
            }
            updated.lastSyncedAt = Date()
            consecutiveSuccessByTask[task.id, default: 0] += 1
            if (consecutiveSuccessByTask[task.id] ?? 0) >= 3 {
                updated.lastSyncError = nil
            }
            if updated != task {
                await MainActor.run { try? store.update(updated) }
            }
        }
    }

    func remoteTick() async {
        if let last = lastRemoteTickAt, Date().timeIntervalSince(last) < remoteTTL {
            return
        }
        await runRemoteTick()
    }

    func remoteTickForced() async {
        await runRemoteTick()
    }

    private func runRemoteTick() async {
        lastRemoteTickAt = Date()

        do { try git.fetchAll(projectRoot: projectRoot) } catch {
            NSLog("[TaskSync] fetch failed: \(error)")
        }

        let tasks = await MainActor.run { store.tasks(for: projectId) }
        var prByBranch: [String: TermLoopTask.PRInfo] = [:]
        if let identity = remoteIdentityResolver(projectRoot),
           await pullRequests.isAuthenticated(identity: identity) {
            do {
                let prs = try await pullRequests.prList(
                    identity: identity,
                    branches: tasks.map(\.branch)
                )
                for (branch, info) in prs {
                    prByBranch[branch] = info
                }
            } catch {
                NSLog("[TaskSync] hosted pr list failed: \(error)")
            }
        }

        for task in tasks {
            guard let pr = prByBranch[task.branch] else { continue }
            var updated = task
            updated.prInfo = pr
            updated.lastSyncedAt = Date()
            if updated != task {
                await MainActor.run { try? store.update(updated) }
            }
        }
    }
}

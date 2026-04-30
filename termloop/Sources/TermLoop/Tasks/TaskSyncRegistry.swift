// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import Combine

@MainActor
final class TaskSyncRegistry {
    static let shared = TaskSyncRegistry()

    private var services: [UUID: TaskSyncService] = [:]
    private var localTimers: [UUID: Timer] = [:]
    private var remoteTimers: [UUID: Timer] = [:]
    private var cancellables = Set<AnyCancellable>()

    private let localVisible: TimeInterval = 30
    private let localHidden: TimeInterval = 300
    private let remoteVisible: TimeInterval = 300
    private let remoteHidden: TimeInterval = 900

    private init() {
        ProjectStore.shared.$openProjectIds
            .sink { [weak self] ids in self?.reconcile(openProjectIds: ids) }
            .store(in: &cancellables)
    }

    private func reconcile(openProjectIds: [UUID]) {
        let open = Set(openProjectIds)
        for id in Array(services.keys) where !open.contains(id) {
            localTimers[id]?.invalidate(); localTimers[id] = nil
            remoteTimers[id]?.invalidate(); remoteTimers[id] = nil
            services[id] = nil
        }
        for id in open where services[id] == nil {
            guard let project = ProjectStore.shared.projects.first(where: { $0.id == id })
            else { continue }
            spinUp(project: project)
        }
    }

    private func spinUp(project: Project) {
        let git = ProcessGitStateProvider()
        let pullRequests = GitHostTaskPullRequestClient()
        let service = TaskSyncService(
            projectId: project.id,
            store: TaskStore.shared,
            git: git,
            pullRequests: pullRequests,
            remoteIdentityResolver: { root in Self.primaryPullRequestIdentity(projectRoot: root) },
            projectRoot: project.folderPath,
            trackedResolver: TrackedBranchesResolver(gitRunner: git),
            explicitTrackedBranches: project.trackedBranches
        )
        services[project.id] = service
        TaskStore.shared.load(projectId: project.id)
        scheduleTimers(for: project.id)
        Task { await service.localTick() }
    }

    func visibilityChanged(projectId: UUID) {
        scheduleTimers(for: projectId)
    }

    func refreshNow(projectId: UUID) {
        guard let service = services[projectId] else { return }
        Task {
            await service.localTick()
            await service.remoteTickForced()
        }
    }

    func bootstrapTask(projectId: UUID, taskId: UUID) {
        refreshNow(projectId: projectId)
    }

    func unregisterTask(projectId: UUID, taskId: UUID) {}

    private func scheduleTimers(for projectId: UUID) {
        localTimers[projectId]?.invalidate()
        remoteTimers[projectId]?.invalidate()
        let visible = TaskSyncViewRegistry.shared.isVisible(projectId: projectId)
        let localInterval = visible ? localVisible : localHidden
        let remoteInterval = visible ? remoteVisible : remoteHidden
        localTimers[projectId] = Timer.scheduledTimer(withTimeInterval: localInterval, repeats: true) { [weak self] _ in
            guard let s = self?.services[projectId] else { return }
            Task { await s.localTick() }
        }
        remoteTimers[projectId] = Timer.scheduledTimer(withTimeInterval: remoteInterval, repeats: true) { [weak self] _ in
            guard let s = self?.services[projectId] else { return }
            Task { await s.remoteTick() }
        }
    }

    private static func primaryPullRequestIdentity(projectRoot: String) -> GitRemoteIdentity? {
        GitProjectStore.shared.primaryPullRequestRepositoryIdentity(for: projectRoot)
    }

}

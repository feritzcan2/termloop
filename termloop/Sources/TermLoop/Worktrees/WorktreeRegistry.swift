// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

struct WorktreeRegistrySnapshot: Equatable {
    let projectFolder: String
    let entries: [GitWorktreeService.ListEntry]
    let capturedAt: Date

    var entriesByPath: [String: GitWorktreeService.ListEntry] {
        Dictionary(
            entries.map { entry in
                (WorktreeResolver.normalizePath(entry.path) ?? entry.path, entry)
            },
            uniquingKeysWith: { first, _ in first }
        )
    }
}

/// Async, cached source of `git worktree list --porcelain` data. This is the
/// only layer in the new model that shells out to Git; UI/resolvers can consume
/// cached snapshots without blocking the main thread.
final class WorktreeRegistry {
    static let shared = WorktreeRegistry()

    typealias Completion = (Result<WorktreeRegistrySnapshot, Error>) -> Void

    private static let logger = Logger(subsystem: "com.termloop.fork", category: "worktree-registry")

    private let lock = NSLock()
    private var cache: [String: WorktreeRegistrySnapshot] = [:]
    private var inFlight: [String: [Completion]] = [:]
    private var invalidationToken: GitPresentationInvalidationCenter.ObservationToken?

    private init() {
        invalidationToken = GitPresentationInvalidationCenter.observe { [weak self] event in
            self?.handleInvalidation(event)
        }
    }

    func cachedSnapshot(
        projectFolder rawProjectFolder: String,
        maximumAge: TimeInterval? = nil
    ) -> WorktreeRegistrySnapshot? {
        let projectFolder = normalize(path: rawProjectFolder)
        lock.lock()
        let snapshot = cache[projectFolder]
        lock.unlock()
        guard let snapshot else { return nil }
        if let maximumAge,
           Date().timeIntervalSince(snapshot.capturedAt) > maximumAge {
            return nil
        }
        return snapshot
    }

    func refresh(
        projectFolder rawProjectFolder: String,
        reason: String = "manual",
        completion: Completion? = nil
    ) {
        let projectFolder = normalize(path: rawProjectFolder)
        lock.lock()
        if var completions = inFlight[projectFolder] {
            if let completion { completions.append(completion) }
            inFlight[projectFolder] = completions
            lock.unlock()
            return
        }
        inFlight[projectFolder] = completion.map { [$0] } ?? []
        lock.unlock()

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result: Result<WorktreeRegistrySnapshot, Error>
            do {
                let entries = try GitWorktreeService().list(in: projectFolder)
                result = .success(WorktreeRegistrySnapshot(
                    projectFolder: projectFolder,
                    entries: entries,
                    capturedAt: Date()
                ))
            } catch {
                result = .failure(error)
            }

            guard let self else { return }
            let completions: [Completion]
            self.lock.lock()
            if case .success(let snapshot) = result {
                self.cache[projectFolder] = snapshot
            }
            completions = self.inFlight.removeValue(forKey: projectFolder) ?? []
            self.lock.unlock()

            #if DEBUG
            switch result {
            case .success(let snapshot):
                Self.logger.debug("registry.refresh.success project=\(projectFolder, privacy: .public) reason=\(reason, privacy: .public) count=\(snapshot.entries.count)")
            case .failure(let error):
                Self.logger.debug("registry.refresh.failure project=\(projectFolder, privacy: .public) reason=\(reason, privacy: .public) error=\(String(describing: error), privacy: .public)")
            }
            #endif

            guard !completions.isEmpty else { return }
            DispatchQueue.main.async {
                completions.forEach { $0(result) }
            }
        }
    }

    @discardableResult
    func record(
        projectFolder rawProjectFolder: String,
        entries: [GitWorktreeService.ListEntry],
        capturedAt: Date = Date()
    ) -> WorktreeRegistrySnapshot {
        let projectFolder = normalize(path: rawProjectFolder)
        let snapshot = WorktreeRegistrySnapshot(
            projectFolder: projectFolder,
            entries: entries,
            capturedAt: capturedAt
        )
        lock.lock()
        cache[projectFolder] = snapshot
        lock.unlock()
        notifyProjectionChanged(reason: "registry.record")
        return snapshot
    }

    func invalidate(projectFolder rawProjectFolder: String) {
        let projectFolder = normalize(path: rawProjectFolder)
        lock.lock()
        cache.removeValue(forKey: projectFolder)
        lock.unlock()
        #if DEBUG
        Self.logger.debug("registry.invalidate.project project=\(projectFolder, privacy: .public)")
        #endif
    }

    func invalidateAll() {
        lock.lock()
        cache.removeAll()
        lock.unlock()
        #if DEBUG
        Self.logger.debug("registry.invalidate.all")
        #endif
    }

    private func handleInvalidation(_ event: GitInvalidationEvent) {
        var shouldInvalidateAll = false
        var projectTargets: [String] = []
        var pathTargets: [String] = []

        for target in event.targets {
            switch target.normalized {
            case .all:
                shouldInvalidateAll = true
            case .project(let path):
                projectTargets.append(path)
            case .worktree(let path), .directory(let path):
                pathTargets.append(path)
            }
        }

        if shouldInvalidateAll {
            invalidateAll()
            return
        }

        for project in projectTargets {
            invalidate(projectFolder: project)
        }

        guard !pathTargets.isEmpty else { return }
        lock.lock()
        let knownProjects = Array(cache.keys)
        lock.unlock()
        for target in pathTargets {
            for project in knownProjects where Self.path(target, isInside: project) {
                invalidate(projectFolder: project)
            }
        }
    }

    private func normalize(path: String) -> String {
        WorktreeResolver.normalizePath(path) ?? path
    }

    private func notifyProjectionChanged(reason: String) {
        _Concurrency.Task { @MainActor in
            WorktreeProjectionStore.shared.markChanged(reason: reason)
        }
    }

    private static func path(_ child: String, isInside parent: String) -> Bool {
        child == parent || child.hasPrefix(parent + "/")
    }
}

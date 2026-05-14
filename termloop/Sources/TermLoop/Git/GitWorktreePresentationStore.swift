// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation
import os

struct GitWorktreePresentationSnapshot: Equatable {
    let worktreeRoot: String
    let projectKey: GitProjectKey?
    let branch: String?
    let headSHA: String?
    let files: [SidebarGitChangeItem]
    let fetchedAt: Date

    var dirtyCount: Int { files.count }
    var isDirty: Bool { !files.isEmpty }

    func isPresentationEqual(to other: GitWorktreePresentationSnapshot) -> Bool {
        worktreeRoot == other.worktreeRoot &&
            projectKey == other.projectKey &&
            branch == other.branch &&
            headSHA == other.headSHA &&
            files == other.files
    }
}

/// Worktree-level git presentation truth. Branch, HEAD and dirty files are
/// worktree-specific; remote/provider identity is intentionally delegated to
/// `GitProjectStore` through `projectKey`.
final class GitWorktreePresentationStore {
    static let shared = GitWorktreePresentationStore()
#if DEBUG
    private static let logger = Logger(subsystem: "com.termloop.git", category: "worktree-store")
#endif

    private struct Entry {
        let snapshot: GitWorktreePresentationSnapshot
        let fetchedAt: Date
    }

    private let lock = NSLock()
    private var cache: [String: Entry] = [:]
    private var snapshotSubjects: [String: CurrentValueSubject<GitWorktreePresentationSnapshot?, Never>] = [:]
    private var branchSubjects: [String: CurrentValueSubject<String?, Never>] = [:]
    private var fileSubjects: [String: CurrentValueSubject<[SidebarGitChangeItem], Never>] = [:]
    private var refetchingDirectories: Set<String> = []
    private var invalidationToken: GitPresentationInvalidationCenter.ObservationToken?
    private let activeTTL: TimeInterval = 15
    private let maxCacheEntries = 256

    private init() {
        invalidationToken = GitPresentationInvalidationCenter.observe { [weak self] event in
            self?.handleInvalidation(event)
        }
    }

    func snapshot(for directory: String, allowCached: Bool = true) -> GitWorktreePresentationSnapshot? {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        let now = Date()
        if allowCached {
            lock.lock()
            if let entry = cache[normalizedDirectory], now.timeIntervalSince(entry.fetchedAt) < activeTTL {
                lock.unlock()
#if DEBUG
                Self.logger.debug("worktree.snapshot.cacheHit dir=\(normalizedDirectory, privacy: .public) branch=\(entry.snapshot.branch ?? "nil", privacy: .public) files=\(entry.snapshot.files.count)")
#endif
                return entry.snapshot
            }
            lock.unlock()
        }

        guard let snapshot = fetchSnapshot(directory: normalizedDirectory, now: now) else {
#if DEBUG
            Self.logger.debug("worktree.snapshot.fetchNil dir=\(normalizedDirectory, privacy: .public)")
#endif
            return nil
        }
        lock.lock()
        let previousSnapshot = cache[normalizedDirectory]?.snapshot
        cache[normalizedDirectory] = Entry(snapshot: snapshot, fetchedAt: now)
        pruneCacheLocked(maxEntries: maxCacheEntries)
        lock.unlock()
#if DEBUG
        Self.logger.debug("worktree.snapshot.fetched dir=\(normalizedDirectory, privacy: .public) branch=\(snapshot.branch ?? "nil", privacy: .public) head=\(snapshot.headSHA.map { String($0.prefix(12)) } ?? "nil", privacy: .public) files=\(snapshot.files.count)")
#endif
        if previousSnapshot?.isPresentationEqual(to: snapshot) != true {
            publish(snapshot: snapshot, for: normalizedDirectory)
        } else {
#if DEBUG
            Self.logger.debug("worktree.snapshot.unchanged dir=\(normalizedDirectory, privacy: .public)")
#endif
        }
        return snapshot
    }

    func snapshotPublisher(for directory: String) -> AnyPublisher<GitWorktreePresentationSnapshot?, Never> {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        lock.lock()
        let subject = snapshotSubjects[normalizedDirectory] ?? CurrentValueSubject<GitWorktreePresentationSnapshot?, Never>(
            cache[normalizedDirectory]?.snapshot
        )
        snapshotSubjects[normalizedDirectory] = subject
        lock.unlock()
        scheduleRefetchIfObserved(directory: normalizedDirectory)
        return subject.eraseToAnyPublisher()
    }

    func branchPublisher(for directory: String) -> AnyPublisher<String?, Never> {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        lock.lock()
        let subject = branchSubjects[normalizedDirectory] ?? CurrentValueSubject<String?, Never>(
            cache[normalizedDirectory]?.snapshot.branch
        )
        branchSubjects[normalizedDirectory] = subject
        lock.unlock()
        scheduleRefetchIfObserved(directory: normalizedDirectory)
        return subject.eraseToAnyPublisher()
    }

    func filesPublisher(for directory: String) -> AnyPublisher<[SidebarGitChangeItem], Never> {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        lock.lock()
        let subject = fileSubjects[normalizedDirectory] ?? CurrentValueSubject<[SidebarGitChangeItem], Never>(
            cache[normalizedDirectory]?.snapshot.files ?? []
        )
        fileSubjects[normalizedDirectory] = subject
        lock.unlock()
        scheduleRefetchIfObserved(directory: normalizedDirectory)
        return subject.eraseToAnyPublisher()
    }

    func invalidate(directory: String) {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        lock.lock()
        cache.removeValue(forKey: normalizedDirectory)
        let shouldRefetch = hasObservedChannelLocked(directory: normalizedDirectory)
        lock.unlock()
#if DEBUG
        Self.logger.debug("worktree.invalidate.directory dir=\(normalizedDirectory, privacy: .public) observed=\(shouldRefetch)")
#endif
        if shouldRefetch {
            scheduleRefetchIfObserved(directory: normalizedDirectory, force: true)
        }
    }

    func invalidateAll() {
        lock.lock()
        cache.removeAll()
        let directories = observedDirectoriesLocked()
        lock.unlock()
#if DEBUG
        Self.logger.debug("worktree.invalidate.all observedDirs=\(directories.count)")
#endif
        for directory in directories {
            scheduleRefetchIfObserved(directory: directory, force: true)
        }
    }

    private func fetchSnapshot(directory: String, now: Date) -> GitWorktreePresentationSnapshot? {
        GitPresentationInvalidationWatcher.shared.watchWorktree(directory: directory)
#if DEBUG
        Self.logger.debug("worktree.fetch.start dir=\(directory, privacy: .public)")
#endif
        let branch = GitCommandRunner.runOptional(
            ["branch", "--show-current"],
            in: directory,
            kind: .branch,
            caller: "GitWorktreePresentationStore.branch"
        )?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty

        let head = GitCommandRunner.runOptional(
            ["rev-parse", "HEAD"],
            in: directory,
            kind: .revParse,
            caller: "GitWorktreePresentationStore.head"
        )?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty

        guard branch != nil || head != nil else {
#if DEBUG
            Self.logger.debug("worktree.fetch.notGit dir=\(directory, privacy: .public)")
#endif
            return nil
        }
        let files = WorktreeLocalChangesProvider.fetchChangedFiles(directory: directory) ?? []
#if DEBUG
        Self.logger.debug("worktree.fetch.result dir=\(directory, privacy: .public) branch=\(branch ?? "nil", privacy: .public) head=\(head.map { String($0.prefix(12)) } ?? "nil", privacy: .public) files=\(files.count)")
#endif
        return GitWorktreePresentationSnapshot(
            worktreeRoot: directory,
            projectKey: GitProjectStore.shared.projectKey(for: directory),
            branch: branch,
            headSHA: head,
            files: files,
            fetchedAt: now
        )
    }

    private func handleInvalidation(_ event: GitInvalidationEvent) {
        var shouldInvalidateAll = false
        var directories: [String] = []
        for target in event.targets {
            switch target.normalized {
            case .all:
                shouldInvalidateAll = true
            case .worktree(let path), .directory(let path):
                directories.append(path)
            case .project:
                break
            }
        }
#if DEBUG
        Self.logger.debug("worktree.handleInvalidation targets=\(event.targets.count) all=\(shouldInvalidateAll) dirs=\(directories.count) reason=\(event.reason, privacy: .public)")
#endif
        if shouldInvalidateAll {
            invalidateAll()
            return
        }
        for directory in directories {
            invalidate(directory: directory)
        }
    }

    private func hasObservedChannelLocked(directory: String) -> Bool {
        snapshotSubjects[directory] != nil || branchSubjects[directory] != nil || fileSubjects[directory] != nil
    }

    private func observedDirectoriesLocked() -> [String] {
        Array(Set(snapshotSubjects.keys).union(branchSubjects.keys).union(fileSubjects.keys))
    }

    private func scheduleRefetchIfObserved(directory: String, force: Bool = false) {
        lock.lock()
        guard hasObservedChannelLocked(directory: directory) else {
            lock.unlock()
#if DEBUG
            Self.logger.debug("worktree.refetch.skipUnobserved dir=\(directory, privacy: .public) force=\(force)")
#endif
            return
        }
        if refetchingDirectories.contains(directory) {
            lock.unlock()
#if DEBUG
            Self.logger.debug("worktree.refetch.skipInFlight dir=\(directory, privacy: .public) force=\(force)")
#endif
            return
        }
        if !force, let entry = cache[directory], Date().timeIntervalSince(entry.fetchedAt) < activeTTL {
            lock.unlock()
#if DEBUG
            Self.logger.debug("worktree.refetch.cacheFresh dir=\(directory, privacy: .public) branch=\(entry.snapshot.branch ?? "nil", privacy: .public) files=\(entry.snapshot.files.count)")
#endif
            return
        }
        refetchingDirectories.insert(directory)
        lock.unlock()

#if DEBUG
        Self.logger.debug("worktree.refetch.start dir=\(directory, privacy: .public) force=\(force)")
#endif
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            _ = self.snapshot(for: directory, allowCached: !force)
            self.lock.lock()
            self.refetchingDirectories.remove(directory)
            self.lock.unlock()
#if DEBUG
            Self.logger.debug("worktree.refetch.done dir=\(directory, privacy: .public) force=\(force)")
#endif
        }
    }

    private func publish(snapshot: GitWorktreePresentationSnapshot, for directory: String) {
        lock.lock()
        let snapshotSubject = snapshotSubjects[directory]
        let branchSubject = branchSubjects[directory]
        let fileSubject = fileSubjects[directory]
        lock.unlock()

#if DEBUG
        Self.logger.debug("worktree.publish dir=\(directory, privacy: .public) branch=\(snapshot.branch ?? "nil", privacy: .public) files=\(snapshot.files.count)")
#endif
        if let snapshotSubject,
           snapshotSubject.value?.isPresentationEqual(to: snapshot) != true {
            snapshotSubject.send(snapshot)
        }
        if let branchSubject,
           branchSubject.value != snapshot.branch {
            branchSubject.send(snapshot.branch)
        }
        if let fileSubject,
           fileSubject.value != snapshot.files {
            fileSubject.send(snapshot.files)
        }
    }

    private func pruneCacheLocked(maxEntries: Int) {
        guard cache.count > maxEntries else { return }
        let staleKeys = cache
            .sorted { $0.value.fetchedAt < $1.value.fetchedAt }
            .prefix(cache.count - maxEntries)
            .map(\.key)
        for key in staleKeys {
            cache.removeValue(forKey: key)
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

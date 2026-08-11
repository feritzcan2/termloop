// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Off-main cache for pull-request-capable repository identities per directory.
///
/// The main-thread PR refresh loop needs a stable repository key, but it
/// should not synchronously resolve git remotes. This cache sits in front of
/// `GitProjectStore`: the main thread reads cached display slugs instantly,
/// and a background queue warms/refetches project identity when needed.
///
/// Thread safety: `cache` and `inflight` are guarded by `lock`. Public API is
/// safe to call from any thread.
final class PullRequestRepositoryIdentityCache {
    static let shared = PullRequestRepositoryIdentityCache()

    private struct Entry {
        let slugs: [String]
        let fetchedAt: Date

        func isStale(at date: Date, ttl: TimeInterval) -> Bool {
            date.timeIntervalSince(fetchedAt) > ttl
        }
    }

    /// How long a cached entry is considered fresh. Project remote identity
    /// changes very rarely; 5 minutes keeps the cache warm across multiple
    /// PR-refresh cycles without growing stale after a remote rename.
    private let ttl: TimeInterval = 300

    private var cache: [String: Entry] = [:]
    private var inflight: Set<String> = []
    private let lock = NSLock()

    /// Returns cached repo slugs for `directory`, or `nil` if no cache entry
    /// exists yet. When `nil`, the caller should skip the synchronous git
    /// call and let `populateInBackground` fill the cache for the next cycle.
    func slugs(for directory: String) -> [String]? {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = cache[directory] else { return nil }
        if entry.isStale(at: Date(), ttl: ttl) {
            // Stale — return the stale value so PR lookup still works,
            // but also trigger a background refresh.
            scheduleRefreshLocked(directory: directory)
            return entry.slugs
        }
        return entry.slugs
    }

    /// Kicks off a background project identity fetch for `directory` if one
    /// isn't already in flight. Safe to call from main thread — no blocking.
    func populateInBackground(directory: String) {
        lock.lock()
        guard !inflight.contains(directory) else {
            lock.unlock()
            return
        }
        inflight.insert(directory)
        lock.unlock()

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let slugs = Self.fetchSlugs(directory: directory)
            guard let self else { return }
            self.lock.lock()
            self.cache[directory] = Entry(slugs: slugs, fetchedAt: Date())
            self.inflight.remove(directory)
            self.lock.unlock()
        }
    }

    /// Whether a PR lookup should wait for remote identity cache warm-up before
    /// treating an empty slug list as an unsupported repository.
    func isResolvingOrHasNonEmptyCache(directory: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if inflight.contains(directory) {
            return true
        }
        guard let entry = cache[directory] else {
            return false
        }
        if entry.isStale(at: Date(), ttl: ttl) {
            scheduleRefreshLocked(directory: directory)
            return true
        }
        return !entry.slugs.isEmpty
    }

    /// Single-call convenience for the upstream hook site. Returns cached
    /// slugs when available, kicks off a background fetch when not, and
    /// handles the `nil` directory case. Never blocks the calling thread.
    func resolveOrPopulate(directory: String?) -> [String] {
        guard let directory else { return [] }
        if let cached = slugs(for: directory) {
            return cached
        }
        populateInBackground(directory: directory)
        return []
    }

    /// Removes all cached entries. Useful when workspace directories change
    /// significantly (e.g. project switch).
    func invalidateAll() {
        lock.lock()
        cache.removeAll()
        lock.unlock()
    }

    // MARK: - Private

    private func scheduleRefreshLocked(directory: String) {
        guard !inflight.contains(directory) else { return }
        inflight.insert(directory)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let slugs = Self.fetchSlugs(directory: directory)
            guard let self else { return }
            self.lock.lock()
            self.cache[directory] = Entry(slugs: slugs, fetchedAt: Date())
            self.inflight.remove(directory)
            self.lock.unlock()
        }
    }

    /// Returns pull-request capable repository slugs for the shared git project.
    /// GitHub uses `owner/repo`; Azure DevOps uses `org/project/repo`.
    private static func fetchSlugs(directory: String) -> [String] {
        GitProjectStore.shared.pullRequestRepositoryIdentities(for: directory).map(\.displaySlug)
    }

}

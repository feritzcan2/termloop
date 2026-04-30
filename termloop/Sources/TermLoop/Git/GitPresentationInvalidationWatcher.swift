// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// File-system invalidation for git presentation state. It intentionally watches
/// only cheap git control files; working-tree dirtiness still has a short TTL.
final class GitPresentationInvalidationWatcher {
    static let shared = GitPresentationInvalidationWatcher()
#if DEBUG
    private static let logger = Logger(subsystem: "com.termloop.git", category: "fs-watcher")
#endif

    private struct WatchedPath {
        let fd: Int32
        let source: DispatchSourceFileSystemObject
    }

    private let lock = NSLock()
    private var watched: [String: WatchedPath] = [:]
    private var worktreeGitDirCache: [String: String] = [:]
    private var knownNonGitWorktrees: [String: Date] = [:]
    private var pendingInvalidations: [String: DispatchWorkItem] = [:]
    private let queue = DispatchQueue(label: "app.termloop.git.presentation.fs", qos: .utility)
    private let debounceInterval: TimeInterval = 0.35
    private let nonGitWorktreeCacheLifetime: TimeInterval = 30
    private let maxGitDirCacheEntries = 512

    private init() {}

    func watchProject(commonDir: String) {
        let normalized = URL(fileURLWithPath: commonDir).standardizedFileURL.path
#if DEBUG
        Self.logger.debug("watch.project commonDir=\(normalized, privacy: .public)")
#endif
        watch(path: normalized + "/config", target: .project(normalized), reason: "gitProjectConfig")
        watch(path: normalized + "/packed-refs", target: .project(normalized), reason: "gitProjectPackedRefs")
    }

    func watchWorktree(directory: String) {
        let normalized = URL(fileURLWithPath: directory).standardizedFileURL.path
        guard let gitDir = gitDir(for: normalized) else {
#if DEBUG
            Self.logger.debug("watch.worktree.noGitDir dir=\(normalized, privacy: .public)")
#endif
            return
        }
#if DEBUG
        Self.logger.debug("watch.worktree dir=\(normalized, privacy: .public) gitDir=\(gitDir, privacy: .public)")
#endif
        watch(path: gitDir + "/HEAD", target: .worktree(normalized), reason: "gitWorktreeHEAD")
        watch(path: gitDir + "/index", target: .worktree(normalized), reason: "gitWorktreeIndex")
    }

    private func gitDir(for directory: String) -> String? {
        let now = Date()
        lock.lock()
        if let cached = worktreeGitDirCache[directory] {
            lock.unlock()
            return cached
        }
        if let checkedAt = knownNonGitWorktrees[directory],
           now.timeIntervalSince(checkedAt) < nonGitWorktreeCacheLifetime {
            lock.unlock()
            return nil
        }
        knownNonGitWorktrees.removeValue(forKey: directory)
        lock.unlock()

        guard let raw = GitCommandRunner.runOptional(
            ["rev-parse", "--git-dir"],
            in: directory,
            kind: .revParse,
            caller: "GitPresentationInvalidationWatcher.gitDir"
        )?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            lock.lock()
            knownNonGitWorktrees[directory] = now
            pruneGitDirCachesLocked()
            lock.unlock()
            return nil
        }
        let resolved = if raw.hasPrefix("/") {
            URL(fileURLWithPath: raw).standardizedFileURL.path
        } else {
            URL(fileURLWithPath: raw, relativeTo: URL(fileURLWithPath: directory)).standardizedFileURL.path
        }
        lock.lock()
        worktreeGitDirCache[directory] = resolved
        knownNonGitWorktrees.removeValue(forKey: directory)
        pruneGitDirCachesLocked()
        lock.unlock()
        return resolved
    }

    private func pruneGitDirCachesLocked() {
        if worktreeGitDirCache.count > maxGitDirCacheEntries {
            worktreeGitDirCache.removeAll(keepingCapacity: true)
        }

        let cutoff = Date().addingTimeInterval(-nonGitWorktreeCacheLifetime)
        knownNonGitWorktrees = knownNonGitWorktrees.filter { $0.value >= cutoff }
        if knownNonGitWorktrees.count > maxGitDirCacheEntries {
            knownNonGitWorktrees.removeAll(keepingCapacity: true)
        }
    }

    private func watch(path: String, target: GitInvalidationTarget, reason: String) {
        let normalized = URL(fileURLWithPath: path).standardizedFileURL.path
        lock.lock()
        if watched[normalized] != nil {
            lock.unlock()
#if DEBUG
            Self.logger.debug("watch.skipExisting path=\(normalized, privacy: .public) reason=\(reason, privacy: .public)")
#endif
            return
        }
        lock.unlock()

        let fd = open(normalized, O_EVTONLY)
        guard fd >= 0 else {
#if DEBUG
            Self.logger.debug("watch.openFailed path=\(normalized, privacy: .public) reason=\(reason, privacy: .public)")
#endif
            return
        }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename, .revoke],
            queue: queue
        )
        source.setEventHandler { [weak self] in
#if DEBUG
            Self.logger.debug("watch.event path=\(normalized, privacy: .public) reason=\(reason, privacy: .public) flags=\(source.data.rawValue)")
#endif
            self?.scheduleInvalidation(target: target, reason: reason, source: normalized)
            let flags = source.data
            if flags.contains(.delete) || flags.contains(.rename) || flags.contains(.revoke) {
                self?.unwatch(path: normalized)
            }
        }
        source.setCancelHandler {
            close(fd)
        }

        lock.lock()
        if watched[normalized] == nil {
            watched[normalized] = WatchedPath(fd: fd, source: source)
            lock.unlock()
#if DEBUG
            Self.logger.debug("watch.start path=\(normalized, privacy: .public) reason=\(reason, privacy: .public)")
#endif
            source.resume()
        } else {
            lock.unlock()
#if DEBUG
            Self.logger.debug("watch.raceCancel path=\(normalized, privacy: .public) reason=\(reason, privacy: .public)")
#endif
            source.cancel()
        }
    }

    private func unwatch(path: String) {
        lock.lock()
        let existing = watched.removeValue(forKey: path)
        lock.unlock()
#if DEBUG
        Self.logger.debug("watch.unwatch path=\(path, privacy: .public) existed=\(existing != nil)")
#endif
        existing?.source.cancel()
    }

    private func scheduleInvalidation(target: GitInvalidationTarget, reason: String, source: String) {
        let key = "\(target.normalized)|\(reason)|\(source)"
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
#if DEBUG
            Self.logger.debug("watch.debounce.fire target=\(String(describing: target.normalized), privacy: .public) reason=\(reason, privacy: .public) source=\(source, privacy: .public)")
#endif
            GitPresentationInvalidationCenter.invalidate([target], reason: reason, source: source)
            self.lock.lock()
            self.pendingInvalidations.removeValue(forKey: key)
            self.lock.unlock()
        }

        lock.lock()
        pendingInvalidations[key]?.cancel()
        pendingInvalidations[key] = item
        lock.unlock()

#if DEBUG
        Self.logger.debug("watch.debounce.schedule target=\(String(describing: target.normalized), privacy: .public) reason=\(reason, privacy: .public) source=\(source, privacy: .public)")
#endif
        queue.asyncAfter(deadline: .now() + debounceInterval, execute: item)
    }

#if DEBUG
    func debugScheduleInvalidationForTests(target: GitInvalidationTarget, reason: String, source: String) {
        scheduleInvalidation(target: target, reason: reason, source: source)
    }
#endif
}

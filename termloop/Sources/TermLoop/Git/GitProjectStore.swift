// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation
import os

/// Identity of a git repository, keyed by its standardized common dir so every
/// worktree of the same repo maps to one key.
struct GitProjectKey: Hashable, Sendable, CustomStringConvertible {
    let commonDir: String

    init(commonDir: String) {
        self.commonDir = URL(fileURLWithPath: commonDir).standardizedFileURL.path
    }

    var description: String { commonDir }
}

struct GitProjectIdentity: Equatable, Sendable {
    let key: GitProjectKey
    let worktreeRoot: String
    let remotes: [GitRemoteIdentity]
    let primaryRemote: GitRemoteIdentity?
    let defaultBranch: String?
    let fetchedAt: Date

    var hostKind: GitHostKind { primaryRemote?.host ?? .unknown }
}

/// Project-level git presentation truth. A "project" here means the shared git
/// common dir behind one or more worktrees, not the higher-level TermLoop
/// Project container. Remote identity and host selection live here because all
/// worktrees of the same repository share `.git/config`.
final class GitProjectStore {
    static let shared = GitProjectStore()
#if DEBUG
    private static let logger = Logger(subsystem: "com.termloop.git", category: "project-store")
#endif

    private struct Entry {
        let identity: GitProjectIdentity
        let fetchedAt: Date
    }

    private let lock = NSLock()
    private var cache: [GitProjectKey: Entry] = [:]
    private var keyByDirectory: [String: GitProjectKey] = [:]
    private var identitySubjects: [String: CurrentValueSubject<GitProjectIdentity?, Never>] = [:]
    private var remotesSubjects: [String: CurrentValueSubject<[GitRemoteIdentity], Never>] = [:]
    private var defaultBranchSubjects: [String: CurrentValueSubject<String?, Never>] = [:]
    private var refetchingDirectories: Set<String> = []
    private var invalidationToken: GitPresentationInvalidationCenter.ObservationToken?
    private let ttl: TimeInterval = 60
    private let maxCacheEntries = 128

    private init() {
        invalidationToken = GitPresentationInvalidationCenter.observe { [weak self] event in
            self?.handleInvalidation(event)
        }
    }

    func identity(for directory: String, allowCached: Bool = true) -> GitProjectIdentity? {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        let key = projectKey(for: normalizedDirectory, allowCached: allowCached)
        guard let key else { return nil }

        let now = Date()
        if allowCached {
            lock.lock()
            if let entry = cache[key], now.timeIntervalSince(entry.fetchedAt) < ttl {
                lock.unlock()
#if DEBUG
                Self.logger.debug("project.identity.cacheHit dir=\(normalizedDirectory, privacy: .public) commonDir=\(key.commonDir, privacy: .public) host=\(entry.identity.hostKind.rawValue, privacy: .public) remotes=\(entry.identity.remotes.count)")
#endif
                return entry.identity
            }
            lock.unlock()
        }

        guard let identity = fetchIdentity(directory: normalizedDirectory, key: key, now: now) else {
#if DEBUG
            Self.logger.debug("project.identity.fetchNil dir=\(normalizedDirectory, privacy: .public) commonDir=\(key.commonDir, privacy: .public)")
#endif
            return nil
        }

        lock.lock()
        cache[key] = Entry(identity: identity, fetchedAt: now)
        keyByDirectory[normalizedDirectory] = key
        pruneCacheLocked(maxEntries: maxCacheEntries)
        lock.unlock()
#if DEBUG
        Self.logger.debug("project.identity.fetched dir=\(normalizedDirectory, privacy: .public) commonDir=\(key.commonDir, privacy: .public) host=\(identity.hostKind.rawValue, privacy: .public) primary=\(identity.primaryRemote?.displaySlug ?? "none", privacy: .public) remotes=\(identity.remotes.count) defaultBranch=\(identity.defaultBranch ?? "nil", privacy: .public)")
#endif
        publish(identity: identity, for: normalizedDirectory)
        return identity
    }

    func identityPublisher(for directory: String) -> AnyPublisher<GitProjectIdentity?, Never> {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        lock.lock()
        let seeded = keyByDirectory[normalizedDirectory].flatMap { cache[$0]?.identity }
        let subject = identitySubjects[normalizedDirectory] ?? CurrentValueSubject<GitProjectIdentity?, Never>(seeded)
        identitySubjects[normalizedDirectory] = subject
        lock.unlock()
        scheduleRefetchIfObserved(directory: normalizedDirectory)
        return subject.eraseToAnyPublisher()
    }

    func remotesPublisher(for directory: String) -> AnyPublisher<[GitRemoteIdentity], Never> {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        lock.lock()
        let seeded = keyByDirectory[normalizedDirectory].flatMap { cache[$0]?.identity.remotes } ?? []
        let subject = remotesSubjects[normalizedDirectory] ?? CurrentValueSubject<[GitRemoteIdentity], Never>(seeded)
        remotesSubjects[normalizedDirectory] = subject
        lock.unlock()
        scheduleRefetchIfObserved(directory: normalizedDirectory)
        return subject.eraseToAnyPublisher()
    }

    func defaultBranchPublisher(for directory: String) -> AnyPublisher<String?, Never> {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        lock.lock()
        let seeded = keyByDirectory[normalizedDirectory].flatMap { cache[$0]?.identity.defaultBranch }
        let subject = defaultBranchSubjects[normalizedDirectory] ?? CurrentValueSubject<String?, Never>(seeded)
        defaultBranchSubjects[normalizedDirectory] = subject
        lock.unlock()
        scheduleRefetchIfObserved(directory: normalizedDirectory)
        return subject.eraseToAnyPublisher()
    }

    func projectKey(for directory: String, allowCached: Bool = true) -> GitProjectKey? {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        if allowCached {
            lock.lock()
            if let cached = keyByDirectory[normalizedDirectory] {
                lock.unlock()
                return cached
            }
            lock.unlock()
        }

        guard let rawCommonDir = GitCommandRunner.runOptional(
            ["rev-parse", "--git-common-dir"],
            in: normalizedDirectory,
            kind: .revParse,
            caller: "GitProjectStore.commonDir"
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawCommonDir.isEmpty else {
#if DEBUG
            Self.logger.debug("project.key.missing dir=\(normalizedDirectory, privacy: .public)")
#endif
            return nil
        }

        let commonDir: String
        if rawCommonDir.hasPrefix("/") {
            commonDir = rawCommonDir
        } else {
            commonDir = URL(fileURLWithPath: rawCommonDir, relativeTo: URL(fileURLWithPath: normalizedDirectory))
                .standardizedFileURL
                .path
        }
        let key = GitProjectKey(commonDir: commonDir)
        lock.lock()
        keyByDirectory[normalizedDirectory] = key
        lock.unlock()
#if DEBUG
        Self.logger.debug("project.key.resolved dir=\(normalizedDirectory, privacy: .public) commonDir=\(key.commonDir, privacy: .public)")
#endif
        return key
    }

    func invalidate(_ key: GitProjectKey) {
        lock.lock()
        cache.removeValue(forKey: key)
        let affectedDirectories = keyByDirectory.compactMap { $0.value == key ? $0.key : nil }
        keyByDirectory = keyByDirectory.filter { $0.value != key }
        lock.unlock()
#if DEBUG
        Self.logger.debug("project.invalidate.key commonDir=\(key.commonDir, privacy: .public) affectedDirs=\(affectedDirectories.count)")
#endif
        for directory in affectedDirectories {
            scheduleRefetchIfObserved(directory: directory, force: true)
        }
    }

    func invalidate(directory: String) {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        lock.lock()
        let key = keyByDirectory.removeValue(forKey: normalizedDirectory)
        if let key { cache.removeValue(forKey: key) }
        let shouldRefetch = hasObservedChannelLocked(directory: normalizedDirectory)
        lock.unlock()
#if DEBUG
        Self.logger.debug("project.invalidate.directory dir=\(normalizedDirectory, privacy: .public) hadKey=\(key != nil) observed=\(shouldRefetch)")
#endif
        if shouldRefetch {
            scheduleRefetchIfObserved(directory: normalizedDirectory, force: true)
        }
    }

    func invalidateAll() {
        lock.lock()
        cache.removeAll()
        keyByDirectory.removeAll()
        let directories = observedDirectoriesLocked()
        lock.unlock()
#if DEBUG
        Self.logger.debug("project.invalidate.all observedDirs=\(directories.count)")
#endif
        for directory in directories {
            scheduleRefetchIfObserved(directory: directory, force: true)
        }
    }

    private func fetchIdentity(directory: String, key: GitProjectKey, now: Date) -> GitProjectIdentity? {
        GitPresentationInvalidationWatcher.shared.watchProject(commonDir: key.commonDir)
#if DEBUG
        Self.logger.debug("project.fetch.start dir=\(directory, privacy: .public) commonDir=\(key.commonDir, privacy: .public)")
#endif
        guard let remoteOutput = GitCommandRunner.runOptional(
            ["remote", "-v"],
            in: directory,
            kind: .remote,
            caller: "GitProjectStore.remoteV"
        ) else {
            let defaultBranch = defaultBranch(directory: directory, remoteName: "origin")
#if DEBUG
            Self.logger.debug("project.fetch.noRemote dir=\(directory, privacy: .public) defaultBranch=\(defaultBranch ?? "nil", privacy: .public)")
#endif
            return GitProjectIdentity(
                key: key,
                worktreeRoot: directory,
                remotes: [],
                primaryRemote: nil,
                defaultBranch: defaultBranch,
                fetchedAt: now
            )
        }

        let remotes = GitRemoteParser.identities(fromRemoteVOutput: remoteOutput)
        let primaryRemote = primaryRemote(from: remotes)
#if DEBUG
        Self.logger.debug("project.fetch.remoteParsed dir=\(directory, privacy: .public) remotes=\(remotes.count) primary=\(primaryRemote?.displaySlug ?? "none", privacy: .public) host=\(primaryRemote?.host.rawValue ?? "unknown", privacy: .public)")
#endif
        return GitProjectIdentity(
            key: key,
            worktreeRoot: directory,
            remotes: remotes,
            primaryRemote: primaryRemote,
            defaultBranch: defaultBranch(directory: directory, remoteName: primaryRemote?.remoteName ?? "origin"),
            fetchedAt: now
        )
    }

    private func defaultBranch(directory: String, remoteName: String) -> String? {
        let remoteName = remoteName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !remoteName.isEmpty else { return nil }
        if let symbolic = GitCommandRunner.runOptional(
            ["symbolic-ref", "--quiet", "--short", "refs/remotes/\(remoteName)/HEAD"],
            in: directory,
            kind: .revParse,
            caller: "GitProjectStore.defaultBranch"
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
           !symbolic.isEmpty {
            let prefix = "\(remoteName)/"
            if symbolic.hasPrefix(prefix) { return String(symbolic.dropFirst(prefix.count)) }
            return symbolic
        }
        return nil
    }

    private func primaryRemote(from remotes: [GitRemoteIdentity]) -> GitRemoteIdentity? {
        remotes.sorted { lhs, rhs in
            let lp = remotePriority(lhs.remoteName)
            let rp = remotePriority(rhs.remoteName)
            if lp != rp { return lp < rp }
            return lhs.remoteName.localizedStandardCompare(rhs.remoteName) == .orderedAscending
        }.first
    }

    private func remotePriority(_ name: String) -> Int {
        switch name.lowercased() {
        case "origin": return 0
        case "upstream": return 1
        default: return 2
        }
    }

    private func handleInvalidation(_ event: GitInvalidationEvent) {
        var shouldInvalidateAll = false
        var projectKeys: [GitProjectKey] = []
        var directories: [String] = []
        for target in event.targets {
            switch target.normalized {
            case .all:
                shouldInvalidateAll = true
            case .project(let commonDir):
                projectKeys.append(GitProjectKey(commonDir: commonDir))
            case .worktree(let path), .directory(let path):
                directories.append(path)
            }
        }
#if DEBUG
        Self.logger.debug("project.handleInvalidation targets=\(event.targets.count) all=\(shouldInvalidateAll) projectKeys=\(projectKeys.count) dirs=\(directories.count) reason=\(event.reason, privacy: .public)")
#endif
        if shouldInvalidateAll {
            invalidateAll()
            return
        }
        for key in projectKeys {
            invalidate(key)
        }
        for directory in directories {
            invalidate(directory: directory)
        }
    }

    private func hasObservedChannelLocked(directory: String) -> Bool {
        identitySubjects[directory] != nil
            || remotesSubjects[directory] != nil
            || defaultBranchSubjects[directory] != nil
    }

    private func observedDirectoriesLocked() -> [String] {
        Array(Set(identitySubjects.keys).union(remotesSubjects.keys).union(defaultBranchSubjects.keys))
    }

    private func scheduleRefetchIfObserved(directory: String, force: Bool = false) {
        lock.lock()
        guard hasObservedChannelLocked(directory: directory) else {
            lock.unlock()
#if DEBUG
            Self.logger.debug("project.refetch.skipUnobserved dir=\(directory, privacy: .public) force=\(force)")
#endif
            return
        }
        if refetchingDirectories.contains(directory) {
            lock.unlock()
#if DEBUG
            Self.logger.debug("project.refetch.skipInFlight dir=\(directory, privacy: .public) force=\(force)")
#endif
            return
        }
        if !force,
           let key = keyByDirectory[directory],
           let entry = cache[key],
           Date().timeIntervalSince(entry.fetchedAt) < ttl {
            let identity = entry.identity
            lock.unlock()
#if DEBUG
            Self.logger.debug("project.refetch.publishCached dir=\(directory, privacy: .public) force=\(force) host=\(identity.hostKind.rawValue, privacy: .public)")
#endif
            publish(identity: identity, for: directory)
            return
        }
        refetchingDirectories.insert(directory)
        lock.unlock()

#if DEBUG
        Self.logger.debug("project.refetch.start dir=\(directory, privacy: .public) force=\(force)")
#endif
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            _ = self.identity(for: directory, allowCached: !force)
            self.lock.lock()
            self.refetchingDirectories.remove(directory)
            self.lock.unlock()
#if DEBUG
            Self.logger.debug("project.refetch.done dir=\(directory, privacy: .public) force=\(force)")
#endif
        }
    }

    private func publish(identity: GitProjectIdentity, for directory: String) {
        lock.lock()
        let identitySubject = identitySubjects[directory]
        let remotesSubject = remotesSubjects[directory]
        let defaultBranchSubject = defaultBranchSubjects[directory]
        lock.unlock()

#if DEBUG
        Self.logger.debug("project.publish dir=\(directory, privacy: .public) host=\(identity.hostKind.rawValue, privacy: .public) primary=\(identity.primaryRemote?.displaySlug ?? "none", privacy: .public) remotes=\(identity.remotes.count)")
#endif
        identitySubject?.send(identity)
        remotesSubject?.send(identity.remotes)
        defaultBranchSubject?.send(identity.defaultBranch)
    }

    private func pruneCacheLocked(maxEntries: Int) {
        guard cache.count > maxEntries else { return }
        let staleKeys = Set(
            cache
                .sorted { $0.value.fetchedAt < $1.value.fetchedAt }
                .prefix(cache.count - maxEntries)
                .map(\.key)
        )
        for key in staleKeys {
            cache.removeValue(forKey: key)
        }
        keyByDirectory = keyByDirectory.filter { !staleKeys.contains($0.value) }
    }
}

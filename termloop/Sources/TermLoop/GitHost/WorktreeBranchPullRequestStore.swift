// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation
import Bonsplit

/// Branch-level PR lookup for the Worktree Agents panel.
///
/// `TabManager` still owns per-panel sidebar PR metadata, but agent worktree
/// rows can exist before/without a stable panel git probe result. This store
/// gives the worktree branch header its own small, throttled lookup path keyed
/// by `(directory, branch)` so a PR created from inside an agent terminal
/// appears in the Worktree Agents section without waiting on panel metadata.
@MainActor
final class WorktreeBranchPullRequestStore: ObservableObject {
    static let shared = WorktreeBranchPullRequestStore()

    struct LookupInput: Hashable {
        let directory: String
        let branch: String
    }

    private struct CacheKey: Hashable {
        let directory: String
        let branch: String
    }

    private struct Entry {
        let states: [SidebarPullRequestState]
        let fetchedAt: Date
        let nextRefreshAt: Date
    }

    private enum FetchResult: Sendable {
        case resolved([GitHostPullRequestProbeItem])
        case notFound
        case transientFailure
        case unsupportedRepository
    }

    @Published private(set) var version: UInt64 = 0

    private var entries: [CacheKey: Entry] = [:]
    private var inflight: Set<CacheKey> = []
    private var inflightFetchRoots: Set<String> = []
    private var lastFetchAtByRoot: [String: Date] = [:]
    private let positiveRefreshInterval: TimeInterval = 20
    private let absentRefreshInterval: TimeInterval = 15
    private let terminalRefreshInterval: TimeInterval = 15 * 60
    private let fetchThrottleInterval: TimeInterval = 60
    private let maxEntries = 256

    private init() {}

    /// All cached PRs for a `(directory, branch)`, lead-first.
    func cachedPullRequests(directory: String?, branch: String) -> [SidebarPullRequestState] {
        guard let key = cacheKey(directory: directory, branch: branch) else { return [] }
        return entries[key]?.states ?? []
    }

    /// Convenience for callers that only need the lead PR. Prefer
    /// `cachedPullRequests` when surfacing all of a branch's PRs.
    func cachedPullRequest(directory: String?, branch: String) -> SidebarPullRequestState? {
        cachedPullRequests(directory: directory, branch: branch).first
    }

    func ensureLookup(
        directory: String?,
        branch: String,
        reason: String,
        force: Bool = false
    ) {
        guard let key = cacheKey(directory: directory, branch: branch) else { return }
        let now = Date()
        if !force, let entry = entries[key], entry.nextRefreshAt > now {
            return
        }
        guard !inflight.contains(key) else { return }
        inflight.insert(key)

#if DEBUG
        dlog("worktree.prLookup.schedule branch=\(key.branch) dir=\(key.directory) reason=\(reason) force=\(force ? 1 : 0)")
#endif

        Task.detached(priority: .utility) {
            let result = await Self.fetch(directory: key.directory, branch: key.branch)
            await MainActor.run {
                self.apply(result, for: key)
            }
        }
    }

    private func apply(_ result: FetchResult, for key: CacheKey) {
        inflight.remove(key)

        let now = Date()
        let previous = entries[key]?.states ?? []
        let nextStates: [SidebarPullRequestState]
        let interval: TimeInterval
        let resultLabel: String

        switch result {
        case .resolved(let items):
            nextStates = items.compactMap { Self.sidebarState(from: $0, branch: key.branch) }
            // Refresh aggressively while any PR is still open; once they
            // are all merged/closed, fall back to the long terminal sweep.
            let anyOpen = nextStates.contains { $0.status == .open }
            interval = anyOpen ? positiveRefreshInterval : (nextStates.isEmpty ? absentRefreshInterval : terminalRefreshInterval)
            if nextStates.isEmpty {
                resultLabel = "invalid"
            } else if nextStates.count == 1, let one = nextStates.first {
                resultLabel = "#\(one.number):\(one.displayStatus)"
            } else {
                resultLabel = "\(nextStates.count)PRs"
            }
        case .notFound:
            nextStates = []
            interval = absentRefreshInterval
            resultLabel = "none"
        case .unsupportedRepository:
            nextStates = []
            interval = absentRefreshInterval
            resultLabel = "unsupported"
        case .transientFailure:
            nextStates = previous.map {
                SidebarPullRequestState(
                    number: $0.number,
                    label: $0.label,
                    url: $0.url,
                    status: $0.status,
                    statusDetail: $0.statusDetail,
                    branch: $0.branch,
                    baseBranch: $0.baseBranch,
                    isStale: true
                )
            }
            interval = absentRefreshInterval
            resultLabel = "transientFailure"
        }

        let nextEntry = Entry(
            states: nextStates,
            fetchedAt: now,
            nextRefreshAt: now.addingTimeInterval(interval)
        )
        entries[key] = nextEntry
        pruneIfNeeded()

        if shouldRefreshRepoRefs(previous: previous, next: nextStates) {
            scheduleRepoFetch(for: key.directory)
        }

        if previous != nextStates {
            version &+= 1
        }

#if DEBUG
        dlog("worktree.prLookup.apply branch=\(key.branch) dir=\(key.directory) result=\(resultLabel)")
#endif
    }

    private func pruneIfNeeded() {
        guard entries.count > maxEntries else { return }
        let overflow = entries.count - maxEntries
        let keysToDrop = entries
            .sorted { lhs, rhs in lhs.value.fetchedAt < rhs.value.fetchedAt }
            .prefix(overflow)
            .map(\.key)
        for key in keysToDrop {
            entries.removeValue(forKey: key)
            inflight.remove(key)
        }
    }

    private func cacheKey(directory: String?, branch: String) -> CacheKey? {
        let trimmedDirectory = directory?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedDirectory.isEmpty, !trimmedBranch.isEmpty else { return nil }
        return CacheKey(
            directory: URL(fileURLWithPath: trimmedDirectory).standardizedFileURL.path,
            branch: trimmedBranch
        )
    }

    private func shouldRefreshRepoRefs(
        previous: [SidebarPullRequestState],
        next: [SidebarPullRequestState]
    ) -> Bool {
        guard next.contains(where: { $0.status == .merged }) else { return false }
        return !previous.contains(where: { $0.status == .merged })
    }

    private func scheduleRepoFetch(for directory: String) {
        guard !inflightFetchRoots.contains(directory) else { return }
        let now = Date()
        if let lastFetchAt = lastFetchAtByRoot[directory],
           now.timeIntervalSince(lastFetchAt) < fetchThrottleInterval {
            return
        }

        inflightFetchRoots.insert(directory)
        lastFetchAtByRoot[directory] = now

        Task.detached(priority: .utility) {
            defer {
                Task { @MainActor in
                    self.inflightFetchRoots.remove(directory)
                }
            }

            guard let projectRoot = Self.projectRoot(for: directory) else { return }
            do {
                try ProcessGitStateProvider().fetchAll(projectRoot: projectRoot)
                await MainActor.run {
                    self.version &+= 1
                }
            } catch {
#if DEBUG
                dlog("worktree.prLookup.fetch.failed dir=\(directory) root=\(projectRoot) error=\(error.localizedDescription)")
#endif
            }
        }
    }

    nonisolated private static func projectRoot(for directory: String) -> String? {
        let git = ProcessGitStateProvider()
        guard let output = try? git.runRaw(["rev-parse", "--show-toplevel"], cwd: directory) else {
            return nil
        }
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func fetch(directory: String, branch: String) async -> FetchResult {
        let identities = GitProjectStore.shared.pullRequestRepositoryIdentities(for: directory)
        guard !identities.isEmpty else {
#if DEBUG
            dlog("worktree.prLookup.repo.unsupported branch=\(branch) dir=\(directory)")
#endif
            return .unsupportedRepository
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 8
        let session = URLSession(configuration: configuration)

        var sawTransientFailure = false
        var candidates: [GitHostPullRequestProbeItem] = []

        for identity in identities {
            let pullRequests: [GitHostPullRequestProbeItem]?
            if identity.host == .gitLab {
                pullRequests = await fetchGitLabMergeRequests(
                    identity: identity,
                    branch: branch,
                    session: session
                )
            } else {
                let repoSlug = identity.displaySlug
                let authHeader = GitHostPullRequestProbe.authHeader(repoSlug: repoSlug, directory: directory)
                pullRequests = await GitHostPullRequestProbe.fetchBranch(
                    repoSlug: repoSlug,
                    branch: branch,
                    pageSize: 100,
                    session: session,
                    authHeader: authHeader
                )
            }
            guard let pullRequests else {
                sawTransientFailure = true
                continue
            }

            candidates.append(
                contentsOf: pullRequests.filter {
                    normalizedBranchName($0.headRefName) == normalizedBranchName(branch)
                }
            )
        }

        let sorted = PullRequestOrdering.sortedPullRequests(from: candidates)
        if !sorted.isEmpty {
            return .resolved(sorted)
        }
        return sawTransientFailure ? .transientFailure : .notFound
    }

    private static func sidebarState(
        from item: GitHostPullRequestProbeItem,
        branch: String
    ) -> SidebarPullRequestState? {
        guard let status = PullRequestOrdering.pullRequestStatus(from: item.state),
              let url = URL(string: item.url) else {
            return nil
        }
        return SidebarPullRequestState(
            number: item.number,
            label: item.label,
            url: url,
            status: status,
            statusDetail: item.statusDetail,
            branch: branch,
            baseBranch: item.baseRefName,
            isStale: false
        )
    }

    private static let iso8601Formatter: ISO8601DateFormatter = ISO8601DateFormatter()

    /// Fetch merge requests for a GitLab identity through the host provider
    /// and convert them to the legacy probe-item shape so the rest of the
    /// pipeline (filter / preferred / sidebar mapping) stays unchanged.
    private static func fetchGitLabMergeRequests(
        identity: GitRemoteIdentity,
        branch: String,
        session: URLSession
    ) async -> [GitHostPullRequestProbeItem]? {
        let provider = GitLabHostProvider(identity: identity, session: session)
        do {
            let mergeRequests = try await provider.listPullRequests(branch: branch)
            return mergeRequests.map { mergeRequestToProbeItem($0) }
        } catch {
#if DEBUG
            dlog("worktree.prLookup.gitlab.failed branch=\(branch) repo=\(identity.displaySlug) error=\(error)")
#endif
            return nil
        }
    }

    private static func mergeRequestToProbeItem(_ pr: HostPullRequest) -> GitHostPullRequestProbeItem {
        let stateString: String
        let detail: String?
        switch pr.state {
        case .open:    stateString = "OPEN";    detail = "open"
        case .draft:   stateString = "DRAFT";   detail = "draft"
        case .merged:  stateString = "MERGED";  detail = "merged"
        case .closed:  stateString = "CLOSED";  detail = "closed"
        case .unknown: stateString = "UNKNOWN"; detail = nil
        }
        let updatedAt = pr.updatedAt.map { iso8601Formatter.string(from: $0) }
        return GitHostPullRequestProbeItem(
            number: pr.number,
            state: stateString,
            statusDetail: detail,
            url: pr.url.absoluteString,
            updatedAt: updatedAt,
            headRefName: pr.sourceBranch,
            baseRefName: pr.targetBranch,
            label: "MR"
        )
    }

    private static func normalizedBranchName(_ branch: String?) -> String? {
        guard let branch else { return nil }
        let trimmed = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let prefix = "refs/heads/"
        return trimmed.hasPrefix(prefix) ? String(trimmed.dropFirst(prefix.count)) : trimmed
    }
}

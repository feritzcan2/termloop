// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

protocol TaskPullRequestClient {
    func isAuthenticated(identity: GitRemoteIdentity) async -> Bool
    func prList(identity: GitRemoteIdentity, branches: [String]) async throws -> [(branch: String, info: TermLoopTask.PRInfo)]
}

/// Task-sync PR lookup backed by the same host-provider abstraction used by
/// the sidebar. Despite the historical file name, this is no longer a gh CLI
/// wrapper; GitHub and Azure DevOps both flow through `GitHostProvider`.
struct GitHostTaskPullRequestClient: TaskPullRequestClient {
    typealias ProviderFactory = (GitRemoteIdentity) -> (any GitHostProvider)?

    var providerFactory: ProviderFactory = { GitHostPullRequestProviderFactory.provider(for: $0) }

    func isAuthenticated(identity: GitRemoteIdentity) async -> Bool {
        GitHostAuthResolver.authorization(for: identity) != nil
    }

    func prList(identity: GitRemoteIdentity, branches: [String]) async throws -> [(branch: String, info: TermLoopTask.PRInfo)] {
        guard let provider = providerFactory(identity) else { return [] }
        let uniqueBranches = Array(Set(branches.map(Self.normalizedBranch).filter { !$0.isEmpty }))
        guard !uniqueBranches.isEmpty else { return [] }

        var merged: [(branch: String, info: TermLoopTask.PRInfo)] = []
        for branch in uniqueBranches {
            let pullRequests = try await provider.listPullRequests(branch: branch)
            for pullRequest in pullRequests where Self.normalizedBranch(pullRequest.sourceBranch) == branch {
                merged.append((branch: branch, info: Self.info(from: pullRequest)))
            }
        }
        return merged
    }

    private static func info(from pullRequest: HostPullRequest) -> TermLoopTask.PRInfo {
        TermLoopTask.PRInfo(
            url: pullRequest.url,
            number: pullRequest.number,
            state: state(from: pullRequest.state),
            title: pullRequest.title
        )
    }

    private static func state(from state: HostPullRequest.State) -> TermLoopTask.PRInfo.State {
        switch state {
        case .draft:
            return .draft
        case .merged:
            return .merged
        case .closed:
            return .closed
        case .open, .unknown:
            return .open
        }
    }

    private static func normalizedBranch(_ branch: String) -> String {
        branch.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

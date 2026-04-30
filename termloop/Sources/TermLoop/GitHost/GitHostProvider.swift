// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Host-agnostic authentication handle. Concrete providers decide how to
/// resolve the token (Keychain, CLI helper, OAuth) so UI code does not branch
/// on GitHub vs Azure DevOps.
enum GitHostAuth: Equatable, Sendable {
    case none
    case ghCLI
    case personalAccessToken(account: String, keychainService: String)
}

struct HostPullRequest: Equatable, Identifiable, Sendable {
    enum State: String, Equatable, Sendable {
        case open
        case merged
        case closed
        case draft
        case unknown
    }

    let id: String
    let number: Int
    let title: String
    let url: URL
    let sourceBranch: String
    let targetBranch: String?
    let state: State
    let updatedAt: Date?
}

struct CreatePullRequestInput: Equatable, Sendable {
    let title: String
    let description: String
    let sourceBranch: String
    let targetBranch: String
    let draft: Bool
}

protocol GitHostProvider {
    var identity: GitRemoteIdentity { get }

    func pullRequestURL(number: Int) -> URL?
    func listPullRequests(branch: String) async throws -> [HostPullRequest]
    func createPullRequest(_ input: CreatePullRequestInput) async throws -> HostPullRequest
}

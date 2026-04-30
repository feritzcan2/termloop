// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

extension GitProjectStore {
    func primaryRemote(for directory: String) -> GitRemoteIdentity? {
        identity(for: directory)?.primaryRemote
    }

    func repositoryIdentities(for directory: String) -> [GitRemoteIdentity] {
        identity(for: directory)?.remotes ?? []
    }

    func githubRepositorySlugs(for directory: String) -> [String] {
        repositoryIdentities(for: directory).compactMap { remote in
            guard remote.host == .github, remote.github?.host == "github.com" else { return nil }
            return remote.github?.slug
        }
    }

    func pullRequestRepositoryIdentities(for directory: String) -> [GitRemoteIdentity] {
        repositoryIdentities(for: directory).filter { remote in
            switch remote.host {
            case .github, .githubEnterprise, .azureDevOps, .gitLab:
                return true
            case .unknown:
                return false
            }
        }
    }

    func primaryPullRequestRepositoryIdentity(for directory: String) -> GitRemoteIdentity? {
        if let primary = primaryRemote(for: directory) {
            switch primary.host {
            case .github, .githubEnterprise, .azureDevOps, .gitLab:
                return primary
            case .unknown:
                break
            }
        }
        return pullRequestRepositoryIdentities(for: directory).first
    }
}

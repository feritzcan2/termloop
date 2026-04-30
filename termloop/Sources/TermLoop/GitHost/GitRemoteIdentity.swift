// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum GitHostKind: String, Hashable, Sendable {
    case github
    case githubEnterprise
    case azureDevOps
    case gitLab
    case unknown
}

struct GitHubIdentity: Hashable, Sendable {
    let owner: String
    let repo: String
    let host: String

    var slug: String { "\(owner)/\(repo)" }
}

struct AzureDevOpsIdentity: Hashable, Sendable {
    let organization: String
    let project: String
    let repo: String
    let host: String

    var slug: String { "\(organization)/\(project)/\(repo)" }
}

/// Captures GitLab's variable-depth project paths (`group/subgroup/.../repo`).
/// MVP only supports gitlab.com; self-hosted detection is a follow-up.
struct GitLabIdentity: Hashable, Sendable {
    let host: String
    /// Namespace path components (group, optional subgroups). Empty means
    /// user-owned repo at root.
    let namespacePath: [String]
    let repo: String

    /// `group/subgroup/repo` — the slash-joined GitLab project full path. This
    /// is what the API project lookup expects (URL-encoded as `%2F`).
    var fullPath: String {
        (namespacePath + [repo]).joined(separator: "/")
    }

    /// `host/group/subgroup/repo` — used as identity display slug to keep it
    /// distinguishable from Azure DevOps `org/project/repo` slugs in the
    /// legacy slug-string probe path.
    var slug: String { "\(host)/\(fullPath)" }
}

struct GitRemoteIdentity: Hashable, Sendable {
    let host: GitHostKind
    let remoteName: String
    let cloneURL: String
    let displaySlug: String
    let webURL: URL?
    let github: GitHubIdentity?
    let azureDevOps: AzureDevOpsIdentity?
    let gitLab: GitLabIdentity?

    init(
        host: GitHostKind,
        remoteName: String,
        cloneURL: String,
        displaySlug: String,
        webURL: URL?,
        github: GitHubIdentity? = nil,
        azureDevOps: AzureDevOpsIdentity? = nil,
        gitLab: GitLabIdentity? = nil
    ) {
        self.host = host
        self.remoteName = remoteName
        self.cloneURL = cloneURL
        self.displaySlug = displaySlug
        self.webURL = webURL
        self.github = github
        self.azureDevOps = azureDevOps
        self.gitLab = gitLab
    }
}

enum GitRemoteParser {
    static func identities(fromRemoteVOutput output: String) -> [GitRemoteIdentity] {
        var byRemote: [String: GitRemoteIdentity] = [:]

        for line in output.split(whereSeparator: \.isNewline) {
            let parts = line.split(whereSeparator: \.isWhitespace)
            guard parts.count >= 2 else { continue }
            let remoteName = String(parts[0])
            let remoteURL = String(parts[1])
            let remoteKind = parts.count >= 3 ? String(parts[2]) : "(fetch)"
            guard remoteKind == "(fetch)", byRemote[remoteName] == nil,
                  let identity = identity(remoteName: remoteName, cloneURL: remoteURL) else {
                continue
            }
            byRemote[remoteName] = identity
        }

        return orderedDeduped(Array(byRemote.values))
    }

    static func identity(remoteName: String, cloneURL: String) -> GitRemoteIdentity? {
        let trimmed = cloneURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let scp = parseSCPStyle(trimmed) {
            return identity(remoteName: remoteName, cloneURL: trimmed, host: scp.host, pathComponents: scp.pathComponents)
        }

        guard let url = URL(string: trimmed), let host = url.host?.lowercased() else {
            return nil
        }
        let components = pathComponents(from: url.path)
        return identity(remoteName: remoteName, cloneURL: trimmed, host: host, pathComponents: components)
    }

    static func githubRepositorySlugs(fromRemoteVOutput output: String) -> [String] {
        identities(fromRemoteVOutput: output).compactMap { identity in
            guard identity.host == .github,
                  identity.github?.host == "github.com" else { return nil }
            return identity.github?.slug
        }
    }

    static func githubRepositorySlug(fromRemoteURL remoteURL: String) -> String? {
        guard let identity = identity(remoteName: "origin", cloneURL: remoteURL),
              identity.host == .github,
              identity.github?.host == "github.com" else {
            return nil
        }
        return identity.github?.slug
    }

    private static func identity(
        remoteName: String,
        cloneURL: String,
        host rawHost: String,
        pathComponents rawComponents: [String]
    ) -> GitRemoteIdentity? {
        let host = rawHost.lowercased()
        let components = rawComponents.map(normalizeComponent).filter { !$0.isEmpty }

        if host == "dev.azure.com" || host == "ssh.dev.azure.com" {
            return azureDevOpsIdentity(
                remoteName: remoteName,
                cloneURL: cloneURL,
                host: host,
                components: components,
                legacyOrg: nil
            )
        }

        if host.hasSuffix(".visualstudio.com") {
            let organization = String(host.dropLast(".visualstudio.com".count))
            return azureDevOpsIdentity(
                remoteName: remoteName,
                cloneURL: cloneURL,
                host: host,
                components: components,
                legacyOrg: organization
            )
        }

        if host == "github.com" {
            return githubIdentity(
                remoteName: remoteName,
                cloneURL: cloneURL,
                host: host,
                kind: .github,
                components: components
            )
        }

        if isLikelyGitHubEnterpriseHost(host: host, components: components) {
            return githubIdentity(
                remoteName: remoteName,
                cloneURL: cloneURL,
                host: host,
                kind: .githubEnterprise,
                components: components
            )
        }

        if host == "gitlab.com" {
            return gitLabIdentity(
                remoteName: remoteName,
                cloneURL: cloneURL,
                host: host,
                components: components
            )
        }

        guard components.count >= 2 else { return nil }
        let display = "\(host)/\(components[0])/\(stripGitSuffix(components[1]))"
        return GitRemoteIdentity(
            host: .unknown,
            remoteName: remoteName,
            cloneURL: cloneURL,
            displaySlug: display,
            webURL: nil
        )
    }

    private static func gitLabIdentity(
        remoteName: String,
        cloneURL: String,
        host: String,
        components: [String]
    ) -> GitRemoteIdentity? {
        guard components.count >= 2 else { return nil }
        let repo = stripGitSuffix(components.last ?? "")
        let namespacePath = Array(components.dropLast())
        guard !repo.isEmpty, namespacePath.allSatisfy({ !$0.isEmpty }) else { return nil }
        let gitLab = GitLabIdentity(host: host, namespacePath: namespacePath, repo: repo)
        let url = URL(string: "https://\(host)/\(gitLab.fullPath)")
        return GitRemoteIdentity(
            host: .gitLab,
            remoteName: remoteName,
            cloneURL: cloneURL,
            displaySlug: gitLab.slug,
            webURL: url,
            gitLab: gitLab
        )
    }

    private static func githubIdentity(
        remoteName: String,
        cloneURL: String,
        host: String,
        kind: GitHostKind,
        components: [String]
    ) -> GitRemoteIdentity? {
        guard components.count >= 2 else { return nil }
        let owner = components[0]
        let repo = stripGitSuffix(components[1])
        guard !owner.isEmpty, !repo.isEmpty else { return nil }
        let github = GitHubIdentity(owner: owner, repo: repo, host: host)
        let url = URL(string: "https://\(host)/\(owner)/\(repo)")
        return GitRemoteIdentity(
            host: kind,
            remoteName: remoteName,
            cloneURL: cloneURL,
            displaySlug: github.slug,
            webURL: url,
            github: github
        )
    }

    private static func azureDevOpsIdentity(
        remoteName: String,
        cloneURL: String,
        host: String,
        components: [String],
        legacyOrg: String?
    ) -> GitRemoteIdentity? {
        let parsed: (org: String, project: String, repo: String)?

        if let legacyOrg {
            // https://{org}.visualstudio.com/{project}/_git/{repo}
            guard components.count >= 3,
                  components[1].lowercased() == "_git" else { return nil }
            parsed = (legacyOrg, components[0], stripGitSuffix(components[2]))
        } else if components.first?.lowercased() == "v3" {
            // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
            guard components.count >= 4 else { return nil }
            parsed = (components[1], components[2], stripGitSuffix(components[3]))
        } else {
            // https://dev.azure.com/{org}/{project}/_git/{repo}
            guard components.count >= 4,
                  components[2].lowercased() == "_git" else { return nil }
            parsed = (components[0], components[1], stripGitSuffix(components[3]))
        }

        guard let parsed,
              !parsed.org.isEmpty, !parsed.project.isEmpty, !parsed.repo.isEmpty else {
            return nil
        }
        let azure = AzureDevOpsIdentity(
            organization: parsed.org,
            project: parsed.project,
            repo: parsed.repo,
            host: host
        )
        let url: URL?
        if legacyOrg != nil {
            url = URL(string: "https://\(parsed.org).visualstudio.com/\(parsed.project)/_git/\(parsed.repo)")
        } else {
            url = URL(string: "https://dev.azure.com/\(parsed.org)/\(parsed.project)/_git/\(parsed.repo)")
        }
        return GitRemoteIdentity(
            host: .azureDevOps,
            remoteName: remoteName,
            cloneURL: cloneURL,
            displaySlug: azure.slug,
            webURL: url,
            azureDevOps: azure
        )
    }

    private static func parseSCPStyle(_ value: String) -> (host: String, pathComponents: [String])? {
        // git@github.com:owner/repo.git or git@ssh.dev.azure.com:v3/org/project/repo
        guard let at = value.firstIndex(of: "@"),
              let colon = value[value.index(after: at)...].firstIndex(of: ":") else {
            return nil
        }
        let host = String(value[value.index(after: at)..<colon]).lowercased()
        let path = String(value[value.index(after: colon)...])
        return (host, pathComponents(from: path))
    }

    private static func pathComponents(from rawPath: String) -> [String] {
        rawPath
            .split(separator: "/")
            .map(String.init)
            .map(normalizeComponent)
            .filter { !$0.isEmpty }
    }

    private static func normalizeComponent(_ value: String) -> String {
        (value.removingPercentEncoding ?? value)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private static func stripGitSuffix(_ value: String) -> String {
        value.hasSuffix(".git") ? String(value.dropLast(4)) : value
    }

    private static func isLikelyGitHubEnterpriseHost(host: String, components: [String]) -> Bool {
        guard components.count >= 2,
              !components[0].isEmpty,
              !stripGitSuffix(components[1]).isEmpty else {
            return false
        }
        return host.hasPrefix("github.") || host.hasSuffix(".github.com")
    }

    private static func orderedDeduped(_ identities: [GitRemoteIdentity]) -> [GitRemoteIdentity] {
        let sorted = identities.sorted { lhs, rhs in
            let lp = remotePriority(lhs.remoteName)
            let rp = remotePriority(rhs.remoteName)
            if lp != rp { return lp < rp }
            return lhs.remoteName.localizedStandardCompare(rhs.remoteName) == .orderedAscending
        }

        var seen = Set<String>()
        var result: [GitRemoteIdentity] = []
        for identity in sorted {
            let key = "\(identity.host.rawValue)|\(identity.displaySlug.lowercased())"
            guard seen.insert(key).inserted else { continue }
            result.append(identity)
        }
        return result
    }

    private static func remotePriority(_ remoteName: String) -> Int {
        switch remoteName.lowercased() {
        case "origin": return 0
        case "upstream": return 1
        default: return 2
        }
    }
}

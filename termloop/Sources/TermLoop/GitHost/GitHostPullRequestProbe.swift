// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

struct GitHostPullRequestProbeItem: Equatable, Sendable {
    let number: Int
    let state: String
    let statusDetail: String?
    let url: String
    let updatedAt: String?
    let headRefName: String?
    let baseRefName: String?
    /// UI label — "PR" for GitHub/Azure, "MR" for GitLab.
    let label: String

    init(
        number: Int,
        state: String,
        statusDetail: String? = nil,
        url: String,
        updatedAt: String?,
        headRefName: String? = nil,
        baseRefName: String? = nil,
        label: String = "PR"
    ) {
        self.number = number
        self.state = state
        self.statusDetail = statusDetail
        self.url = url
        self.updatedAt = updatedAt
        self.headRefName = headRefName
        self.baseRefName = baseRefName
        self.label = label
    }
}

enum GitHostPullRequestProbe {
    private static let logger = Logger(subsystem: "com.termloop.git", category: "pull-request-probe")
    private static let authHeaderCacheLock = NSLock()
    private static var authHeaderCache: [AuthHeaderCacheKey: AuthHeaderCacheEntry] = [:]
    private static let authHeaderCacheLifetime: TimeInterval = 60
    private static let maxAuthHeaderCacheEntries = 256

    private enum RepositoryKind: Sendable {
        case github(owner: String, repo: String)
        case azureDevOps(organization: String, project: String, repo: String)
    }

    private struct AuthHeaderCacheKey: Hashable {
        let repoSlug: String
        let directory: String
    }

    private struct AuthHeaderCacheEntry {
        let fetchedAt: Date
        let header: String?
    }

    private struct HTTPResponse: Sendable {
        let statusCode: Int
        let data: Data

        var debugBody: String {
            guard let body = String(data: data.prefix(400), encoding: .utf8) else { return "" }
            return body.replacingOccurrences(of: "\n", with: " ")
        }
    }

    private struct GitHubPullRequestRESTItem: Decodable, Sendable {
        struct Ref: Decodable, Sendable { let ref: String }

        let number: Int
        let state: String
        let htmlURL: String
        let updatedAt: String?
        let mergedAt: String?
        let draft: Bool?
        let head: Ref
        let base: Ref

        enum CodingKeys: String, CodingKey {
            case number, state, draft, head, base
            case htmlURL = "html_url"
            case updatedAt = "updated_at"
            case mergedAt = "merged_at"
        }
    }

    private struct AzurePullRequestListResponse: Decodable, Sendable {
        let value: [AzurePullRequestRESTItem]
    }

    private struct AzurePullRequestRESTItem: Decodable, Sendable {
        let pullRequestId: Int
        let status: String
        let title: String?
        let isDraft: Bool?
        let sourceRefName: String?
        let targetRefName: String?
        let creationDate: String?
        let closedDate: String?
    }

    static func isSupported(repoSlug: String) -> Bool {
        repositoryKind(repoSlug: repoSlug) != nil
    }

    static func fetchRecent(
        repoSlug: String,
        pageLimit: Int,
        pageSize: Int,
        session: URLSession,
        authHeader: String?
    ) async -> [GitHostPullRequestProbeItem]? {
        guard let kind = repositoryKind(repoSlug: repoSlug) else { return nil }
        var all: [GitHostPullRequestProbeItem] = []
        var page = 1
        while page <= pageLimit {
            guard let endpoint = repoEndpoint(kind: kind, page: page, pageSize: pageSize),
                  let response = await request(session: session, kind: kind, endpoint: endpoint, authHeader: authHeader) else {
                return nil
            }
            guard response.statusCode == 200 else {
#if DEBUG
                logger.debug("git.prProbe.recent.http status=\(response.statusCode) repo=\(repoSlug, privacy: .public) page=\(page) body=\(response.debugBody, privacy: .public)")
#endif
                return nil
            }
            guard let items = probeItems(kind: kind, data: response.data) else {
                return nil
            }
#if DEBUG
            logger.debug("git.prProbe.recent.page repo=\(repoSlug, privacy: .public) page=\(page) items=\(items.count)")
#endif
            all.append(contentsOf: items)
            if items.count < pageSize { break }
            page += 1
        }
#if DEBUG
        logger.debug("git.prProbe.recent.done repo=\(repoSlug, privacy: .public) total=\(all.count)")
#endif
        return all
    }

    static func fetchBranch(
        repoSlug: String,
        branch: String,
        pageSize: Int,
        session: URLSession,
        authHeader: String?,
        pageLimit: Int = 4
    ) async -> [GitHostPullRequestProbeItem]? {
        guard let kind = repositoryKind(repoSlug: repoSlug) else { return nil }
        var all: [GitHostPullRequestProbeItem] = []
        var page = 1
        while page <= pageLimit {
            guard let endpoint = branchEndpoint(kind: kind, branch: branch, page: page, pageSize: pageSize),
                  let response = await request(session: session, kind: kind, endpoint: endpoint, authHeader: authHeader) else {
                return nil
            }
            guard response.statusCode == 200 else {
#if DEBUG
                logger.debug("git.prProbe.branch.http status=\(response.statusCode) repo=\(repoSlug, privacy: .public) branch=\(branch, privacy: .public) body=\(response.debugBody, privacy: .public)")
#endif
                return nil
            }
            guard let items = probeItems(kind: kind, data: response.data) else { return nil }
#if DEBUG
            logger.debug("git.prProbe.branch.page repo=\(repoSlug, privacy: .public) branch=\(branch, privacy: .public) page=\(page) items=\(items.count)")
#endif
            all.append(contentsOf: items)
            if items.count < pageSize { break }
            page += 1
        }
#if DEBUG
        logger.debug("git.prProbe.branch.done repo=\(repoSlug, privacy: .public) branch=\(branch, privacy: .public) total=\(all.count)")
#endif
        return all
    }

    static func authHeader(
        repoSlug: String,
        directory: String
    ) -> String? {
        guard let kind = repositoryKind(repoSlug: repoSlug) else { return nil }
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        let cacheKey = AuthHeaderCacheKey(repoSlug: repoSlug, directory: normalizedDirectory)
        let now = Date()
        authHeaderCacheLock.lock()
        if let cached = authHeaderCache[cacheKey],
           now.timeIntervalSince(cached.fetchedAt) < authHeaderCacheLifetime {
            authHeaderCacheLock.unlock()
            return cached.header
        }
        authHeaderCacheLock.unlock()

        let identity = GitProjectStore.shared
            .pullRequestRepositoryIdentities(for: normalizedDirectory)
            .first { $0.displaySlug == repoSlug && repositoryKindsMatch(repositoryKind(identity: $0), kind) }
        guard let identity else {
#if DEBUG
            logger.debug("git.prProbe.auth.identityMissing repo=\(repoSlug, privacy: .public) dir=\(normalizedDirectory, privacy: .public)")
#endif
            storeCachedAuthHeader(nil, for: cacheKey, now: now)
            return nil
        }
        let authorization = GitHostAuthResolver.authorization(for: identity)
#if DEBUG
        logger.debug("git.prProbe.auth repo=\(repoSlug, privacy: .public) host=\(identity.host.rawValue, privacy: .public) source=\(authorization?.source.rawValue ?? "nil", privacy: .public)")
#endif
        let header = authorization?.headerValue
        storeCachedAuthHeader(header, for: cacheKey, now: now)
        return header
    }

    private static func storeCachedAuthHeader(
        _ header: String?,
        for key: AuthHeaderCacheKey,
        now: Date
    ) {
        authHeaderCacheLock.lock()
        defer { authHeaderCacheLock.unlock() }
        authHeaderCache[key] = AuthHeaderCacheEntry(fetchedAt: now, header: header)
        if authHeaderCache.count > maxAuthHeaderCacheEntries {
            let cutoff = now.addingTimeInterval(-authHeaderCacheLifetime)
            authHeaderCache = authHeaderCache.filter { $0.value.fetchedAt >= cutoff }
            if authHeaderCache.count > maxAuthHeaderCacheEntries,
               let oldestKey = authHeaderCache.min(by: { $0.value.fetchedAt < $1.value.fetchedAt })?.key {
                authHeaderCache.removeValue(forKey: oldestKey)
            }
        }
    }

    private static func repositoryKind(identity: GitRemoteIdentity) -> RepositoryKind? {
        switch identity.host {
        case .github, .githubEnterprise:
            guard let github = identity.github else { return nil }
            return .github(owner: github.owner, repo: github.repo)
        case .azureDevOps:
            guard let azure = identity.azureDevOps else { return nil }
            return .azureDevOps(organization: azure.organization, project: azure.project, repo: azure.repo)
        case .gitLab, .unknown:
            return nil
        }
    }

    private static func repositoryKindsMatch(_ lhs: RepositoryKind?, _ rhs: RepositoryKind) -> Bool {
        guard let lhs else { return false }
        switch (lhs, rhs) {
        case let (.github(lo, lr), .github(ro, rr)):
            return lo == ro && lr == rr
        case let (.azureDevOps(lo, lp, lr), .azureDevOps(ro, rp, rr)):
            return lo == ro && lp == rp && lr == rr
        default:
            return false
        }
    }

    private static func repositoryKind(repoSlug: String) -> RepositoryKind? {
        // GitLab identities use a host-prefixed display slug
        // (`gitlab.com/group/.../repo`) to stay distinguishable from Azure
        // DevOps `org/project/repo`. The legacy slug-string path below does
        // not support GitLab; those are routed through the provider in the
        // WorktreeBranchPullRequestStore.
        if repoSlug.lowercased().hasPrefix("gitlab.com/") {
            return nil
        }
        let components = repoSlug.split(separator: "/").map(String.init)
        switch components.count {
        case 2:
            guard !components[0].isEmpty, !components[1].isEmpty else { return nil }
            return .github(owner: components[0], repo: components[1])
        case 3:
            guard !components[0].isEmpty, !components[1].isEmpty, !components[2].isEmpty else { return nil }
            return .azureDevOps(organization: components[0], project: components[1], repo: components[2])
        default:
            return nil
        }
    }

    private static func repoEndpoint(kind: RepositoryKind, page: Int, pageSize: Int) -> String? {
        switch kind {
        case .github(let owner, let repo):
            return "repos/\(owner)/\(repo)/pulls?state=all&sort=updated&direction=desc&per_page=\(pageSize)&page=\(page)"
        case .azureDevOps:
            var query = URLComponents()
            query.queryItems = [
                URLQueryItem(name: "searchCriteria.status", value: "all"),
                URLQueryItem(name: "$top", value: String(pageSize)),
                URLQueryItem(name: "$skip", value: String(max(page - 1, 0) * pageSize)),
                URLQueryItem(name: "api-version", value: "7.1"),
            ]
            return query.percentEncodedQuery
        }
    }

    private static func branchEndpoint(kind: RepositoryKind, branch: String, page: Int, pageSize: Int) -> String? {
        switch kind {
        case .github(let owner, let repo):
            var query = URLComponents()
            query.queryItems = [
                URLQueryItem(name: "state", value: "all"),
                URLQueryItem(name: "head", value: "\(owner):\(branch)"),
                URLQueryItem(name: "sort", value: "updated"),
                URLQueryItem(name: "direction", value: "desc"),
                URLQueryItem(name: "per_page", value: String(pageSize)),
                URLQueryItem(name: "page", value: String(page)),
            ]
            guard let encoded = query.percentEncodedQuery else { return nil }
            return "repos/\(owner)/\(repo)/pulls?\(encoded)"
        case .azureDevOps:
            var query = URLComponents()
            query.queryItems = [
                URLQueryItem(name: "searchCriteria.sourceRefName", value: "refs/heads/\(branch)"),
                URLQueryItem(name: "searchCriteria.status", value: "all"),
                URLQueryItem(name: "$top", value: String(pageSize)),
                URLQueryItem(name: "$skip", value: String(max(page - 1, 0) * pageSize)),
                URLQueryItem(name: "api-version", value: "7.1"),
            ]
            return query.percentEncodedQuery
        }
    }

    private static func request(
        session: URLSession,
        kind: RepositoryKind,
        endpoint: String,
        authHeader: String?
    ) async -> HTTPResponse? {
        guard let url = requestURL(kind: kind, endpoint: endpoint) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        switch kind {
        case .github:
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        case .azureDevOps:
            request.setValue("application/json", forHTTPHeaderField: "Accept")
        }
        request.setValue("termloop-workspace-pr-poller", forHTTPHeaderField: "User-Agent")
        if let authHeader, !authHeader.isEmpty {
            request.setValue(authHeader, forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            return HTTPResponse(statusCode: http.statusCode, data: data)
        } catch {
            return nil
        }
    }

    private static func requestURL(kind: RepositoryKind, endpoint: String) -> URL? {
        switch kind {
        case .github:
            return URL(string: "https://api.github.com/\(endpoint)")
        case .azureDevOps(let organization, let project, let repo):
            return URL(string: "https://dev.azure.com/\(path(organization))/\(path(project))/_apis/git/repositories/\(path(repo))/pullrequests?\(endpoint)")
        }
    }

    private static func probeItems(kind: RepositoryKind, data: Data) -> [GitHostPullRequestProbeItem]? {
        switch kind {
        case .github:
            return decode([GitHubPullRequestRESTItem].self, from: data)?.map(githubProbeItem)
        case .azureDevOps:
            return decode(AzurePullRequestListResponse.self, from: data)?.value.compactMap { azureProbeItem($0, kind: kind) }
        }
    }

    private static func githubProbeItem(_ item: GitHubPullRequestRESTItem) -> GitHostPullRequestProbeItem {
        let rawState = item.mergedAt?.isEmpty == false ? "MERGED" : item.state
        let statusDetail: String = {
            if item.draft == true, item.state.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "open" {
                return "draft"
            }
            if item.mergedAt?.isEmpty == false { return "merged" }
            return item.state
        }()
        return GitHostPullRequestProbeItem(
            number: item.number,
            state: rawState,
            statusDetail: statusDetail,
            url: item.htmlURL,
            updatedAt: item.updatedAt,
            headRefName: item.head.ref,
            baseRefName: item.base.ref
        )
    }

    private static func azureProbeItem(_ item: AzurePullRequestRESTItem, kind: RepositoryKind) -> GitHostPullRequestProbeItem? {
        guard case .azureDevOps(let organization, let project, let repo) = kind else { return nil }
        let rawStatusDetail = item.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let statusDetail = item.isDraft == true && rawStatusDetail == "active" ? "draft" : rawStatusDetail
        let state: String = {
            switch rawStatusDetail {
            case "active": return "OPEN"
            case "completed": return "MERGED"
            case "abandoned": return "CLOSED"
            default: return item.status
            }
        }()
        let url = "https://dev.azure.com/\(organization)/\(project)/_git/\(repo)/pullrequest/\(item.pullRequestId)"
        return GitHostPullRequestProbeItem(
            number: item.pullRequestId,
            state: state,
            statusDetail: statusDetail.isEmpty ? state : statusDetail,
            url: url,
            updatedAt: item.closedDate ?? item.creationDate,
            headRefName: shortRef(item.sourceRefName),
            baseRefName: shortRef(item.targetRefName)
        )
    }

    private static func shortRef(_ value: String?) -> String? {
        let prefix = "refs/heads/"
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value.hasPrefix(prefix) ? String(value.dropFirst(prefix.count)) : value
    }

    private static func path(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) -> T? {
        try? JSONDecoder().decode(type, from: data)
    }

#if DEBUG
    static func decodedProbeItemsForTests(repoSlug: String, data: Data) -> [GitHostPullRequestProbeItem]? {
        guard let kind = repositoryKind(repoSlug: repoSlug) else { return nil }
        return probeItems(kind: kind, data: data)
    }

    static func branchEndpointForTests(repoSlug: String, branch: String, page: Int, pageSize: Int) -> String? {
        guard let kind = repositoryKind(repoSlug: repoSlug) else { return nil }
        return branchEndpoint(kind: kind, branch: branch, page: page, pageSize: pageSize)
    }
#endif
}

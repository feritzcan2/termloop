// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

enum GitHostPullRequestProviderFactory {
    static func provider(for identity: GitRemoteIdentity) -> (any GitHostProvider)? {
        switch identity.host {
        case .github, .githubEnterprise:
            return GitHubHostProvider(identity: identity)
        case .azureDevOps:
            return AzureDevOpsHostProvider(identity: identity)
        case .gitLab:
            return GitLabHostProvider(identity: identity)
        case .unknown:
            return nil
        }
    }
}

struct GitHubHostProvider: GitHostProvider {
    let identity: GitRemoteIdentity
#if DEBUG
    private static let logger = Logger(subsystem: "com.termloop.git", category: "host-provider")
#endif

    private struct PullRequestResponse: Decodable {
        struct Ref: Decodable { let ref: String }
        let number: Int
        let title: String?
        let htmlURL: String
        let state: String
        let mergedAt: String?
        let draft: Bool?
        let updatedAt: String?
        let head: Ref
        let base: Ref

        enum CodingKeys: String, CodingKey {
            case number, title, state, draft, head, base
            case htmlURL = "html_url"
            case mergedAt = "merged_at"
            case updatedAt = "updated_at"
        }
    }

    func pullRequestURL(number: Int) -> URL? {
        guard let github = identity.github else { return nil }
        return URL(string: "https://\(github.host)/\(github.owner)/\(github.repo)/pull/\(number)")
    }

    func listPullRequests(branch: String) async throws -> [HostPullRequest] {
        guard let github = identity.github else { throw GitHostProviderError.unsupportedHost }
        var components = URLComponents(string: "https://api.github.com/repos/\(github.owner)/\(github.repo)/pulls")
        components?.queryItems = [
            URLQueryItem(name: "state", value: "all"),
            URLQueryItem(name: "head", value: "\(github.owner):\(branch)"),
            URLQueryItem(name: "sort", value: "updated"),
            URLQueryItem(name: "direction", value: "desc"),
            URLQueryItem(name: "per_page", value: "100"),
        ]
        guard let url = components?.url else { throw GitHostProviderError.invalidURL }
        let data = try await request(url: url, method: "GET", body: nil)
        let items = try JSONDecoder().decode([PullRequestResponse].self, from: data).map(hostPullRequest)
#if DEBUG
        Self.logger.debug("provider.github.list repo=\(identity.displaySlug, privacy: .public) branch=\(branch, privacy: .public) items=\(items.count)")
#endif
        return items
    }

    func createPullRequest(_ input: CreatePullRequestInput) async throws -> HostPullRequest {
        guard let github = identity.github else { throw GitHostProviderError.unsupportedHost }
        guard let url = URL(string: "https://api.github.com/repos/\(github.owner)/\(github.repo)/pulls") else {
            throw GitHostProviderError.invalidURL
        }
        let body: [String: Any] = [
            "title": input.title,
            "body": input.description,
            "head": input.sourceBranch,
            "base": input.targetBranch,
            "draft": input.draft,
        ]
        let data = try await request(url: url, method: "POST", body: body)
        let item = hostPullRequest(try JSONDecoder().decode(PullRequestResponse.self, from: data))
#if DEBUG
        Self.logger.debug("provider.github.create repo=\(identity.displaySlug, privacy: .public) number=\(item.number) state=\(String(describing: item.state), privacy: .public)")
#endif
        return item
    }

    private func request(url: URL, method: String, body: [String: Any]?) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("termloop", forHTTPHeaderField: "User-Agent")
        if let auth = GitHostAuthResolver.authorization(for: identity) {
            auth.apply(to: &request)
#if DEBUG
            Self.logger.debug("provider.github.auth repo=\(identity.displaySlug, privacy: .public) source=\(auth.source.rawValue, privacy: .public)")
#endif
        }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
#if DEBUG
            Self.logger.debug("provider.github.http.noResponse repo=\(identity.displaySlug, privacy: .public) method=\(method, privacy: .public)")
#endif
            throw GitHostProviderError.requestFailed(statusCode: nil, body: nil)
        }
        guard (200..<300).contains(http.statusCode) else {
#if DEBUG
            Self.logger.debug("provider.github.http.failed repo=\(identity.displaySlug, privacy: .public) method=\(method, privacy: .public) status=\(http.statusCode) body=\(Self.errorBody(data) ?? "", privacy: .public)")
#endif
            throw GitHostProviderError.requestFailed(statusCode: http.statusCode, body: Self.errorBody(data))
        }
#if DEBUG
        Self.logger.debug("provider.github.http.ok repo=\(identity.displaySlug, privacy: .public) method=\(method, privacy: .public) status=\(http.statusCode) bytes=\(data.count)")
#endif
        return data
    }

    private func hostPullRequest(_ item: PullRequestResponse) -> HostPullRequest {
        HostPullRequest(
            id: "github:\(identity.displaySlug):\(item.number)",
            number: item.number,
            title: item.title ?? "PR #\(item.number)",
            url: URL(string: item.htmlURL) ?? pullRequestURL(number: item.number) ?? identity.webURL ?? URL(string: "https://github.com")!,
            sourceBranch: item.head.ref,
            targetBranch: item.base.ref,
            state: Self.state(raw: item.state, mergedAt: item.mergedAt, draft: item.draft),
            updatedAt: item.updatedAt.flatMap(Self.date)
        )
    }

    private static func state(raw: String, mergedAt: String?, draft: Bool?) -> HostPullRequest.State {
        if draft == true { return .draft }
        if mergedAt?.isEmpty == false { return .merged }
        switch raw.lowercased() {
        case "open": return .open
        case "closed": return .closed
        default: return .unknown
        }
    }

    private static func date(_ raw: String) -> Date? {
        ISO8601DateFormatter().date(from: raw)
    }

    private static func errorBody(_ data: Data) -> String? {
        String(data: data.prefix(1_000), encoding: .utf8)
    }
}

struct AzureDevOpsHostProvider: GitHostProvider {
    let identity: GitRemoteIdentity
#if DEBUG
    private static let logger = Logger(subsystem: "com.termloop.git", category: "host-provider")
#endif

    private struct ListResponse: Decodable { let value: [PullRequestResponse] }
    private struct PullRequestResponse: Decodable {
        let pullRequestId: Int
        let status: String
        let title: String?
        let sourceRefName: String?
        let targetRefName: String?
        let creationDate: String?
        let closedDate: String?
    }

    func pullRequestURL(number: Int) -> URL? {
        guard let azure = identity.azureDevOps else { return nil }
        return URL(string: "https://dev.azure.com/\(azure.organization)/\(azure.project)/_git/\(azure.repo)/pullrequest/\(number)")
    }

    func listPullRequests(branch: String) async throws -> [HostPullRequest] {
        guard let azure = identity.azureDevOps else { throw GitHostProviderError.unsupportedHost }
        var collected: [HostPullRequest] = []
        let pageSize = 100
        for page in 0..<4 {
            var components = URLComponents(string: baseAPIURL(azure: azure))
            components?.queryItems = [
                URLQueryItem(name: "searchCriteria.sourceRefName", value: "refs/heads/\(branch)"),
                URLQueryItem(name: "searchCriteria.status", value: "all"),
                URLQueryItem(name: "$top", value: String(pageSize)),
                URLQueryItem(name: "$skip", value: String(page * pageSize)),
                URLQueryItem(name: "api-version", value: "7.1"),
            ]
            guard let url = components?.url else { throw GitHostProviderError.invalidURL }
            let data = try await request(url: url, method: "GET", body: nil)
            let items = try JSONDecoder().decode(ListResponse.self, from: data).value.map(hostPullRequest)
#if DEBUG
            Self.logger.debug("provider.azure.list.page repo=\(identity.displaySlug, privacy: .public) branch=\(branch, privacy: .public) page=\(page) items=\(items.count)")
#endif
            collected.append(contentsOf: items)
            if items.count < pageSize { break }
        }
#if DEBUG
        Self.logger.debug("provider.azure.list.done repo=\(identity.displaySlug, privacy: .public) branch=\(branch, privacy: .public) total=\(collected.count)")
#endif
        return collected
    }

    func createPullRequest(_ input: CreatePullRequestInput) async throws -> HostPullRequest {
        guard let azure = identity.azureDevOps else { throw GitHostProviderError.unsupportedHost }
        var components = URLComponents(string: baseAPIURL(azure: azure))
        components?.queryItems = [URLQueryItem(name: "api-version", value: "7.1")]
        guard let url = components?.url else { throw GitHostProviderError.invalidURL }
        let body: [String: Any] = [
            "sourceRefName": "refs/heads/\(input.sourceBranch)",
            "targetRefName": "refs/heads/\(input.targetBranch)",
            "title": input.title,
            "description": input.description,
            "isDraft": input.draft,
        ]
        let data = try await request(url: url, method: "POST", body: body)
        let item = hostPullRequest(try JSONDecoder().decode(PullRequestResponse.self, from: data))
#if DEBUG
        Self.logger.debug("provider.azure.create repo=\(identity.displaySlug, privacy: .public) number=\(item.number) state=\(String(describing: item.state), privacy: .public)")
#endif
        return item
    }

    private func baseAPIURL(azure: AzureDevOpsIdentity) -> String {
        "https://dev.azure.com/\(Self.path(azure.organization))/\(Self.path(azure.project))/_apis/git/repositories/\(Self.path(azure.repo))/pullrequests"
    }

    private func request(url: URL, method: String, body: [String: Any]?) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("termloop", forHTTPHeaderField: "User-Agent")
        guard let auth = GitHostAuthResolver.authorization(for: identity) else {
#if DEBUG
            Self.logger.debug("provider.azure.auth.missing repo=\(identity.displaySlug, privacy: .public)")
#endif
            throw GitHostProviderError.unauthenticated
        }
        auth.apply(to: &request)
#if DEBUG
        Self.logger.debug("provider.azure.auth repo=\(identity.displaySlug, privacy: .public) source=\(auth.source.rawValue, privacy: .public)")
#endif
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
#if DEBUG
            Self.logger.debug("provider.azure.http.noResponse repo=\(identity.displaySlug, privacy: .public) method=\(method, privacy: .public)")
#endif
            throw GitHostProviderError.requestFailed(statusCode: nil, body: nil)
        }
        guard (200..<300).contains(http.statusCode) else {
#if DEBUG
            Self.logger.debug("provider.azure.http.failed repo=\(identity.displaySlug, privacy: .public) method=\(method, privacy: .public) status=\(http.statusCode) body=\(Self.errorBody(data) ?? "", privacy: .public)")
#endif
            throw GitHostProviderError.requestFailed(statusCode: http.statusCode, body: Self.errorBody(data))
        }
#if DEBUG
        Self.logger.debug("provider.azure.http.ok repo=\(identity.displaySlug, privacy: .public) method=\(method, privacy: .public) status=\(http.statusCode) bytes=\(data.count)")
#endif
        return data
    }

    private func hostPullRequest(_ item: PullRequestResponse) -> HostPullRequest {
        let number = item.pullRequestId
        return HostPullRequest(
            id: "azureDevOps:\(identity.displaySlug):\(number)",
            number: number,
            title: item.title ?? "PR #\(number)",
            url: pullRequestURL(number: number) ?? identity.webURL ?? URL(string: "https://dev.azure.com")!,
            sourceBranch: Self.shortRef(item.sourceRefName) ?? "",
            targetBranch: Self.shortRef(item.targetRefName),
            state: Self.state(raw: item.status),
            updatedAt: (item.closedDate ?? item.creationDate).flatMap(Self.date)
        )
    }

    private static func state(raw: String) -> HostPullRequest.State {
        switch raw.lowercased() {
        case "active": return .open
        case "completed": return .merged
        case "abandoned": return .closed
        default: return .unknown
        }
    }

    private static func shortRef(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        let prefix = "refs/heads/"
        return value.hasPrefix(prefix) ? String(value.dropFirst(prefix.count)) : value
    }

    private static func path(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static func date(_ raw: String) -> Date? {
        ISO8601DateFormatter().date(from: raw)
    }

    private static func errorBody(_ data: Data) -> String? {
        String(data: data.prefix(1_000), encoding: .utf8)
    }
}

enum GitHostProviderError: Error {
    case invalidURL
    case requestFailed(statusCode: Int?, body: String?)
    case unsupportedHost
    case unauthenticated
}

struct GitLabHostProvider: GitHostProvider {
    let identity: GitRemoteIdentity
    /// Session used for outbound API calls. Defaults to `URLSession.shared`
    /// for ad-hoc usage; the worktree PR poll path passes its bounded
    /// ephemeral session so GitLab matches the same 8s timeout the legacy
    /// GitHub/Azure probe uses.
    let session: URLSession

    init(identity: GitRemoteIdentity, session: URLSession = .shared) {
        self.identity = identity
        self.session = session
    }
#if DEBUG
    private static let logger = Logger(subsystem: "com.termloop.git", category: "host-provider")
#endif

    private static let iso8601: ISO8601DateFormatter = ISO8601DateFormatter()

    private struct MergeRequestResponse: Decodable {
        let iid: Int
        let title: String?
        let webURL: String?
        let sourceBranch: String?
        let targetBranch: String?
        let state: String
        let draft: Bool?
        let workInProgress: Bool?
        let updatedAt: String?
        let mergedAt: String?
        let closedAt: String?

        enum CodingKeys: String, CodingKey {
            case iid, title, state, draft
            case webURL = "web_url"
            case sourceBranch = "source_branch"
            case targetBranch = "target_branch"
            case workInProgress = "work_in_progress"
            case updatedAt = "updated_at"
            case mergedAt = "merged_at"
            case closedAt = "closed_at"
        }
    }

    func pullRequestURL(number: Int) -> URL? {
        guard let gitLab = identity.gitLab else { return nil }
        return URL(string: "https://\(gitLab.host)/\(gitLab.fullPath)/-/merge_requests/\(number)")
    }

    func listPullRequests(branch: String) async throws -> [HostPullRequest] {
        guard let gitLab = identity.gitLab else { throw GitHostProviderError.unsupportedHost }
        var components = URLComponents(string: "https://\(gitLab.host)/api/v4/projects/\(Self.encodedProjectPath(gitLab.fullPath))/merge_requests")
        components?.queryItems = [
            URLQueryItem(name: "state", value: "all"),
            URLQueryItem(name: "source_branch", value: branch),
            URLQueryItem(name: "order_by", value: "updated_at"),
            URLQueryItem(name: "sort", value: "desc"),
            URLQueryItem(name: "per_page", value: "100"),
        ]
        guard let url = components?.url else { throw GitHostProviderError.invalidURL }
        let data = try await request(url: url, method: "GET", body: nil)
        let items = try JSONDecoder().decode([MergeRequestResponse].self, from: data).map(hostPullRequest)
#if DEBUG
        Self.logger.debug("provider.gitlab.list repo=\(identity.displaySlug, privacy: .public) branch=\(branch, privacy: .public) items=\(items.count)")
#endif
        return items
    }

    func createPullRequest(_ input: CreatePullRequestInput) async throws -> HostPullRequest {
        guard let gitLab = identity.gitLab else { throw GitHostProviderError.unsupportedHost }
        guard let url = URL(string: "https://\(gitLab.host)/api/v4/projects/\(Self.encodedProjectPath(gitLab.fullPath))/merge_requests") else {
            throw GitHostProviderError.invalidURL
        }
        let title = input.draft ? "Draft: \(input.title)" : input.title
        let body: [String: Any] = [
            "source_branch": input.sourceBranch,
            "target_branch": input.targetBranch,
            "title": title,
            "description": input.description,
        ]
        let data = try await request(url: url, method: "POST", body: body)
        let item = hostPullRequest(try JSONDecoder().decode(MergeRequestResponse.self, from: data))
#if DEBUG
        Self.logger.debug("provider.gitlab.create repo=\(identity.displaySlug, privacy: .public) number=\(item.number) state=\(String(describing: item.state), privacy: .public)")
#endif
        return item
    }

    private func request(url: URL, method: String, body: [String: Any]?) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("termloop", forHTTPHeaderField: "User-Agent")
        guard let auth = GitHostAuthResolver.authorization(for: identity) else {
#if DEBUG
            Self.logger.debug("provider.gitlab.auth.missing repo=\(identity.displaySlug, privacy: .public)")
#endif
            throw GitHostProviderError.unauthenticated
        }
        auth.apply(to: &request)
#if DEBUG
        Self.logger.debug("provider.gitlab.auth repo=\(identity.displaySlug, privacy: .public) source=\(auth.source.rawValue, privacy: .public)")
#endif
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
#if DEBUG
            Self.logger.debug("provider.gitlab.http.noResponse repo=\(identity.displaySlug, privacy: .public) method=\(method, privacy: .public)")
#endif
            throw GitHostProviderError.requestFailed(statusCode: nil, body: nil)
        }
        guard (200..<300).contains(http.statusCode) else {
#if DEBUG
            Self.logger.debug("provider.gitlab.http.failed repo=\(identity.displaySlug, privacy: .public) method=\(method, privacy: .public) status=\(http.statusCode) body=\(Self.errorBody(data) ?? "", privacy: .public)")
#endif
            throw GitHostProviderError.requestFailed(statusCode: http.statusCode, body: Self.errorBody(data))
        }
#if DEBUG
        Self.logger.debug("provider.gitlab.http.ok repo=\(identity.displaySlug, privacy: .public) method=\(method, privacy: .public) status=\(http.statusCode) bytes=\(data.count)")
#endif
        return data
    }

    private func hostPullRequest(_ item: MergeRequestResponse) -> HostPullRequest {
        let title = item.title ?? "MR !\(item.iid)"
        let url = URL(string: item.webURL ?? "")
            ?? pullRequestURL(number: item.iid)
            ?? identity.webURL
            ?? URL(string: "https://gitlab.com")!
        return HostPullRequest(
            id: "gitlab:\(identity.displaySlug):\(item.iid)",
            number: item.iid,
            title: title,
            url: url,
            sourceBranch: item.sourceBranch ?? "",
            targetBranch: item.targetBranch ?? "",
            state: Self.state(item: item),
            updatedAt: item.updatedAt.flatMap(Self.date)
        )
    }

    private static func state(item: MergeRequestResponse) -> HostPullRequest.State {
        if item.draft == true || item.workInProgress == true { return .draft }
        switch item.state.lowercased() {
        case "opened": return .open
        case "merged": return .merged
        case "closed": return .closed
        case "locked": return .closed
        default: return .unknown
        }
    }

    private static func encodedProjectPath(_ fullPath: String) -> String {
        // GitLab API requires URL-encoded `/` in the project path.
        fullPath.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? fullPath
    }

    private static func date(_ raw: String) -> Date? {
        iso8601.date(from: raw)
    }

    private static func errorBody(_ data: Data) -> String? {
        String(data: data.prefix(1_000), encoding: .utf8)
    }
}

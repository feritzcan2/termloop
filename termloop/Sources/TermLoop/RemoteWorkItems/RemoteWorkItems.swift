// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

// MARK: - Remote Work Item domain

public enum RemoteWorkItemProviderId: String, Codable, CaseIterable, Hashable, Sendable {
    case jira
    case github
    case gitlab

    var displayLabel: String {
        switch self {
        case .jira: return "Jira"
        case .github: return "GitHub"
        case .gitlab: return "GitLab"
        }
    }
}

public struct RemoteWorkItemReference: Codable, Hashable, Sendable {
    public var provider: RemoteWorkItemProviderId
    public var key: String
    public var url: String?
    public var host: String?
    public var namespace: String?
    public var repository: String?
    public var number: Int?

    public init(
        provider: RemoteWorkItemProviderId,
        key: String,
        url: String?,
        host: String?,
        namespace: String?,
        repository: String?,
        number: Int?
    ) {
        self.provider = provider
        self.key = key
        self.url = url
        self.host = host
        self.namespace = namespace
        self.repository = repository
        self.number = number
    }

    var stableId: String {
        switch provider {
        case .jira:
            return key.uppercased()
        case .github, .gitlab:
            if let namespace, let repository, let number {
                return "\(namespace.lowercased())/\(repository.lowercased())#\(number)"
            }
            return key.lowercased()
        }
    }

    var storageKey: String {
        [provider.rawValue, host?.lowercased() ?? "", stableId].joined(separator: ":")
    }

    func representsSameRemoteItem(as other: RemoteWorkItemReference) -> Bool {
        guard provider == other.provider else { return false }
        switch provider {
        case .jira:
            guard stableId == other.stableId else { return false }
            let lhsHost = Self.normalizedHost(host)
            let rhsHost = Self.normalizedHost(other.host)
            return lhsHost == nil || rhsHost == nil || lhsHost == rhsHost
        case .github, .gitlab:
            return storageKey == other.storageKey
        }
    }

    private static func normalizedHost(_ value: String?) -> String? {
        var host = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let url = URL(string: host), let parsed = url.host {
            host = parsed
        }
        host = host
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .lowercased()
        return host.isEmpty ? nil : host
    }
}

struct RemoteWorkItemSnapshot: Codable, Equatable, Sendable {
    var reference: RemoteWorkItemReference
    var title: String
    var bodyMarkdown: String?
    var statusLabel: String?
    var assignees: [String]
    var labels: [String]
    var providerUpdatedAt: Date?
    var fetchedAt: Date
}

struct RemoteWorkItemCreateRequest: Codable, Equatable, Sendable {
    var provider: RemoteWorkItemProviderId
    var title: String
    var bodyMarkdown: String?
    /// GitHub/GitLab: owner/repo or group/project. Jira: project key.
    var container: String
    var issueType: String?
    var labels: [String]
    var assignToMe: Bool

    init(
        provider: RemoteWorkItemProviderId,
        title: String,
        bodyMarkdown: String? = nil,
        container: String,
        issueType: String? = nil,
        labels: [String] = [],
        assignToMe: Bool = false
    ) {
        self.provider = provider
        self.title = title
        self.bodyMarkdown = bodyMarkdown
        self.container = container
        self.issueType = issueType
        self.labels = labels
        self.assignToMe = assignToMe
    }
}

struct RemoteWorkItemListRequest: Codable, Equatable, Sendable {
    var provider: RemoteWorkItemProviderId
    /// GitHub/GitLab: owner/repo or group/project. Jira: optional project key.
    var container: String?
    var limit: Int
    /// Provider server-side lower bound for incremental assigned sync when supported.
    var updatedSince: Date?
    /// Fetch the complete result set when the provider CLI supports pagination.
    var paginate: Bool

    init(
        provider: RemoteWorkItemProviderId,
        container: String? = nil,
        limit: Int = 50,
        updatedSince: Date? = nil,
        paginate: Bool = false
    ) {
        self.provider = provider
        self.container = container
        self.limit = max(1, min(limit, 500))
        self.updatedSince = updatedSince
        self.paginate = paginate
    }
}

public struct TaskRemoteJiraAccountOption: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let site: String
    public let email: String?
    public let displayName: String?
    public let isCurrent: Bool

    public init(site: String, email: String?, displayName: String?, isCurrent: Bool) {
        let normalizedSite = Self.normalizedSite(site) ?? site.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedEmail = email?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.site = normalizedSite
        self.email = normalizedEmail
        self.displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.isCurrent = isCurrent
        self.id = [normalizedSite, normalizedEmail ?? ""].joined(separator: "|")
    }

    public var displayLabel: String {
        let emailPart = email.map { " · \($0)" } ?? ""
        let currentPart = isCurrent ? " ✓" : ""
        return "\(site)\(emailPart)\(currentPart)"
    }

    private static func normalizedSite(_ value: String) -> String? {
        var site = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: site), let host = url.host {
            site = host
        }
        site = site
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return site.nilIfEmpty
    }
}

public struct TaskRemoteContainerOption: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let key: String
    public let name: String

    public init(key: String, name: String) {
        self.id = key
        self.key = key
        self.name = name
    }

    public var displayLabel: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? key : "\(key) — \(name)"
    }
}

public struct TaskRemoteIssueTypeOption: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let isSubtask: Bool

    public init(id: String, name: String, description: String?, isSubtask: Bool) {
        self.id = id
        self.name = name
        self.description = description?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.isSubtask = isSubtask
    }
}

struct RemoteWorkItemStatusOption: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var label: String
    var targetState: String?
    var providerPayload: [String: String]
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

protocol RemoteWorkItemProvider: Sendable {
    var providerId: RemoteWorkItemProviderId { get }

    func fetch(_ reference: RemoteWorkItemReference) async throws -> RemoteWorkItemSnapshot
    func create(_ request: RemoteWorkItemCreateRequest) async throws -> RemoteWorkItemSnapshot
    func listAssignedToMe(_ request: RemoteWorkItemListRequest) async throws -> [RemoteWorkItemSnapshot]
    func availableStatuses(_ reference: RemoteWorkItemReference) async throws -> [RemoteWorkItemStatusOption]
    func updateStatus(_ reference: RemoteWorkItemReference, to status: RemoteWorkItemStatusOption) async throws -> RemoteWorkItemSnapshot
}

enum RemoteWorkItemError: LocalizedError, Equatable, Sendable {
    case unsupportedProvider(RemoteWorkItemProviderId)
    case unsupportedReference(String)
    case commandFailed(String)
    case parseFailed(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedProvider(let provider):
            return "Unsupported remote work item provider: \(provider.displayLabel)"
        case .unsupportedReference(let message),
             .commandFailed(let message),
             .parseFailed(let message):
            let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "Unknown remote work item error." : trimmed
        }
    }
}

// MARK: - Parser

enum RemoteWorkItemParser {
    private static let jiraKeyRegex = try? NSRegularExpression(pattern: #"\b[A-Z][A-Z0-9_]*-\d+\b"#)

    static func parse(_ raw: String) -> RemoteWorkItemReference? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            return parse(url: url)
        }
        if let key = extractJiraKey(from: trimmed) {
            return RemoteWorkItemReference(provider: .jira, key: key, url: nil, host: nil, namespace: nil, repository: nil, number: nil)
        }
        if let hash = trimmed.lastIndex(of: "#"), let number = Int(trimmed[trimmed.index(after: hash)...]) {
            let repoPart = String(trimmed[..<hash])
            let pieces = repoPart.split(separator: "/").map(String.init)
            if pieces.count >= 2 {
                let repo = pieces.last ?? ""
                let namespace = pieces.dropLast().joined(separator: "/")
                return RemoteWorkItemReference(provider: .github, key: "\(namespace)/\(repo)#\(number)", url: nil, host: "github.com", namespace: namespace, repository: repo, number: number)
            }
        }
        return nil
    }

    private static func parse(url: URL) -> RemoteWorkItemReference? {
        guard let host = url.host?.lowercased() else { return nil }
        let path = url.path.split(separator: "/").map(String.init)
        if host == "github.com", path.count >= 4, path[2] == "issues", let number = Int(path[3]) {
            return RemoteWorkItemReference(provider: .github, key: "\(path[0])/\(path[1])#\(number)", url: url.absoluteString, host: host, namespace: path[0], repository: path[1], number: number)
        }
        if let dash = path.firstIndex(of: "-"), dash + 2 < path.count, path[dash + 1] == "issues", let number = Int(path[dash + 2]), dash >= 1 {
            let projectParts = Array(path[..<dash])
            let repo = projectParts.last ?? ""
            let namespace = projectParts.dropLast().joined(separator: "/")
            guard !namespace.isEmpty, !repo.isEmpty else { return nil }
            return RemoteWorkItemReference(provider: .gitlab, key: "\(namespace)/\(repo)#\(number)", url: url.absoluteString, host: host, namespace: namespace, repository: repo, number: number)
        }
        if host.contains("atlassian.net"), let key = extractJiraKey(from: url.absoluteString) {
            return RemoteWorkItemReference(provider: .jira, key: key, url: url.absoluteString, host: host, namespace: nil, repository: nil, number: nil)
        }
        return nil
    }

    static func extractJiraKey(from input: String) -> String? {
        guard let regex = jiraKeyRegex else { return nil }
        let upper = input.uppercased()
        let range = NSRange(upper.startIndex..<upper.endIndex, in: upper)
        guard let match = regex.firstMatch(in: upper, range: range), let swiftRange = Range(match.range, in: upper) else { return nil }
        return String(upper[swiftRange])
    }
}

// MARK: - Manual action service

actor RemoteWorkItemService {
    private let providers: [RemoteWorkItemProviderId: any RemoteWorkItemProvider]
    private let taskFileWriter: RemoteWorkItemTaskFileWriting

    init(providers: [any RemoteWorkItemProvider], taskFileWriter: RemoteWorkItemTaskFileWriting = RemoteWorkItemTaskFileWriter()) {
        self.providers = Dictionary(uniqueKeysWithValues: providers.map { ($0.providerId, $0) })
        self.taskFileWriter = taskFileWriter
    }

    func link(input: String, projectRoot: URL?) async throws -> RemoteWorkItemSnapshot {
        guard let reference = RemoteWorkItemParser.parse(input) else {
            throw RemoteWorkItemError.unsupportedReference(input)
        }
        let snapshot = try await fetch(reference)
        if let projectRoot {
            _ = try await materializeTaskFile(snapshot, projectRoot: projectRoot)
        }
        return snapshot
    }

    func fetch(_ reference: RemoteWorkItemReference) async throws -> RemoteWorkItemSnapshot {
        try await provider(for: reference.provider).fetch(reference)
    }

    func create(_ request: RemoteWorkItemCreateRequest, projectRoot: URL?) async throws -> RemoteWorkItemSnapshot {
        let snapshot = try await provider(for: request.provider).create(request)
        if let projectRoot {
            _ = try await materializeTaskFile(snapshot, projectRoot: projectRoot)
        }
        return snapshot
    }

    func listAssignedToMe(_ request: RemoteWorkItemListRequest) async throws -> [RemoteWorkItemSnapshot] {
        try await provider(for: request.provider).listAssignedToMe(request)
    }

    func availableStatuses(_ reference: RemoteWorkItemReference) async throws -> [RemoteWorkItemStatusOption] {
        try await provider(for: reference.provider).availableStatuses(reference)
    }

    func updateStatus(_ reference: RemoteWorkItemReference, to status: RemoteWorkItemStatusOption, projectRoot: URL?) async throws -> RemoteWorkItemSnapshot {
        let snapshot = try await provider(for: reference.provider).updateStatus(reference, to: status)
        if let projectRoot {
            _ = try await materializeTaskFile(snapshot, projectRoot: projectRoot)
        }
        return snapshot
    }

    func materializeTaskFile(_ snapshot: RemoteWorkItemSnapshot, projectRoot: URL) async throws -> URL {
        try await taskFileWriter.write(snapshot: snapshot, projectRoot: projectRoot)
    }

    private func provider(for id: RemoteWorkItemProviderId) throws -> any RemoteWorkItemProvider {
        guard let provider = providers[id] else { throw RemoteWorkItemError.unsupportedProvider(id) }
        return provider
    }
}

// MARK: - task.md materialization

protocol RemoteWorkItemTaskFileWriting: Sendable {
    func write(snapshot: RemoteWorkItemSnapshot, projectRoot: URL) async throws -> URL
}

struct RemoteWorkItemTaskFileWriter: RemoteWorkItemTaskFileWriting {
    func write(snapshot: RemoteWorkItemSnapshot, projectRoot: URL) async throws -> URL {
        let dir = projectRoot
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("remote-work-items", isDirectory: true)
            .appendingPathComponent(Self.safeDirectoryName(for: snapshot.reference), isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("task.md", isDirectory: false)
        try markdown(for: snapshot).write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func markdown(for snapshot: RemoteWorkItemSnapshot) -> String {
        var lines: [String] = []
        lines.append("# \(snapshot.reference.key) — \(snapshot.title)")
        lines.append("")
        lines.append("- Provider: \(snapshot.reference.provider.rawValue)")
        if let status = snapshot.statusLabel { lines.append("- Status: \(status)") }
        if let url = snapshot.reference.url { lines.append("- URL: \(url)") }
        if !snapshot.assignees.isEmpty { lines.append("- Assignees: \(snapshot.assignees.joined(separator: ", "))") }
        if !snapshot.labels.isEmpty { lines.append("- Labels: \(snapshot.labels.joined(separator: ", "))") }
        lines.append("- Fetched: \(ISO8601DateFormatter().string(from: snapshot.fetchedAt))")
        lines.append("")
        lines.append("## Description")
        lines.append("")
        lines.append(snapshot.bodyMarkdown?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? snapshot.bodyMarkdown! : "_No description._")
        lines.append("")
        return lines.joined(separator: "\n")
    }

    static func safeDirectoryName(for reference: RemoteWorkItemReference) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in reference.storageKey.utf8 {
            hash ^= UInt64(byte)
            hash &*= 0x100000001b3
        }
        return "\(reference.provider.rawValue)-\(String(format: "%016llx", hash))"
    }
}

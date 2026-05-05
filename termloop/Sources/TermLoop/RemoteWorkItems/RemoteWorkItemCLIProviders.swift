// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

// MARK: - Command runner

struct RemoteWorkItemCommandResult: Sendable {
    var exitStatus: Int32
    var stdout: String
    var stderr: String
    var timedOut: Bool
}

protocol RemoteWorkItemCommandRunning: Sendable {
    func run(
        executable: String,
        arguments: [String],
        cwd: String?,
        timeout: TimeInterval
    ) async throws -> RemoteWorkItemCommandResult
}

actor RemoteWorkItemCommandRunner: RemoteWorkItemCommandRunning {
    static let shared = RemoteWorkItemCommandRunner()

    func run(
        executable: String,
        arguments: [String],
        cwd: String? = nil,
        timeout: TimeInterval = 20
    ) async throws -> RemoteWorkItemCommandResult {
        try Task.checkCancellation()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [executable] + arguments
        if let cwd, !cwd.isEmpty {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        }
        process.environment = sanitizedEnvironment(ProcessInfo.processInfo.environment)

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let completion = RemoteWorkItemCommandCompletion()
                let finish: @Sendable (Result<RemoteWorkItemCommandResult, Error>) -> Void = { result in
                    guard completion.claim() else { return }
                    continuation.resume(with: result)
                }

                do {
                    try process.run()
                } catch {
                    finish(.failure(error))
                    return
                }

                let timeoutTask = DispatchWorkItem {
                    if process.isRunning { process.terminate() }
                    finish(.success(RemoteWorkItemCommandResult(
                        exitStatus: 124,
                        stdout: Self.readCapped(stdoutPipe.fileHandleForReading),
                        stderr: Self.readCapped(stderrPipe.fileHandleForReading),
                        timedOut: true
                    )))
                }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: timeoutTask)

                process.terminationHandler = { proc in
                    timeoutTask.cancel()
                    finish(.success(RemoteWorkItemCommandResult(
                        exitStatus: proc.terminationStatus,
                        stdout: Self.readCapped(stdoutPipe.fileHandleForReading),
                        stderr: Self.readCapped(stderrPipe.fileHandleForReading),
                        timedOut: false
                    )))
                }
            }
        } onCancel: {
            if process.isRunning { process.terminate() }
        }
    }

    private static func readCapped(_ handle: FileHandle, cap: Int = 512_000) -> String {
        let data = (try? handle.readToEnd()) ?? Data()
        let capped = data.count > cap ? data.prefix(cap) : data[...]
        return String(data: Data(capped), encoding: .utf8) ?? ""
    }

    private func sanitizedEnvironment(_ env: [String: String]) -> [String: String] {
        var result: [String: String] = [:]
        for key in ["PATH", "HOME", "LANG", "LC_ALL", "SHELL", "TERM"] {
            if let value = env[key] { result[key] = value }
        }
        return result
    }
}

private final class RemoteWorkItemCommandCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var didResume = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !didResume else { return false }
        didResume = true
        return true
    }
}

// MARK: - GitHub

struct GitHubRemoteWorkItemProvider: RemoteWorkItemProvider {
    let runner: any RemoteWorkItemCommandRunning
    var providerId: RemoteWorkItemProviderId { .github }

    init(runner: any RemoteWorkItemCommandRunning = RemoteWorkItemCommandRunner.shared) {
        self.runner = runner
    }

    func fetch(_ reference: RemoteWorkItemReference) async throws -> RemoteWorkItemSnapshot {
        let json = try await issueView(reference, fields: ["number", "title", "body", "state", "url", "updatedAt", "assignees", "labels"])
        return RemoteWorkItemSnapshot(
            reference: normalizedReference(reference, url: json["url"] as? String),
            title: json["title"] as? String ?? reference.key,
            bodyMarkdown: json["body"] as? String,
            statusLabel: (json["state"] as? String)?.lowercased(),
            assignees: remoteNames(from: json["assignees"]),
            labels: remoteNames(from: json["labels"]),
            providerUpdatedAt: remoteParseDate(json["updatedAt"] as? String),
            fetchedAt: Date()
        )
    }

    func create(_ request: RemoteWorkItemCreateRequest) async throws -> RemoteWorkItemSnapshot {
        var args = ["issue", "create", "--repo", request.container, "--title", request.title]
        if let body = request.bodyMarkdown, !body.isEmpty { args += ["--body", body] }
        if !request.labels.isEmpty { args += ["--label", request.labels.joined(separator: ",")] }
        let result = try await runner.run(executable: "gh", arguments: args, cwd: nil, timeout: 20)
        try remoteValidate(result)
        let output = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let ref = RemoteWorkItemParser.parse(output) ?? fallbackCreatedReference(provider: .github, container: request.container, stdout: output)
        return try await fetch(ref)
    }

    func listAssignedToMe(_ request: RemoteWorkItemListRequest) async throws -> [RemoteWorkItemSnapshot] {
        guard let container = request.container, !container.isEmpty else {
            throw RemoteWorkItemError.unsupportedReference("GitHub assigned list requires owner/repo")
        }
        let fields = ["number", "title", "body", "state", "url", "updatedAt", "assignees", "labels"]
        let result = try await runner.run(
            executable: "gh",
            arguments: [
                "issue", "list",
                "--repo", container,
                "--assignee", "@me",
                "--state", "all",
                "--limit", "\(request.limit)",
                "--json", fields.joined(separator: ",")
            ],
            cwd: nil,
            timeout: 20
        )
        try remoteValidate(result)
        let issues = try remoteParseJSONArray(result.stdout)
        return issues.map { githubSnapshot(container: container, json: $0) }
    }

    func availableStatuses(_ reference: RemoteWorkItemReference) async throws -> [RemoteWorkItemStatusOption] {
        let snapshot = try await fetch(reference)
        if snapshot.statusLabel == "closed" {
            return [RemoteWorkItemStatusOption(id: "github.reopen", label: "Reopen", targetState: "open", providerPayload: [:])]
        }
        return [RemoteWorkItemStatusOption(id: "github.close", label: "Close", targetState: "closed", providerPayload: [:])]
    }

    func updateStatus(_ reference: RemoteWorkItemReference, to status: RemoteWorkItemStatusOption) async throws -> RemoteWorkItemSnapshot {
        let subcommand = status.id.contains("reopen") || status.targetState == "open" ? "reopen" : "close"
        let result = try await runner.run(executable: "gh", arguments: ["issue", subcommand, issueNumber(reference), "--repo", repo(reference)], cwd: nil, timeout: 20)
        try remoteValidate(result)
        return try await fetch(reference)
    }

    private func issueView(_ reference: RemoteWorkItemReference, fields: [String]) async throws -> [String: Any] {
        let result = try await runner.run(executable: "gh", arguments: ["issue", "view", issueNumber(reference), "--repo", repo(reference), "--json", fields.joined(separator: ",")], cwd: nil, timeout: 20)
        try remoteValidate(result)
        return try remoteParseJSONObject(result.stdout)
    }

    private func githubSnapshot(container: String, json: [String: Any]) -> RemoteWorkItemSnapshot {
        let number = json["number"] as? Int
        let parts = container.split(separator: "/").map(String.init)
        let repository = parts.last
        let namespace = parts.dropLast().joined(separator: "/")
        let key = number.map { "\(container)#\($0)" } ?? container
        let reference = RemoteWorkItemReference(
            provider: .github,
            key: key,
            url: json["url"] as? String,
            host: "github.com",
            namespace: namespace.isEmpty ? nil : namespace,
            repository: repository,
            number: number
        )
        return RemoteWorkItemSnapshot(
            reference: reference,
            title: json["title"] as? String ?? key,
            bodyMarkdown: json["body"] as? String,
            statusLabel: (json["state"] as? String)?.lowercased(),
            assignees: remoteNames(from: json["assignees"]),
            labels: remoteNames(from: json["labels"]),
            providerUpdatedAt: remoteParseDate(json["updatedAt"] as? String),
            fetchedAt: Date()
        )
    }
}

// MARK: - GitLab

struct GitLabRemoteWorkItemProvider: RemoteWorkItemProvider {
    let runner: any RemoteWorkItemCommandRunning
    var providerId: RemoteWorkItemProviderId { .gitlab }

    init(runner: any RemoteWorkItemCommandRunning = RemoteWorkItemCommandRunner.shared) {
        self.runner = runner
    }

    func fetch(_ reference: RemoteWorkItemReference) async throws -> RemoteWorkItemSnapshot {
        let json = try await issueView(reference)
        let url = (json["web_url"] as? String) ?? (json["webUrl"] as? String)
        return RemoteWorkItemSnapshot(
            reference: normalizedReference(reference, url: url),
            title: json["title"] as? String ?? reference.key,
            bodyMarkdown: (json["description"] as? String) ?? (json["body"] as? String),
            statusLabel: (json["state"] as? String)?.lowercased(),
            assignees: remoteNames(from: json["assignees"]),
            labels: remoteStringArray(json["labels"]),
            providerUpdatedAt: remoteParseDate((json["updated_at"] as? String) ?? (json["updatedAt"] as? String)),
            fetchedAt: Date()
        )
    }

    func create(_ request: RemoteWorkItemCreateRequest) async throws -> RemoteWorkItemSnapshot {
        var args = ["issue", "create", "--repo", request.container, "--title", request.title]
        if let body = request.bodyMarkdown, !body.isEmpty { args += ["--description", body] }
        if !request.labels.isEmpty { args += ["--label", request.labels.joined(separator: ",")] }
        let result = try await runner.run(executable: "glab", arguments: args, cwd: nil, timeout: 20)
        try remoteValidate(result)
        let output = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let ref = RemoteWorkItemParser.parse(output) ?? fallbackCreatedReference(provider: .gitlab, container: request.container, stdout: output)
        return try await fetch(ref)
    }

    func listAssignedToMe(_ request: RemoteWorkItemListRequest) async throws -> [RemoteWorkItemSnapshot] {
        guard let container = request.container, !container.isEmpty else {
            throw RemoteWorkItemError.unsupportedReference("GitLab assigned list requires group/project")
        }
        let result = try await runner.run(
            executable: "glab",
            arguments: [
                "issue", "list",
                "--repo", container,
                "--assignee", "@me",
                "--state", "all",
                "--per-page", "\(request.limit)",
                "--output", "json"
            ],
            cwd: nil,
            timeout: 20
        )
        try remoteValidate(result)
        let issues = try remoteParseJSONArray(result.stdout)
        return issues.map { gitlabSnapshot(container: container, json: $0) }
    }

    func availableStatuses(_ reference: RemoteWorkItemReference) async throws -> [RemoteWorkItemStatusOption] {
        let snapshot = try await fetch(reference)
        if snapshot.statusLabel == "closed" {
            return [RemoteWorkItemStatusOption(id: "gitlab.reopen", label: "Reopen", targetState: "opened", providerPayload: [:])]
        }
        return [RemoteWorkItemStatusOption(id: "gitlab.close", label: "Close", targetState: "closed", providerPayload: [:])]
    }

    func updateStatus(_ reference: RemoteWorkItemReference, to status: RemoteWorkItemStatusOption) async throws -> RemoteWorkItemSnapshot {
        let subcommand = status.id.contains("reopen") || status.targetState == "opened" ? "reopen" : "close"
        let result = try await runner.run(executable: "glab", arguments: ["issue", subcommand, issueNumber(reference), "--repo", repo(reference)], cwd: nil, timeout: 20)
        try remoteValidate(result)
        return try await fetch(reference)
    }

    private func issueView(_ reference: RemoteWorkItemReference) async throws -> [String: Any] {
        let result = try await runner.run(executable: "glab", arguments: ["issue", "view", issueNumber(reference), "--repo", repo(reference), "--output", "json"], cwd: nil, timeout: 20)
        try remoteValidate(result)
        return try remoteParseJSONObject(result.stdout)
    }

    private func gitlabSnapshot(container: String, json: [String: Any]) -> RemoteWorkItemSnapshot {
        let number = (json["iid"] as? Int) ?? (json["number"] as? Int)
        let url = (json["web_url"] as? String) ?? (json["webUrl"] as? String)
        let parts = container.split(separator: "/").map(String.init)
        let repository = parts.last
        let namespace = parts.dropLast().joined(separator: "/")
        let key = number.map { "\(container)#\($0)" } ?? container
        let reference = RemoteWorkItemReference(
            provider: .gitlab,
            key: key,
            url: url,
            host: URL(string: url ?? "")?.host,
            namespace: namespace.isEmpty ? nil : namespace,
            repository: repository,
            number: number
        )
        return RemoteWorkItemSnapshot(
            reference: reference,
            title: json["title"] as? String ?? key,
            bodyMarkdown: (json["description"] as? String) ?? (json["body"] as? String),
            statusLabel: (json["state"] as? String)?.lowercased(),
            assignees: remoteNames(from: json["assignees"]),
            labels: remoteStringArray(json["labels"]),
            providerUpdatedAt: remoteParseDate((json["updated_at"] as? String) ?? (json["updatedAt"] as? String)),
            fetchedAt: Date()
        )
    }
}

// MARK: - Jira

struct JiraRemoteWorkItemProvider: RemoteWorkItemProvider {
    let runner: any RemoteWorkItemCommandRunning
    var providerId: RemoteWorkItemProviderId { .jira }

    init(runner: any RemoteWorkItemCommandRunning = RemoteWorkItemCommandRunner.shared) {
        self.runner = runner
    }

    func fetch(_ reference: RemoteWorkItemReference) async throws -> RemoteWorkItemSnapshot {
        let json = try await workitemView(reference.key)
        return jiraSnapshot(reference: reference, json: json)
    }

    func create(_ request: RemoteWorkItemCreateRequest) async throws -> RemoteWorkItemSnapshot {
        var args = ["jira", "workitem", "create", "--project", request.container, "--summary", request.title, "--json"]
        if let body = request.bodyMarkdown, !body.isEmpty { args += ["--description", body] }
        if let issueType = request.issueType, !issueType.isEmpty { args += ["--type", issueType] }
        if !request.labels.isEmpty { args += ["--label", request.labels.joined(separator: ",")] }
        let result = try await runner.run(executable: "acli", arguments: args, cwd: nil, timeout: 20)
        try remoteValidate(result)
        let output = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let object = try? remoteParseJSONObject(output)
        let key = (object?["key"] as? String)
            ?? (object?["issueKey"] as? String)
            ?? RemoteWorkItemParser.extractJiraKey(from: output)
            ?? output
        let ref = RemoteWorkItemReference(provider: .jira, key: key, url: nil, host: nil, namespace: nil, repository: nil, number: nil)
        return try await fetch(ref)
    }

    func listAssignedToMe(_ request: RemoteWorkItemListRequest) async throws -> [RemoteWorkItemSnapshot] {
        var jql = "assignee = currentUser()"
        if let project = request.container?.trimmingCharacters(in: .whitespacesAndNewlines), !project.isEmpty {
            jql += " AND project = \(project)"
        }
        jql += " ORDER BY updated DESC"
        let result = try await runner.run(
            executable: "acli",
            arguments: [
                "jira", "workitem", "search",
                "--jql", jql,
                "--limit", "\(request.limit)",
                "--fields", "key,summary,status,assignee,labels,description",
                "--json"
            ],
            cwd: nil,
            timeout: 20
        )
        try remoteValidate(result)
        let issues = try jiraSearchItems(from: result.stdout)
        return issues.map { jiraSnapshot(reference: jiraReference(from: $0), json: $0) }
    }

    func availableStatuses(_ reference: RemoteWorkItemReference) async throws -> [RemoteWorkItemStatusOption] {
        let current = try? await fetch(reference).statusLabel?.lowercased()
        return ["To Do", "In Progress", "In Review", "Done"].compactMap { label in
            guard label.lowercased() != current else { return nil }
            return RemoteWorkItemStatusOption(
                id: "jira.status.\(label.lowercased().replacingOccurrences(of: " ", with: "-"))",
                label: label,
                targetState: label,
                providerPayload: ["targetStatusLabel": label]
            )
        }
    }

    func updateStatus(_ reference: RemoteWorkItemReference, to status: RemoteWorkItemStatusOption) async throws -> RemoteWorkItemSnapshot {
        let target = status.providerPayload["targetStatusLabel"] ?? status.targetState ?? status.label
        let result = try await runner.run(executable: "acli", arguments: ["jira", "workitem", "transition", "--key", reference.key, "--status", target, "--yes", "--json"], cwd: nil, timeout: 20)
        try remoteValidate(result)
        return try await fetch(reference)
    }

    private func workitemView(_ key: String) async throws -> [String: Any] {
        let result = try await runner.run(executable: "acli", arguments: ["jira", "workitem", "view", key, "--json"], cwd: nil, timeout: 20)
        try remoteValidate(result)
        return try remoteParseJSONObject(result.stdout)
    }

    private func jiraSnapshot(reference: RemoteWorkItemReference, json: [String: Any]) -> RemoteWorkItemSnapshot {
        let fields = json["fields"] as? [String: Any]
        let status = ((fields?["status"] as? [String: Any])?["name"] as? String) ?? (json["status"] as? String)
        let title = (fields?["summary"] as? String) ?? (json["summary"] as? String) ?? (json["key"] as? String) ?? reference.key
        return RemoteWorkItemSnapshot(
            reference: normalizedReference(reference, url: json["url"] as? String),
            title: title,
            bodyMarkdown: jiraDescription(from: fields?["description"] ?? json["description"]),
            statusLabel: status,
            assignees: remoteNames(from: fields?["assignee"] ?? json["assignee"]),
            labels: remoteStringArray(fields?["labels"]),
            providerUpdatedAt: remoteParseDate(fields?["updated"] as? String),
            fetchedAt: Date()
        )
    }

    private func jiraReference(from json: [String: Any]) -> RemoteWorkItemReference {
        let key = (json["key"] as? String)
            ?? ((json["fields"] as? [String: Any])?["key"] as? String)
            ?? "JIRA-UNKNOWN"
        return RemoteWorkItemReference(
            provider: .jira,
            key: key,
            url: json["url"] as? String,
            host: nil,
            namespace: nil,
            repository: nil,
            number: nil
        )
    }

    private func jiraSearchItems(from text: String) throws -> [[String: Any]] {
        if let array = try? remoteParseJSONArray(text) {
            return array
        }
        let object = try remoteParseJSONObject(text)
        if let issues = object["issues"] as? [[String: Any]] { return issues }
        if let workItems = object["workItems"] as? [[String: Any]] { return workItems }
        if let values = object["values"] as? [[String: Any]] { return values }
        return []
    }
}

// MARK: - Shared helpers

private func issueNumber(_ reference: RemoteWorkItemReference) -> String { String(reference.number ?? 0) }
private func repo(_ reference: RemoteWorkItemReference) -> String { "\(reference.namespace ?? "")/\(reference.repository ?? "")" }

private func normalizedReference(_ reference: RemoteWorkItemReference, url: String?) -> RemoteWorkItemReference {
    var copy = reference
    if copy.url == nil { copy.url = url }
    return copy
}

private func fallbackCreatedReference(provider: RemoteWorkItemProviderId, container: String, stdout: String) -> RemoteWorkItemReference {
    let number = Int(stdout.split(whereSeparator: { !$0.isNumber }).last ?? "") ?? 0
    let parts = container.split(separator: "/").map(String.init)
    let repo = parts.last ?? container
    let namespace = parts.dropLast().joined(separator: "/")
    return RemoteWorkItemReference(provider: provider, key: "\(container)#\(number)", url: nil, host: provider == .github ? "github.com" : nil, namespace: namespace, repository: repo, number: number)
}

private func remoteValidate(_ result: RemoteWorkItemCommandResult) throws {
    if result.timedOut { throw RemoteWorkItemError.commandFailed("Provider CLI timed out") }
    guard result.exitStatus == 0 else {
        let message = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Provider CLI exited \(result.exitStatus)"
            : result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        throw RemoteWorkItemError.commandFailed(message)
    }
}

private func remoteParseJSONObject(_ text: String) throws -> [String: Any] {
    guard let data = text.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw RemoteWorkItemError.parseFailed("Provider CLI returned non-object JSON")
    }
    return object
}

private func remoteParseJSONArray(_ text: String) throws -> [[String: Any]] {
    guard let data = text.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        throw RemoteWorkItemError.parseFailed("Provider CLI returned non-array JSON")
    }
    return object
}

private func remoteNames(from raw: Any?) -> [String] {
    if let object = raw as? [String: Any] {
        return [object["displayName"] as? String, object["name"] as? String, object["emailAddress"] as? String]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
    }
    guard let array = raw as? [[String: Any]] else { return remoteStringArray(raw) }
    return array.compactMap { ($0["login"] as? String) ?? ($0["username"] as? String) ?? ($0["name"] as? String) }
}

private func remoteStringArray(_ raw: Any?) -> [String] {
    if let strings = raw as? [String] { return strings }
    if let array = raw as? [[String: Any]] { return array.compactMap { ($0["name"] as? String) ?? ($0["title"] as? String) } }
    return []
}

private func remoteParseDate(_ raw: String?) -> Date? {
    guard let raw else { return nil }
    return ISO8601DateFormatter().date(from: raw)
}

private func jiraDescription(from raw: Any?) -> String? {
    if let text = raw as? String { return text }
    guard let object = raw as? [String: Any] else { return nil }
    var parts: [String] = []
    collectJiraText(from: object, into: &parts)
    let joined = parts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    return joined.isEmpty ? nil : joined
}

private func collectJiraText(from raw: Any, into parts: inout [String]) {
    if let text = raw as? String {
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append(text)
        }
        return
    }
    if let array = raw as? [Any] {
        for item in array { collectJiraText(from: item, into: &parts) }
        return
    }
    guard let object = raw as? [String: Any] else { return }
    if let text = object["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        parts.append(text)
    }
    if let content = object["content"] {
        collectJiraText(from: content, into: &parts)
    }
}

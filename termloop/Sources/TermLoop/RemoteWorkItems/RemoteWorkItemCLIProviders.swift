// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

// MARK: - Command runner

struct RemoteWorkItemCommandResult: Sendable {
    var executable: String? = nil
    var arguments: [String] = []
    var cwd: String? = nil
    var exitStatus: Int32
    var stdout: String
    var stderr: String
    var timedOut: Bool
    var terminatedBySignal: Bool = false
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
        let stdoutBuffer = RemoteWorkItemPipeBuffer()
        let stderrBuffer = RemoteWorkItemPipeBuffer()

        let completion = RemoteWorkItemCommandCompletion()

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let finish: @Sendable (Result<RemoteWorkItemCommandResult, Error>) -> Void = { result in
                    guard completion.claim() else { return }
                    stdoutPipe.fileHandleForReading.readabilityHandler = nil
                    stderrPipe.fileHandleForReading.readabilityHandler = nil
                    continuation.resume(with: result)
                }

                do {
                    try process.run()
                } catch {
                    finish(.failure(error))
                    return
                }

                stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
                    stdoutBuffer.drain(handle)
                }
                stderrPipe.fileHandleForReading.readabilityHandler = { handle in
                    stderrBuffer.drain(handle)
                }

                let timeoutTask = DispatchWorkItem {
                    if completion.isCancelled {
                        finish(.failure(CancellationError()))
                        return
                    }
                    completion.markTimedOut()
                    if process.isRunning { process.terminate() }
                    finish(.success(RemoteWorkItemCommandResult(
                        executable: executable,
                        arguments: arguments,
                        cwd: cwd,
                        exitStatus: 124,
                        stdout: stdoutBuffer.string(),
                        stderr: stderrBuffer.string(),
                        timedOut: true,
                        terminatedBySignal: false
                    )))
                }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: timeoutTask)

                process.terminationHandler = { proc in
                    timeoutTask.cancel()
                    if completion.isCancelled {
                        finish(.failure(CancellationError()))
                        return
                    }
                    stdoutBuffer.drain(stdoutPipe.fileHandleForReading)
                    stderrBuffer.drain(stderrPipe.fileHandleForReading)
                    let timedOut = completion.isTimedOut
                    finish(.success(RemoteWorkItemCommandResult(
                        executable: executable,
                        arguments: arguments,
                        cwd: cwd,
                        exitStatus: proc.terminationStatus,
                        stdout: stdoutBuffer.string(),
                        stderr: stderrBuffer.string(),
                        timedOut: timedOut,
                        terminatedBySignal: proc.terminationReason == .uncaughtSignal
                    )))
                }
            }
        } onCancel: {
            completion.cancel()
            if process.isRunning { process.terminate() }
        }
    }

    private func sanitizedEnvironment(_ env: [String: String]) -> [String: String] {
        var result: [String: String] = [:]
        for key in ["PATH", "HOME", "LANG", "LC_ALL", "SHELL", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] {
            if let value = env[key] { result[key] = value }
        }
        result["PATH"] = Self.cliSearchPath(from: result["PATH"])
        return result
    }

    private static func cliSearchPath(from existingPath: String?) -> String {
        var seen = Set<String>()
        var parts: [String] = []

        func appendPath(_ path: String?) {
            guard let path, !path.isEmpty else { return }
            for rawPart in path.split(separator: ":", omittingEmptySubsequences: true) {
                let part = String(rawPart)
                guard seen.insert(part).inserted else { continue }
                parts.append(part)
            }
        }

        appendPath(existingPath)
        appendPath(getenv("PATH").map { String(cString: $0) })
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin"
        ].forEach { appendPath($0) }

        return parts.joined(separator: ":")
    }
}

private final class RemoteWorkItemCommandCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var didResume = false
    private var cancelled = false
    private var timedOut = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !didResume else { return false }
        didResume = true
        return true
    }

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    func markTimedOut() {
        lock.lock()
        timedOut = true
        lock.unlock()
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    var isTimedOut: Bool {
        lock.lock()
        defer { lock.unlock() }
        return timedOut
    }
}

private final class RemoteWorkItemPipeBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private let cap: Int
    private var data = Data()
    private var truncatedByteCount = 0

    init(cap: Int = 512_000) {
        self.cap = cap
    }

    func drain(_ handle: FileHandle) {
        let chunk = handle.availableData
        guard !chunk.isEmpty else { return }
        append(chunk)
    }

    func append(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        let remaining = max(0, cap - data.count)
        if remaining > 0 {
            data.append(chunk.prefix(remaining))
        }
        if chunk.count > remaining {
            truncatedByteCount += chunk.count - remaining
        }
    }

    func string() -> String {
        lock.lock()
        let snapshot = data
        let truncated = truncatedByteCount
        lock.unlock()

        var text = String(data: snapshot, encoding: .utf8) ?? ""
        if truncated > 0 {
            text += "\n... truncated \(truncated) bytes"
        }
        return text
    }
}

actor JiraCommandGate {
    static let shared = JiraCommandGate()

    private var isRunning = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func run(
        site rawSite: String?,
        email rawEmail: String?,
        arguments: [String],
        timeout: TimeInterval,
        runner: any RemoteWorkItemCommandRunning
    ) async throws -> RemoteWorkItemCommandResult {
        await acquire()
        defer { release() }
        try Task.checkCancellation()
        try await switchToConfiguredSite(site: rawSite, email: rawEmail, runner: runner)
        try Task.checkCancellation()
        return try await runner.run(executable: "acli", arguments: arguments, cwd: nil, timeout: timeout)
    }

    private func acquire() async {
        if !isRunning {
            isRunning = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    private func release() {
        guard !waiters.isEmpty else {
            isRunning = false
            return
        }
        waiters.removeFirst().resume()
    }

    private func switchToConfiguredSite(
        site rawSite: String?,
        email rawEmail: String?,
        runner: any RemoteWorkItemCommandRunning
    ) async throws {
        guard let site = JiraCommandGate.normalizedSite(rawSite) else { return }
        let email = rawEmail?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        var args = ["jira", "auth", "switch", "--site", site]
        if let email { args += ["--email", email] }
        let result = try await runner.run(executable: "acli", arguments: args, cwd: nil, timeout: 12)
        try remoteValidate(result)
    }

    private static func normalizedSite(_ value: String?) -> String? {
        var site = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if site.isEmpty { return nil }
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
                "--search", "sort:updated-desc",
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
                "--order", "updated_at",
                "--sort", "desc",
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
    let site: String?
    let email: String?
    var providerId: RemoteWorkItemProviderId { .jira }

    init(
        runner: any RemoteWorkItemCommandRunning = RemoteWorkItemCommandRunner.shared,
        site: String? = nil,
        email: String? = nil
    ) {
        self.runner = runner
        self.site = Self.normalizedSite(site)
        self.email = email?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    func fetch(_ reference: RemoteWorkItemReference) async throws -> RemoteWorkItemSnapshot {
        let json = try await workitemView(reference.key)
        return jiraSnapshot(reference: reference, json: json)
    }

    func create(_ request: RemoteWorkItemCreateRequest) async throws -> RemoteWorkItemSnapshot {
        let issueType = request.issueType?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty ?? "Task"
        var args = [
            "jira", "workitem", "create",
            "--project", request.container,
            "--summary", request.title,
            "--type", issueType,
            "--json"
        ]
        if let body = request.bodyMarkdown, !body.isEmpty { args += ["--description", body] }
        if !request.labels.isEmpty { args += ["--label", request.labels.joined(separator: ",")] }
        let result = try await runAcli(args, timeout: 20)
        try remoteValidate(result)
        let output = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let object = try? remoteParseJSONObject(output)
        let key = (object?["key"] as? String)
            ?? (object?["issueKey"] as? String)
            ?? RemoteWorkItemParser.extractJiraKey(from: output)
            ?? output
        let ref = RemoteWorkItemReference(
            provider: .jira,
            key: key,
            url: jiraWebURL(for: key),
            host: site,
            namespace: nil,
            repository: nil,
            number: nil
        )
        return try await fetch(ref)
    }

    func listAssignedToMe(_ request: RemoteWorkItemListRequest) async throws -> [RemoteWorkItemSnapshot] {
        var jql = "assignee = currentUser()"
        if let project = request.container?.trimmingCharacters(in: .whitespacesAndNewlines), !project.isEmpty {
            jql += " AND project = \(project)"
        }
        jql += " ORDER BY updated DESC"
        let result = try await runAcli(
            [
                "jira", "workitem", "search",
                "--jql", jql,
                "--limit", "\(request.limit)",
                "--fields", "key,summary,status,assignee,labels,description",
                "--json"
            ],
            timeout: 20
        )
        try remoteValidate(result)
        let issues = try jiraSearchItems(from: result.stdout)
        return issues.map { jiraSnapshot(reference: jiraReference(from: $0), json: $0) }
    }

    func availableStatuses(_ reference: RemoteWorkItemReference) async throws -> [RemoteWorkItemStatusOption] {
        let current = try? await fetch(reference).statusLabel?.lowercased()
        var labels: [String] = []
        if let projectKey = reference.key.split(separator: "-", maxSplits: 1).first.map(String.init) {
            labels = (try? await jiraStatusLabelsForProject(projectKey)) ?? []
        }
        if labels.isEmpty {
            labels = ["To Do", "In Progress", "In Review", "Done"]
        }
        return labels.compactMap { label in
            guard label.lowercased() != current else { return nil }
            return RemoteWorkItemStatusOption(
                id: "jira.status.\(label.lowercased().replacingOccurrences(of: " ", with: "-"))",
                label: label,
                targetState: label,
                providerPayload: ["targetStatusLabel": label]
            )
        }
    }

    func statusLabels(projectKey: String?) async throws -> [String] {
        let project = projectKey?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let jql = project.map { "project = \($0) ORDER BY updated DESC" }
            ?? "assignee = currentUser() ORDER BY updated DESC"
        return try await jiraStatusLabels(jql: jql)
    }

    func issueTypeOptions(projectKey: String) async throws -> [TaskRemoteIssueTypeOption] {
        let project = projectKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !project.isEmpty else {
            throw RemoteWorkItemError.unsupportedReference("Jira issue type lookup requires a project key")
        }
        let result = try await runAcli(
            ["jira", "project", "view", "--key", project, "--json"],
            timeout: 20
        )
        try remoteValidate(result)
        return try Self.parseIssueTypeOptions(result.stdout)
    }

    func projectOptions() async throws -> [TaskRemoteContainerOption] {
        do {
            let result = try await runAcli(
                ["jira", "project", "list", "--limit", "100", "--json"],
                timeout: 20
            )
            try remoteValidate(result)
            return try Self.parseProjectOptions(result.stdout)
        } catch {
            let projectListError = remoteHumanError(error)
            let fallback = try await runAcli(
                [
                    "jira", "workitem", "search",
                    "--jql", "assignee = currentUser() ORDER BY updated DESC",
                    "--limit", "100",
                    "--fields", "key,summary",
                    "--json"
                ],
                timeout: 20
            )
            do {
                try remoteValidate(fallback)
                let options = try Self.parseProjectOptionsFromWorkItems(fallback.stdout)
                if options.isEmpty {
                    throw RemoteWorkItemError.commandFailed("Jira project list is unavailable: \(projectListError)")
                }
                return options
            } catch {
                throw RemoteWorkItemError.commandFailed(
                    "Jira project list is unavailable: \(projectListError). Fallback also failed: \(remoteHumanError(error))"
                )
            }
        }
    }

    static func configuredAccounts() -> [TaskRemoteJiraAccountOption] {
        let environment = ProcessInfo.processInfo.environment
        let configRoot = environment["XDG_CONFIG_HOME"].flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty }
            .map(URL.init(fileURLWithPath:))
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config")
        let url = configRoot.appendingPathComponent("acli/jira_config.yaml")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return parseAccountsConfig(text)
    }

    static func discoverAccounts(
        runner: any RemoteWorkItemCommandRunning = RemoteWorkItemCommandRunner.shared
    ) async -> [TaskRemoteJiraAccountOption] {
        var options = configuredAccounts()
        if options.isEmpty,
           let status = try? await runner.run(
               executable: "acli",
               arguments: ["jira", "auth", "status"],
               cwd: nil,
               timeout: 8
           ),
           status.exitStatus == 0,
           let option = parseAuthStatus(status.stdout + "\n" + status.stderr) {
            options = [option]
        }
        return uniqueAccounts(options)
    }

    func updateStatus(_ reference: RemoteWorkItemReference, to status: RemoteWorkItemStatusOption) async throws -> RemoteWorkItemSnapshot {
        let target = status.providerPayload["targetStatusLabel"] ?? status.targetState ?? status.label
        let result = try await runAcli(["jira", "workitem", "transition", "--key", reference.key, "--status", target, "--yes", "--json"], timeout: 20)
        try remoteValidate(result)
        return try await fetch(reference)
    }

    private func workitemView(_ key: String) async throws -> [String: Any] {
        let result = try await runAcli(["jira", "workitem", "view", key, "--json"], timeout: 20)
        try remoteValidate(result)
        return try remoteParseJSONObject(result.stdout)
    }

    private func jiraStatusLabelsForProject(_ projectKey: String) async throws -> [String] {
        try await jiraStatusLabels(jql: "project = \(projectKey) ORDER BY updated DESC")
    }

    private func jiraStatusLabels(jql: String) async throws -> [String] {
        let result = try await runAcli(
            [
                "jira", "workitem", "search",
                "--jql", jql,
                "--paginate",
                "--fields", "key,status",
                "--csv"
            ],
            timeout: 60
        )
        try remoteValidate(result)
        return remoteParseStatusLabelsCSV(result.stdout, defaultLabels: [])
    }

    static func parseAccountsConfig(_ text: String) -> [TaskRemoteJiraAccountOption] {
        let currentProfile = remoteYAMLScalar(named: "current_profile", in: text)
        var options: [TaskRemoteJiraAccountOption] = []
        var profile: [String: String] = [:]

        func flush() {
            guard let site = profile["site"]?.nilIfEmpty else { return }
            let cloudId = profile["cloud_id"] ?? ""
            let accountId = profile["account_id"] ?? ""
            let profileId = "\(cloudId):\(accountId)"
            options.append(TaskRemoteJiraAccountOption(
                site: site,
                email: profile["email"],
                displayName: profile["display_name"],
                isCurrent: currentProfile == profileId
            ))
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("- ") {
                flush()
                profile = [:]
                let rest = String(line.dropFirst(2))
                if let (key, value) = remoteYAMLPair(rest) { profile[key] = value }
                continue
            }
            guard !profile.isEmpty, let (key, value) = remoteYAMLPair(line) else { continue }
            profile[key] = value
        }
        flush()
        return uniqueAccounts(options)
    }

    static func parseAuthStatus(_ text: String) -> TaskRemoteJiraAccountOption? {
        var site: String?
        var email: String?
        for rawLine in text.split(separator: "\n").map(String.init) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("Site:") {
                site = String(line.dropFirst("Site:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            } else if line.hasPrefix("Email:") {
                email = String(line.dropFirst("Email:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        guard let site = site?.nilIfEmpty else { return nil }
        return TaskRemoteJiraAccountOption(site: site, email: email, displayName: nil, isCurrent: true)
    }

    static func parseProjectOptions(_ text: String) throws -> [TaskRemoteContainerOption] {
        guard let data = text.data(using: .utf8) else {
            throw RemoteWorkItemError.parseFailed("Provider CLI returned non-UTF8 JSON")
        }
        let json = try JSONSerialization.jsonObject(with: data)
        let rawProjects: [[String: Any]]
        if let array = json as? [[String: Any]] {
            rawProjects = array
        } else if let object = json as? [String: Any] {
            rawProjects = (object["values"] as? [[String: Any]])
                ?? (object["projects"] as? [[String: Any]])
                ?? (object["results"] as? [[String: Any]])
                ?? []
        } else {
            rawProjects = []
        }
        var seen = Set<String>()
        return rawProjects.compactMap { project in
            let key = (project["key"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let key, !key.isEmpty, !seen.contains(key) else { return nil }
            seen.insert(key)
            let name = ((project["name"] as? String)
                ?? (project["title"] as? String)
                ?? key)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return TaskRemoteContainerOption(key: key, name: name)
        }
        .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }

    static func parseProjectOptionsFromWorkItems(_ text: String) throws -> [TaskRemoteContainerOption] {
        guard let data = text.data(using: .utf8) else {
            throw RemoteWorkItemError.parseFailed("Provider CLI returned non-UTF8 JSON")
        }
        let json = try JSONSerialization.jsonObject(with: data)
        let items: [[String: Any]]
        if let array = json as? [[String: Any]] {
            items = array
        } else if let object = json as? [String: Any] {
            items = (object["issues"] as? [[String: Any]])
                ?? (object["workItems"] as? [[String: Any]])
                ?? (object["values"] as? [[String: Any]])
                ?? []
        } else {
            items = []
        }

        var projects: [String: String] = [:]
        for item in items {
            let fields = item["fields"] as? [String: Any]
            let project = (fields?["project"] as? [String: Any]) ?? (item["project"] as? [String: Any])
            let explicitKey = (project?["key"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let issueKey = ((item["key"] as? String) ?? (fields?["key"] as? String))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let derivedKey = issueKey.flatMap { key -> String? in
                guard let dash = key.firstIndex(of: "-") else { return nil }
                return String(key[..<dash])
            }
            guard let key = (explicitKey?.nilIfEmpty ?? derivedKey?.nilIfEmpty) else { continue }
            let name = ((project?["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty) ?? key
            projects[key] = projects[key] ?? name
        }
        return projects
            .map { TaskRemoteContainerOption(key: $0.key, name: $0.value) }
            .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }

    static func parseIssueTypeOptions(_ text: String) throws -> [TaskRemoteIssueTypeOption] {
        guard let data = text.data(using: .utf8) else {
            throw RemoteWorkItemError.parseFailed("Provider CLI returned non-UTF8 JSON")
        }
        let json = try JSONSerialization.jsonObject(with: data)
        let rawTypes: [[String: Any]]
        if let object = json as? [String: Any] {
            rawTypes = (object["issueTypes"] as? [[String: Any]])
                ?? (object["workItemTypes"] as? [[String: Any]])
                ?? (object["types"] as? [[String: Any]])
                ?? []
        } else if let array = json as? [[String: Any]] {
            rawTypes = array
        } else {
            rawTypes = []
        }

        var seen = Set<String>()
        return rawTypes.compactMap { type in
            let name = (type["name"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let name, !name.isEmpty else { return nil }
            let normalized = name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).lowercased()
            guard seen.insert(normalized).inserted else { return nil }
            let id = ((type["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty)
                ?? normalized
            let hierarchyLevel = type["hierarchyLevel"] as? Int
            let isSubtask = (type["subtask"] as? Bool) ?? (hierarchyLevel.map { $0 < 0 } ?? false)
            return TaskRemoteIssueTypeOption(
                id: id,
                name: name,
                description: type["description"] as? String,
                isSubtask: isSubtask
            )
        }
    }

    private static func uniqueAccounts(_ options: [TaskRemoteJiraAccountOption]) -> [TaskRemoteJiraAccountOption] {
        var seen = Set<String>()
        return options.filter { option in
            guard !seen.contains(option.id) else { return false }
            seen.insert(option.id)
            return true
        }
        .sorted { lhs, rhs in
            if lhs.isCurrent != rhs.isCurrent { return lhs.isCurrent }
            return lhs.displayLabel.localizedStandardCompare(rhs.displayLabel) == .orderedAscending
        }
    }

    private func runAcli(_ arguments: [String], timeout: TimeInterval) async throws -> RemoteWorkItemCommandResult {
        try await JiraCommandGate.shared.run(
            site: site,
            email: email,
            arguments: arguments,
            timeout: timeout,
            runner: runner
        )
    }

    private static func normalizedSite(_ value: String?) -> String? {
        var site = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if site.isEmpty { return nil }
        if let url = URL(string: site), let host = url.host {
            site = host
        }
        site = site
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return site.nilIfEmpty
    }

    private func jiraSnapshot(reference: RemoteWorkItemReference, json: [String: Any]) -> RemoteWorkItemSnapshot {
        let fields = json["fields"] as? [String: Any]
        let status = ((fields?["status"] as? [String: Any])?["name"] as? String) ?? (json["status"] as? String)
        let title = (fields?["summary"] as? String) ?? (json["summary"] as? String) ?? (json["key"] as? String) ?? reference.key
        return RemoteWorkItemSnapshot(
            reference: normalizedReference(
                reference,
                url: (json["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? jiraWebURL(for: reference.key)
            ),
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
            url: (json["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                ?? jiraWebURL(for: key),
            host: site,
            namespace: nil,
            repository: nil,
            number: nil
        )
    }

    private func jiraWebURL(for key: String) -> String? {
        guard let site else { return nil }
        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedKey.isEmpty else { return nil }
        let encodedKey = trimmedKey.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trimmedKey
        return "https://\(site)/browse/\(encodedKey)"
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
    if result.timedOut {
        throw RemoteWorkItemError.commandFailed(remoteCommandFailureMessage(result, fallback: "Provider CLI timed out."))
    }
    guard result.exitStatus == 0 else {
        throw RemoteWorkItemError.commandFailed(remoteCommandFailureMessage(result, fallback: "Provider CLI exited \(result.exitStatus)."))
    }
}

func remoteCommandFailureMessage(_ result: RemoteWorkItemCommandResult, fallback: String) -> String {
    var lines: [String] = ["Provider CLI failed."]
    if let command = result.commandLine.nilIfEmpty {
        lines.append("Command: \(command)")
    }
    if let cwd = result.cwd?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
        lines.append("CWD: \(cwd)")
    }
    if result.timedOut {
        lines.append("Timeout: yes")
    }
    if result.terminatedBySignal {
        lines.append("Exit: signal \(result.exitStatus)")
    } else {
        lines.append("Exit: \(result.exitStatus)")
    }

    let stderr = remoteSnippet(result.stderr)
    let stdout = remoteSnippet(result.stdout)
    if !stderr.isEmpty {
        lines.append("Stderr:\n\(stderr)")
    }
    if !stdout.isEmpty {
        lines.append("Stdout:\n\(stdout)")
    }
    if stderr.isEmpty && stdout.isEmpty {
        lines.append(fallback)
    }
    return lines.joined(separator: "\n")
}

private func remoteSnippet(_ text: String, limit: Int = 4_000) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "" }
    if trimmed.count <= limit { return trimmed }
    return "\(trimmed.prefix(limit))\n... truncated \(trimmed.count - limit) chars"
}

private extension RemoteWorkItemCommandResult {
    var commandLine: String {
        guard let executable = executable?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty else {
            return ""
        }
        return ([executable] + arguments).map(remoteShellQuote).joined(separator: " ")
    }
}

private func remoteShellQuote(_ value: String) -> String {
    guard !value.isEmpty else { return "''" }
    let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/:.,=+-@%")
    if value.unicodeScalars.allSatisfy({ safe.contains($0) }) {
        return value
    }
    return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
}

private func remoteHumanError(_ error: Error) -> String {
    if let remoteError = error as? RemoteWorkItemError {
        switch remoteError {
        case .commandFailed(let message), .parseFailed(let message), .unsupportedReference(let message):
            return message.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Unknown error"
        case .unsupportedProvider(let provider):
            return "Unsupported provider: \(provider.rawValue)"
        }
    }
    let text = String(describing: error).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? "Unknown error" : text
}

private func remoteYAMLScalar(named key: String, in text: String) -> String? {
    for line in text.split(separator: "\n").map(String.init) {
        guard let (lineKey, value) = remoteYAMLPair(line.trimmingCharacters(in: .whitespacesAndNewlines)), lineKey == key else {
            continue
        }
        return value
    }
    return nil
}

private func remoteYAMLPair(_ line: String) -> (String, String)? {
    guard !line.isEmpty, !line.hasPrefix("#"), let separator = line.firstIndex(of: ":") else { return nil }
    let key = String(line[..<separator]).trimmingCharacters(in: .whitespacesAndNewlines)
    var value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix("\"") && value.hasSuffix("\"") && value.count >= 2 {
        value = String(value.dropFirst().dropLast())
    }
    return key.isEmpty ? nil : (key, value)
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

func remoteParseStatusLabelsCSV(_ text: String, defaultLabels: [String]) -> [String] {
    var labels: [String] = []
    var seen = Set<String>()
    var statusColumnIndex: Int?
    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init) {
        let fields = remoteCSVFields(rawLine)
        guard !fields.isEmpty else { continue }
        if let headerIndex = fields.firstIndex(where: { field in
            field.trimmingCharacters(in: .whitespacesAndNewlines)
                .compare("Status", options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }) {
            statusColumnIndex = headerIndex
            continue
        }
        let index = min(statusColumnIndex ?? max(fields.count - 1, 0), fields.count - 1)
        let label = fields[index]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { continue }
        let key = label.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).lowercased()
        if seen.insert(key).inserted {
            labels.append(label)
        }
    }
    if labels.isEmpty {
        labels = defaultLabels
    }
    return labels.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
}

private func remoteCSVFields(_ line: String) -> [String] {
    var fields: [String] = []
    var current = ""
    var inQuotes = false
    var index = line.startIndex
    while index < line.endIndex {
        let character = line[index]
        if character == "\"" {
            let next = line.index(after: index)
            if inQuotes, next < line.endIndex, line[next] == "\"" {
                current.append(character)
                index = line.index(after: next)
                continue
            }
            inQuotes.toggle()
        } else if character == ",", !inQuotes {
            fields.append(current)
            current = ""
        } else {
            current.append(character)
        }
        index = line.index(after: index)
    }
    fields.append(current)
    return fields
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

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

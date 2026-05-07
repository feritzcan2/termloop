import Foundation

struct FakeRemoteWorkItemProvider: RemoteWorkItemProvider {
    var providerId: RemoteWorkItemProviderId { .github }
    let projectRoot: URL

    func fetch(_ reference: RemoteWorkItemReference) async throws -> RemoteWorkItemSnapshot {
        RemoteWorkItemSnapshot(
            reference: reference,
            title: "Fetched smoke issue",
            bodyMarkdown: "Fetched body for \(reference.key)",
            statusLabel: "open",
            assignees: ["smoke-user"],
            labels: ["smoke"],
            providerUpdatedAt: nil,
            fetchedAt: Date()
        )
    }

    func create(_ request: RemoteWorkItemCreateRequest) async throws -> RemoteWorkItemSnapshot {
        let reference = RemoteWorkItemReference(
            provider: .github,
            key: "\(request.container)#123",
            url: "https://github.com/\(request.container)/issues/123",
            host: "github.com",
            namespace: String(request.container.split(separator: "/").dropLast().joined(separator: "/")),
            repository: String(request.container.split(separator: "/").last ?? "repo"),
            number: 123
        )
        return RemoteWorkItemSnapshot(
            reference: reference,
            title: request.title,
            bodyMarkdown: request.bodyMarkdown,
            statusLabel: "open",
            assignees: [],
            labels: request.labels,
            providerUpdatedAt: nil,
            fetchedAt: Date()
        )
    }

    func availableStatuses(_ reference: RemoteWorkItemReference) async throws -> [RemoteWorkItemStatusOption] {
        [RemoteWorkItemStatusOption(id: "github.close", label: "Close", targetState: "closed", providerPayload: [:])]
    }

    func listAssignedToMe(_ request: RemoteWorkItemListRequest) async throws -> [RemoteWorkItemSnapshot] {
        [
            RemoteWorkItemSnapshot(
                reference: RemoteWorkItemReference(
                    provider: .github,
                    key: "\(request.container ?? "termloop/smoke")#456",
                    url: "https://github.com/\(request.container ?? "termloop/smoke")/issues/456",
                    host: "github.com",
                    namespace: "termloop",
                    repository: "smoke",
                    number: 456
                ),
                title: "Assigned smoke issue",
                bodyMarkdown: "Assigned body",
                statusLabel: "open",
                assignees: ["@me"],
                labels: ["assigned"],
                providerUpdatedAt: nil,
                fetchedAt: Date()
            )
        ]
    }

    func updateStatus(_ reference: RemoteWorkItemReference, to status: RemoteWorkItemStatusOption) async throws -> RemoteWorkItemSnapshot {
        RemoteWorkItemSnapshot(
            reference: reference,
            title: "Fetched smoke issue",
            bodyMarkdown: "Fetched body for \(reference.key)",
            statusLabel: status.targetState ?? status.label,
            assignees: [],
            labels: ["smoke"],
            providerUpdatedAt: nil,
            fetchedAt: Date()
        )
    }
}

struct FakeJiraRemoteWorkItemProvider: RemoteWorkItemProvider {
    var providerId: RemoteWorkItemProviderId { .jira }

    func fetch(_ reference: RemoteWorkItemReference) async throws -> RemoteWorkItemSnapshot {
        RemoteWorkItemSnapshot(
            reference: reference,
            title: "Fetched Jira smoke task",
            bodyMarkdown: "Fetched Jira body for \(reference.key)",
            statusLabel: "To Do",
            assignees: ["smoke-user"],
            labels: ["smoke"],
            providerUpdatedAt: nil,
            fetchedAt: Date()
        )
    }

    func create(_ request: RemoteWorkItemCreateRequest) async throws -> RemoteWorkItemSnapshot {
        let reference = RemoteWorkItemReference(
            provider: .jira,
            key: "\(request.container)-123",
            url: "https://termloop.atlassian.net/browse/\(request.container)-123",
            host: "termloop.atlassian.net",
            namespace: nil,
            repository: nil,
            number: nil
        )
        return RemoteWorkItemSnapshot(
            reference: reference,
            title: request.title,
            bodyMarkdown: request.bodyMarkdown,
            statusLabel: "To Do",
            assignees: [],
            labels: request.labels,
            providerUpdatedAt: nil,
            fetchedAt: Date()
        )
    }

    func availableStatuses(_ reference: RemoteWorkItemReference) async throws -> [RemoteWorkItemStatusOption] {
        [
            RemoteWorkItemStatusOption(id: "jira.status.in-progress", label: "In Progress", targetState: "In Progress", providerPayload: ["targetStatusLabel": "In Progress"]),
            RemoteWorkItemStatusOption(id: "jira.status.done", label: "Done", targetState: "Done", providerPayload: ["targetStatusLabel": "Done"])
        ]
    }

    func listAssignedToMe(_ request: RemoteWorkItemListRequest) async throws -> [RemoteWorkItemSnapshot] {
        [
            RemoteWorkItemSnapshot(
                reference: RemoteWorkItemReference(
                    provider: .jira,
                    key: "\(request.container ?? "KAN")-456",
                    url: "https://termloop.atlassian.net/browse/\(request.container ?? "KAN")-456",
                    host: "termloop.atlassian.net",
                    namespace: nil,
                    repository: nil,
                    number: nil
                ),
                title: "Assigned Jira smoke task",
                bodyMarkdown: "Assigned Jira body",
                statusLabel: "In Progress",
                assignees: ["@me"],
                labels: ["assigned"],
                providerUpdatedAt: nil,
                fetchedAt: Date()
            )
        ]
    }

    func updateStatus(_ reference: RemoteWorkItemReference, to status: RemoteWorkItemStatusOption) async throws -> RemoteWorkItemSnapshot {
        RemoteWorkItemSnapshot(
            reference: reference,
            title: "Fetched Jira smoke task",
            bodyMarkdown: "Fetched Jira body for \(reference.key)",
            statusLabel: status.targetState ?? status.label,
            assignees: [],
            labels: ["smoke"],
            providerUpdatedAt: nil,
            fetchedAt: Date()
        )
    }
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: "RemoteWorkItemSmoke", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

@main
struct SmokeMain {
    static func main() async {
        do {
            if CommandLine.arguments.dropFirst().first == "--live-github" {
                try await runLiveGitHub()
                return
            }
            if CommandLine.arguments.dropFirst().first == "--live-jira" {
                try await runLiveJira()
                return
            }
            if CommandLine.arguments.dropFirst().first == "--live-jira-assigned" {
                try await runLiveJiraAssigned()
                return
            }
            if CommandLine.arguments.dropFirst().first == "--live-jira-statuses" {
                try await runLiveJiraStatuses()
                return
            }

            try await runDryRun()
        } catch {
            fputs("remote-work-items smoke failed: \(friendlyDescription(error))\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func runDryRun() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("remote-work-item-smoke-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let service = RemoteWorkItemService(
            providers: [FakeRemoteWorkItemProvider(projectRoot: root)],
            taskFileWriter: RemoteWorkItemTaskFileWriter()
        )

        let created = try await service.create(RemoteWorkItemCreateRequest(
            provider: .github,
            title: "Smoke create issue",
            bodyMarkdown: "Smoke body",
            container: "termloop/smoke",
            labels: ["smoke"]
        ), projectRoot: root)
        try require(created.reference.key == "termloop/smoke#123", "create returned wrong reference")

        let statuses = try await service.availableStatuses(created.reference)
        try require(statuses.first?.targetState == "closed", "status options missing close")

        let updated = try await service.updateStatus(created.reference, to: statuses[0], projectRoot: root)
        try require(updated.statusLabel == "closed", "status update did not close")

        let linked = try await service.link(input: "https://github.com/termloop/smoke/issues/123", projectRoot: root)
        try require(linked.reference.key == "termloop/smoke#123", "link parser/fetch failed")

        let assigned = try await service.listAssignedToMe(RemoteWorkItemListRequest(provider: .github, container: "termloop/smoke", limit: 10))
        try require(assigned.first?.reference.key == "termloop/smoke#456", "github assigned list failed")

        let taskDirs = try FileManager.default.contentsOfDirectory(
            at: root.appendingPathComponent(".termloop/remote-work-items", isDirectory: true),
            includingPropertiesForKeys: nil
        )
        let taskFiles = taskDirs.map { $0.appendingPathComponent("task.md") }
        try require(taskFiles.contains(where: { FileManager.default.fileExists(atPath: $0.path) }), "task.md was not materialized")
        let taskText = try String(contentsOf: taskFiles[0], encoding: .utf8)
        try require(taskText.contains("# termloop/smoke#123"), "task.md missing title")
        try require(taskText.contains("Provider: github"), "task.md missing provider")

        print("remote-work-items smoke passed")
        print("created=\(created.reference.key)")
        print("updatedStatus=\(updated.statusLabel ?? "nil")")
        print("taskFile=\(taskFiles[0].path)")

        let jiraRoot = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("remote-work-item-jira-smoke-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: jiraRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: jiraRoot) }

        let jiraService = RemoteWorkItemService(
            providers: [FakeJiraRemoteWorkItemProvider()],
            taskFileWriter: RemoteWorkItemTaskFileWriter()
        )
        let jiraCreated = try await jiraService.create(RemoteWorkItemCreateRequest(
            provider: .jira,
            title: "Jira smoke create task",
            bodyMarkdown: "Jira smoke body",
            container: "KAN",
            issueType: "Task",
            labels: ["smoke"]
        ), projectRoot: jiraRoot)
        try require(jiraCreated.reference.key == "KAN-123", "jira create returned wrong reference")
        let jiraStatuses = try await jiraService.availableStatuses(jiraCreated.reference)
        try require(jiraStatuses.contains(where: { $0.targetState == "Done" }), "jira status options missing Done")
        let jiraDone = jiraStatuses.first { $0.targetState == "Done" } ?? jiraStatuses[0]
        let jiraUpdated = try await jiraService.updateStatus(jiraCreated.reference, to: jiraDone, projectRoot: jiraRoot)
        try require(jiraUpdated.statusLabel == "Done", "jira status update did not set Done")
        let jiraLinked = try await jiraService.link(input: "https://termloop.atlassian.net/browse/KAN-123", projectRoot: jiraRoot)
        try require(jiraLinked.reference.key == "KAN-123", "jira link parser/fetch failed")
        let jiraAssigned = try await jiraService.listAssignedToMe(RemoteWorkItemListRequest(provider: .jira, container: "KAN", limit: 10))
        try require(jiraAssigned.first?.reference.key == "KAN-456", "jira assigned list failed")
        print("jiraCreated=\(jiraCreated.reference.key)")
        print("jiraUpdatedStatus=\(jiraUpdated.statusLabel ?? "nil")")

        let csvStatuses = remoteParseStatusLabelsCSV(
            """
            Key,Status
            UKIE-1,In Progress
            UKIE-2,"Ready for Deployment"
            Key,Status
            UKIE-3,In Testing
            """,
            defaultLabels: []
        )
        try require(csvStatuses == ["In Progress", "In Testing", "Ready for Deployment"], "jira CSV status parser failed: \(csvStatuses)")

        let accounts = JiraRemoteWorkItemProvider.parseAccountsConfig(
            """
            current_profile: cloud-1:acct-1
            profiles:
              - site: https://example.atlassian.net
                email: one@example.com
                display_name: One
                cloud_id: cloud-1
                account_id: acct-1
              - site: other.atlassian.net
                email: two@example.com
                display_name: Two
                cloud_id: cloud-2
                account_id: acct-2
            """
        )
        try require(accounts.count == 2, "jira account config parser missed accounts")
        try require(accounts.first?.site == "example.atlassian.net" && accounts.first?.isCurrent == true, "jira account config parser missed current profile")

        let projects = try JiraRemoteWorkItemProvider.parseProjectOptions(
            """
            [{"key":"UKIE","name":"UKIE"},{"key":"KAN","name":"Kanban"}]
            """
        )
        try require(projects.map(\.key) == ["KAN", "UKIE"], "jira project parser failed")
    }

    private static func runLiveGitHub() async throws {
        guard let repo = ProcessInfo.processInfo.environment["REMOTE_WORK_ITEM_GITHUB_REPO"], !repo.isEmpty else {
            throw NSError(domain: "RemoteWorkItemSmoke", code: 2, userInfo: [NSLocalizedDescriptionKey: "Set REMOTE_WORK_ITEM_GITHUB_REPO=owner/repo"])
        }

        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("remote-work-item-live-smoke-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let service = RemoteWorkItemService(
            providers: [GitHubRemoteWorkItemProvider()],
            taskFileWriter: RemoteWorkItemTaskFileWriter()
        )

        let created = try await service.create(RemoteWorkItemCreateRequest(
            provider: .github,
            title: "TermLoop remote work item live smoke \(ISO8601DateFormatter().string(from: Date()))",
            bodyMarkdown: "Created by TermLoop RemoteWorkItemService live smoke. Safe to close/delete.",
            container: repo,
            labels: []
        ), projectRoot: root)
        print("created=\(created.reference.url ?? created.reference.key)")

        let fetched = try await service.fetch(created.reference)
        try require(fetched.reference.number == created.reference.number, "fetch returned wrong issue")
        print("fetched=\(fetched.reference.key)")

        let assigned = try await service.listAssignedToMe(RemoteWorkItemListRequest(provider: .github, container: repo, limit: 10))
        print("assignedCount=\(assigned.count)")

        let statuses = try await service.availableStatuses(created.reference)
        guard let close = statuses.first(where: { $0.targetState == "closed" || $0.id.contains("close") }) else {
            throw NSError(domain: "RemoteWorkItemSmoke", code: 3, userInfo: [NSLocalizedDescriptionKey: "No close status returned"])
        }

        let closed: RemoteWorkItemSnapshot
        do {
            closed = try await service.updateStatus(created.reference, to: close, projectRoot: root)
        } catch {
            fputs("created issue was left open: \(created.reference.url ?? created.reference.key)\n", stderr)
            fputs("GitHub token can create/read issues but cannot close/update them. Refresh gh auth with issue write permission, then rerun.\n", stderr)
            throw error
        }
        try require(closed.statusLabel == "closed", "status update did not close")
        print("closed=\(closed.reference.key)")

        let taskDirs = try FileManager.default.contentsOfDirectory(
            at: root.appendingPathComponent(".termloop/remote-work-items", isDirectory: true),
            includingPropertiesForKeys: nil
        )
        let taskFiles = taskDirs.map { $0.appendingPathComponent("task.md") }
        try require(taskFiles.contains(where: { FileManager.default.fileExists(atPath: $0.path) }), "task.md was not materialized")
        print("taskFile=\(taskFiles[0].path)")
        print("remote-work-items live github smoke passed")
    }

    private static func runLiveJira() async throws {
        let project = ProcessInfo.processInfo.environment["REMOTE_WORK_ITEM_JIRA_PROJECT"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let projectKey = project?.isEmpty == false ? project! : "KAN"
        let doneStatus = ProcessInfo.processInfo.environment["REMOTE_WORK_ITEM_JIRA_DONE_STATUS"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let targetStatus = doneStatus?.isEmpty == false ? doneStatus! : "Done"

        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("remote-work-item-live-jira-smoke-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let service = RemoteWorkItemService(
            providers: [JiraRemoteWorkItemProvider()],
            taskFileWriter: RemoteWorkItemTaskFileWriter()
        )

        let created = try await service.create(RemoteWorkItemCreateRequest(
            provider: .jira,
            title: "TermLoop remote work item Jira live smoke \(ISO8601DateFormatter().string(from: Date()))",
            bodyMarkdown: "Created by TermLoop RemoteWorkItemService Jira live smoke.",
            container: projectKey,
            issueType: "Task",
            labels: ["termloop-smoke"]
        ), projectRoot: root)
        print("created=\(created.reference.key)")

        let fetched = try await service.fetch(created.reference)
        try require(fetched.reference.key.uppercased() == created.reference.key.uppercased(), "fetch returned wrong Jira work item")
        print("fetched=\(fetched.reference.key)")

        let assigned = try await service.listAssignedToMe(RemoteWorkItemListRequest(provider: .jira, container: projectKey, limit: 10))
        print("assignedCount=\(assigned.count)")

        let status = RemoteWorkItemStatusOption(
            id: "jira.status.\(targetStatus.lowercased().replacingOccurrences(of: " ", with: "-"))",
            label: targetStatus,
            targetState: targetStatus,
            providerPayload: ["targetStatusLabel": targetStatus]
        )
        let updated = try await service.updateStatus(created.reference, to: status, projectRoot: root)
        try require(updated.statusLabel?.lowercased() == targetStatus.lowercased(), "status update did not set \(targetStatus)")
        print("updatedStatus=\(updated.statusLabel ?? "nil")")

        let taskDirs = try FileManager.default.contentsOfDirectory(
            at: root.appendingPathComponent(".termloop/remote-work-items", isDirectory: true),
            includingPropertiesForKeys: nil
        )
        let taskFiles = taskDirs.map { $0.appendingPathComponent("task.md") }
        try require(taskFiles.contains(where: { FileManager.default.fileExists(atPath: $0.path) }), "task.md was not materialized")
        print("taskFile=\(taskFiles[0].path)")
        print("remote-work-items live jira smoke passed")
    }

    private static func runLiveJiraAssigned() async throws {
        let project = ProcessInfo.processInfo.environment["REMOTE_WORK_ITEM_JIRA_PROJECT"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let projectKey = project?.isEmpty == false ? project! : "KAN"
        let limitText = ProcessInfo.processInfo.environment["REMOTE_WORK_ITEM_LIST_LIMIT"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let limit = Int(limitText ?? "") ?? 10

        let service = RemoteWorkItemService(
            providers: [JiraRemoteWorkItemProvider()],
            taskFileWriter: RemoteWorkItemTaskFileWriter()
        )
        let assigned = try await service.listAssignedToMe(RemoteWorkItemListRequest(provider: .jira, container: projectKey, limit: limit))
        print("assignedCount=\(assigned.count)")
        for item in assigned {
            print("\(item.reference.key)\t\(item.statusLabel ?? "-")\t\(item.title)")
        }
        print("remote-work-items live jira assigned list passed")
    }

    private static func runLiveJiraStatuses() async throws {
        let project = ProcessInfo.processInfo.environment["REMOTE_WORK_ITEM_JIRA_PROJECT"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let projectKey = project?.isEmpty == false ? project! : "KAN"
        let provider = JiraRemoteWorkItemProvider()
        let labels = try await provider.statusLabels(projectKey: projectKey)
        try require(!labels.isEmpty, "jira status list returned no statuses")
        print("statusCount=\(labels.count)")
        for label in labels {
            print(label)
        }
        print("remote-work-items live jira statuses passed")
    }

    private static func friendlyDescription(_ error: Error) -> String {
        if let remoteError = error as? RemoteWorkItemError {
            switch remoteError {
            case .commandFailed(let message):
                return message
            case .parseFailed(let message), .unsupportedReference(let message):
                return message
            case .unsupportedProvider(let provider):
                return "unsupported provider: \(provider.rawValue)"
            }
        }
        return error.localizedDescription
    }
}

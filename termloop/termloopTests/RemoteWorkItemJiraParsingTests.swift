import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class RemoteWorkItemJiraParsingTests: XCTestCase {
    func testJiraCommandGateSerializesAuthSwitchWithCommand() async throws {
        let runner = RecordingRemoteWorkItemCommandRunner()

        async let first = JiraCommandGate.shared.run(
            site: "first.atlassian.net",
            email: "first@example.com",
            arguments: ["jira", "workitem", "search", "--jql", "project = ONE"],
            timeout: 1,
            runner: runner
        )
        async let second = JiraCommandGate.shared.run(
            site: "second.atlassian.net",
            email: "second@example.com",
            arguments: ["jira", "workitem", "search", "--jql", "project = TWO"],
            timeout: 1,
            runner: runner
        )

        _ = try await [first, second]
        let calls = await runner.callsSnapshot()

        XCTAssertEqual(calls.count, 4)
        XCTAssertTrue(calls[0].starts(with: ["jira", "auth", "switch"]))
        XCTAssertTrue(calls[1].starts(with: ["jira", "workitem", "search"]))
        XCTAssertTrue(calls[2].starts(with: ["jira", "auth", "switch"]))
        XCTAssertTrue(calls[3].starts(with: ["jira", "workitem", "search"]))
        XCTAssertEqual(
            Set([calls[0].siteArgument, calls[2].siteArgument].compactMap { $0 }),
            Set(["first.atlassian.net", "second.atlassian.net"])
        )
    }

    func testCommandRunnerDrainsLargeStdoutBeforeProcessExit() async throws {
        let result = try await RemoteWorkItemCommandRunner.shared.run(
            executable: "awk",
            arguments: ["BEGIN { for (i = 0; i < 200000; i++) printf \"x\" }"],
            cwd: nil,
            timeout: 5
        )

        XCTAssertEqual(result.exitStatus, 0)
        XCTAssertFalse(result.timedOut)
        XCTAssertEqual(result.stdout.count, 200_000)
        XCTAssertEqual(result.stderr, "")
    }

    func testCSVStatusParserUsesStatusColumnAndSkipsRepeatedHeaders() {
        let labels = remoteParseStatusLabelsCSV(
            """
            Key,Status
            UKIE-1,In Progress
            UKIE-2,"Ready for Deployment"
            Key,Status
            UKIE-3,In Testing
            """,
            defaultLabels: []
        )

        XCTAssertEqual(labels, ["In Progress", "In Testing", "Ready for Deployment"])
    }

    func testJiraAccountConfigParserNormalizesSiteAndCurrentProfile() {
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

        XCTAssertEqual(accounts.count, 2)
        XCTAssertEqual(accounts.first?.site, "example.atlassian.net")
        XCTAssertEqual(accounts.first?.email, "one@example.com")
        XCTAssertEqual(accounts.first?.isCurrent, true)
    }

    func testJiraProjectParserSortsAndDeduplicatesProjects() throws {
        let projects = try JiraRemoteWorkItemProvider.parseProjectOptions(
            """
            [
              {"key":"UKIE","name":"UKIE"},
              {"key":"KAN","name":"Kanban"},
              {"key":"UKIE","name":"Duplicate"}
            ]
            """
        )

        XCTAssertEqual(projects.map(\.key), ["KAN", "UKIE"])
        XCTAssertEqual(projects.first?.displayLabel, "KAN — Kanban")
    }
}

private actor RecordingRemoteWorkItemCommandRunner: RemoteWorkItemCommandRunning {
    private var calls: [[String]] = []

    func run(
        executable: String,
        arguments: [String],
        cwd: String?,
        timeout: TimeInterval
    ) async throws -> RemoteWorkItemCommandResult {
        calls.append(arguments)
        if arguments.starts(with: ["jira", "auth", "switch"]) {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return RemoteWorkItemCommandResult(
            exitStatus: 0,
            stdout: "[]",
            stderr: "",
            timedOut: false
        )
    }

    func callsSnapshot() -> [[String]] {
        calls
    }
}

private extension Array where Element == String {
    var siteArgument: String? {
        guard let index = firstIndex(of: "--site") else { return nil }
        let next = self.index(after: index)
        guard indices.contains(next) else { return nil }
        return self[next]
    }
}

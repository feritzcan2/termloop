import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class RemoteWorkItemJiraParsingTests: XCTestCase {
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

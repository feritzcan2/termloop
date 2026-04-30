import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class TaskModelTests: XCTestCase {
    func test_taskCodableRoundtrip_preservesAllFields() throws {
        let task = TermLoopTask(
            id: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
            projectId: UUID(uuidString: "22222222-2222-2222-2222-222222222222")!,
            title: "Add org switcher",
            branch: "feat/onboarding-142",
            worktreePath: "/tmp/.termloop-worktrees/feat-onboarding-142",
            status: .active,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_500),
            externalLink: TermLoopTask.ExternalLink(
                url: URL(string: "https://acme.atlassian.net/browse/ONBOARDING-142")!,
                provider: .jira,
                ticketKey: "ONBOARDING-142"
            ),
            helperAgentId: "claude",
            prInfo: TermLoopTask.PRInfo(
                url: URL(string: "https://github.com/acme/repo/pull/1234")!,
                number: 1234,
                state: .open,
                title: "Add org switcher"
            ),
            mergeState: TermLoopTask.MergeState(mergedInto: ["dev"], aheadBy: 4, behindBy: 0),
            lastSyncedAt: Date(timeIntervalSince1970: 1_700_000_600),
            lastSyncError: nil
        )

        let data = try JSONEncoder().encode(task)
        let decoded = try JSONDecoder().decode(TermLoopTask.self, from: data)

        XCTAssertEqual(decoded, task)
    }

    func test_taskDecoding_defaultsMergeStateWhenMissing() throws {
        let json = """
        {
            "id": "11111111-1111-1111-1111-111111111111",
            "projectId": "22222222-2222-2222-2222-222222222222",
            "title": "Legacy task",
            "branch": "feat/legacy",
            "worktreePath": "/tmp/x",
            "status": "idle",
            "createdAt": 1700000000,
            "updatedAt": 1700000000,
            "mergeState": {"mergedInto": []}
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(TermLoopTask.self, from: json)
        XCTAssertEqual(decoded.status, .idle)
        XCTAssertEqual(decoded.mergeState.mergedInto, [])
        XCTAssertNil(decoded.externalLink)
        XCTAssertNil(decoded.helperAgentId)
    }
}

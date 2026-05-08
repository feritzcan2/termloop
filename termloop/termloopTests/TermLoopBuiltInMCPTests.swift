import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class TermLoopBuiltInMCPTests: XCTestCase {
    func testConfigEntryCarriesAskToLaunchEnvironment() throws {
        let workspaceId = UUID().uuidString
        let entry = TermLoopBuiltInMCP.configEntry(
            workspaceId: workspaceId,
            launchEnvironment: [
                "TERMLOOP_ASK_TO_REQUEST_ID": " request-id ",
                "TERMLOOP_ASK_TO_REPLY_TOKEN": " reply-token ",
                "UNRELATED": "ignored"
            ]
        )

        let env = try XCTUnwrap(entry["env"] as? [String: String])
        XCTAssertEqual(env["TERMLOOP_WORKSPACE_ID"], workspaceId)
        XCTAssertEqual(env["TERMLOOP_ASK_TO_REQUEST_ID"], "request-id")
        XCTAssertEqual(env["TERMLOOP_ASK_TO_REPLY_TOKEN"], "reply-token")
        XCTAssertNil(env["UNRELATED"])

        let args = try XCTUnwrap(entry["args"] as? [String])
        let shellCommand = try XCTUnwrap(args.last)
        XCTAssertTrue(shellCommand.contains("TERMLOOP_WORKSPACE_ID='\(workspaceId)'"))
        XCTAssertTrue(shellCommand.contains("TERMLOOP_ASK_TO_REQUEST_ID='request-id'"))
        XCTAssertTrue(shellCommand.contains("TERMLOOP_ASK_TO_REPLY_TOKEN='reply-token'"))
        XCTAssertTrue(shellCommand.contains("exec "))
        XCTAssertFalse(shellCommand.contains("command -v termloop"))
    }
}

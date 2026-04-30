import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class AgentSocketCommandsTests: XCTestCase {
    @MainActor
    func testTemplateListEmpty() {
        // Uses AgentEngine.shared. We can't easily inject; test that the method
        // returns an .ok with a "templates" array key.
        guard case .ok(let payload) = AgentSocketCommands.templateList([:]) else {
            return XCTFail("expected ok")
        }
        let dict = payload as? [String: Any]
        XCTAssertNotNil(dict?["templates"])
    }

    @MainActor
    func testTemplateGetNotFound() {
        guard case .err(let code, _, _) = AgentSocketCommands.templateGet(["id": "nope"])
        else { return XCTFail("expected err") }
        XCTAssertEqual(code, "AGENT_TEMPLATE_NOT_FOUND")
    }

    @MainActor
    func testTemplateGetMissingParam() {
        guard case .err(let code, _, _) = AgentSocketCommands.templateGet([:])
        else { return XCTFail("expected err") }
        XCTAssertEqual(code, "invalid_params")
    }

    @MainActor
    func testTcpRejectsWriteMethods() {
        let r = TermLoopSocketCommands.handle(
            method: "agent.instance.attach",
            params: ["template_id": "x", "repo_root_path": "/tmp/repo"],
            isTcpClient: true
        )
        guard case .err(let code, _, _) = r else { return XCTFail("expected err") }
        XCTAssertEqual(code, "forbidden")
    }

    @MainActor
    func testTcpAllowsReadMethods() {
        let r = TermLoopSocketCommands.handle(
            method: "agent.template.list",
            params: [:], isTcpClient: true
        )
        guard case .ok = r else { return XCTFail("expected ok") }
    }
}

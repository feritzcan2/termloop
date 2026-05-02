import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class AgentTemplateTests: XCTestCase {
    private func fixtureURL(_ name: String) -> URL {
        Bundle(for: Self.self).url(forResource: name, withExtension: "md",
            subdirectory: "Fixtures/AgentTemplates")!
    }

    func testLoadsValidTemplate() throws {
        let url = fixtureURL("valid-save")
        let tpl = try AgentTemplate.load(from: url, source: .user)
        XCTAssertEqual(tpl.id, "save-agent")
        XCTAssertEqual(tpl.name, "Save Agent")
        XCTAssertEqual(tpl.scope, .workspace)
        XCTAssertEqual(tpl.permissionMode, .auto)
        XCTAssertEqual(tpl.lifecycle, .detached)
        XCTAssertEqual(tpl.logging, .file)
        XCTAssertEqual(tpl.triggers, [.manual, .onWorkspaceClose])
        XCTAssertTrue(tpl.defaultAttach)
        XCTAssertNil(tpl.agentId)
        XCTAssertEqual(tpl.model, .sonnet)
        XCTAssertNil(tpl.reasoning)
        XCTAssertEqual(tpl.cleanup, .none)
        XCTAssertEqual(tpl.variables, ["branch_name", "workspace_path"])
        XCTAssertEqual(tpl.timeoutSeconds, 300)
        XCTAssertEqual(tpl.body, "Prompt body here.\nLine two.")
        XCTAssertEqual(tpl.source, .user)
    }

    func testMissingIDThrows() {
        let url = fixtureURL("invalid-missing-id")
        XCTAssertThrowsError(try AgentTemplate.load(from: url, source: .user)) { err in
            guard case AgentTemplate.ParseError.missingField("id") = err else {
                return XCTFail("wrong error: \(err)")
            }
        }
    }

    func testInvalidScopeThrows() throws {
        let text = "---\nid: x\nname: X\nscope: galactic\n---\nbody"
        XCTAssertThrowsError(try AgentTemplate.parse(text: text,
            sourceURL: URL(fileURLWithPath: "/tmp/x.md"), source: .user))
    }

    func testDefaultsFillWhenOmitted() throws {
        let text = "---\nid: bare\nname: Bare\n---\nbody"
        let tpl = try AgentTemplate.parse(text: text,
            sourceURL: URL(fileURLWithPath: "/tmp/bare.md"), source: .user)
        XCTAssertEqual(tpl.scope, .workspace)
        XCTAssertEqual(tpl.permissionMode, .ask)
        XCTAssertEqual(tpl.lifecycle, .detached)
        XCTAssertEqual(tpl.logging, .file)
        XCTAssertEqual(tpl.triggers, [.manual])
        XCTAssertFalse(tpl.defaultAttach)
        XCTAssertNil(tpl.agentId)
        XCTAssertEqual(tpl.model, .default)
        XCTAssertNil(tpl.reasoning)
        XCTAssertEqual(tpl.cleanup, .none)
        XCTAssertEqual(tpl.variables, [])
        XCTAssertEqual(tpl.timeoutSeconds, 600)
    }
}

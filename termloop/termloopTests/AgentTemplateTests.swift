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

    @MainActor
    func testAskToHelperInstructionsAreBuiltinPromptDocuments() {
        let docs = AgentPromptStore.loadDocuments(projectDir: nil).documents
        let doc = docs.first {
            $0.id == AgentPromptStore.askToHelperInstructionsDocumentID(.claude)
        }

        XCTAssertEqual(doc?.kind, .bridgeTargetPrompt)
        XCTAssertEqual(doc?.scope, .builtin)
        XCTAssertTrue(doc?.body.contains("{{target_name}}") == true)
        XCTAssertFalse(doc?.body.contains("reply_to_request") == true)
    }

    @MainActor
    func testAskToHelperPromptKeepsProtocolOutsideEditableTemplate() {
        let requestId = UUID()
        let prompt = BridgeHelperSystemPrompt.compose(
            requestId: requestId,
            target: .claude,
            userOverride: "Extra reviewer guidance.",
            projectFolderPath: nil
        )

        XCTAssertTrue(prompt.contains("Answer the incoming Ask-To request directly"))
        XCTAssertTrue(prompt.contains("Claude"))
        XCTAssertTrue(prompt.contains("reply_to_request"))
        XCTAssertTrue(prompt.contains(requestId.uuidString))
        XCTAssertTrue(prompt.contains("Extra reviewer guidance."))
    }

    @MainActor
    func testAskToHelperPromptUsesProjectOverrideButKeepsProtocol() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("AskToHelperPromptTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        guard let promptsDir = AgentPromptStore.projectPromptsDir(projectFolderPath: root.path) else {
            return XCTFail("Expected project prompts dir")
        }
        try AgentPromptStore.saveProjectDocument(
            id: AgentPromptStore.askToHelperInstructionsDocumentID(.codex),
            title: "Project Ask-To Helper",
            kind: .bridgeTargetPrompt,
            subtitle: "Project override",
            body: "Custom helper for {{target_name}} / {{target_agent}}.",
            projectDir: promptsDir
        )

        let requestId = UUID()
        let prompt = BridgeHelperSystemPrompt.compose(
            requestId: requestId,
            target: .codex,
            userOverride: "Extra guard.",
            projectFolderPath: root.path
        )

        XCTAssertTrue(prompt.contains("Custom helper for Codex / codex."))
        XCTAssertFalse(prompt.contains("No preamble"))
        XCTAssertTrue(prompt.contains("reply_to_request"))
        XCTAssertTrue(prompt.contains(requestId.uuidString))
        XCTAssertTrue(prompt.contains("Extra guard."))
    }
}

// termloop/termloopTests/BridgeCreationValidatorTests.swift
import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class BridgeCreationValidatorTests: XCTestCase {
    private func ws(projectId: UUID, agent: String = "claude") -> (UUID, WorkspaceMetadataStore.Metadata) {
        let id = UUID()
        var meta = WorkspaceMetadataStore.Metadata()
        meta.projectId = projectId
        meta.terminalAgentId = agent
        return (id, meta)
    }

    func testSameProjectTwoClaudesIsOk() {
        let proj = UUID()
        let (a, aMeta) = ws(projectId: proj)
        let (b, bMeta) = ws(projectId: proj)
        let result = BridgeCreationValidator.validate(
            source: a, target: b,
            metadata: { [a: aMeta, b: bMeta][$0] ?? WorkspaceMetadataStore.Metadata() },
            existingBridgeFor: { _ in nil }
        )
        if case .ok = result { /* pass */ } else { XCTFail("expected .ok, got \(result)") }
    }

    func testCrossProjectRejected() {
        let (a, aMeta) = ws(projectId: UUID())
        let (b, bMeta) = ws(projectId: UUID())
        let result = BridgeCreationValidator.validate(
            source: a, target: b,
            metadata: { [a: aMeta, b: bMeta][$0] ?? WorkspaceMetadataStore.Metadata() },
            existingBridgeFor: { _ in nil }
        )
        if case .error(.differentProjects) = result { /* pass */ } else { XCTFail("expected differentProjects, got \(result)") }
    }

    func testNonClaudeAgentRejected() {
        let proj = UUID()
        let (a, aMeta) = ws(projectId: proj)
        let (b, bMeta) = ws(projectId: proj, agent: "codex")
        let result = BridgeCreationValidator.validate(
            source: a, target: b,
            metadata: { [a: aMeta, b: bMeta][$0] ?? WorkspaceMetadataStore.Metadata() },
            existingBridgeFor: { _ in nil }
        )
        if case .error(.unsupportedAgent) = result { /* pass */ } else { XCTFail("expected unsupportedAgent, got \(result)") }
    }

    func testAskAgentAllowsClaudeToCodex() {
        let proj = UUID()
        let (a, aMeta) = ws(projectId: proj, agent: "claude")
        let (b, bMeta) = ws(projectId: proj, agent: "codex")
        let result = BridgeCreationValidator.validate(
            intent: .askAgent,
            source: a, target: b,
            metadata: { [a: aMeta, b: bMeta][$0] ?? WorkspaceMetadataStore.Metadata() },
            existingBridgeFor: { _ in nil }
        )
        if case .ok = result { /* pass */ } else { XCTFail("expected .ok, got \(result)") }
    }

    func testAskAgentAllowsClaudeToClaude() {
        let proj = UUID()
        let (a, aMeta) = ws(projectId: proj, agent: "claude")
        let (b, bMeta) = ws(projectId: proj, agent: "claude")
        let result = BridgeCreationValidator.validate(
            intent: .askAgent,
            source: a, target: b,
            metadata: { [a: aMeta, b: bMeta][$0] ?? WorkspaceMetadataStore.Metadata() },
            existingBridgeFor: { _ in nil }
        )
        if case .ok = result { /* pass */ } else { XCTFail("expected .ok, got \(result)") }
    }

    func testAskAgentAllowsCodexToClaude() {
        let proj = UUID()
        let (a, aMeta) = ws(projectId: proj, agent: "codex")
        let (b, bMeta) = ws(projectId: proj, agent: "claude")
        let result = BridgeCreationValidator.validate(
            intent: .askAgent,
            source: a, target: b,
            metadata: { [a: aMeta, b: bMeta][$0] ?? WorkspaceMetadataStore.Metadata() },
            existingBridgeFor: { _ in nil }
        )
        if case .ok = result { /* pass */ } else { XCTFail("expected .ok, got \(result)") }
    }

    func testAlreadyBridgedRejected() {
        let proj = UUID()
        let (a, aMeta) = ws(projectId: proj)
        let (b, bMeta) = ws(projectId: proj)
        let dummy = WorkspaceBridge(
            leftWorkspaceId: a, rightWorkspaceId: UUID(),
            kickoffMessage: "x", firstSpeaker: .left
        )
        let result = BridgeCreationValidator.validate(
            source: a, target: b,
            metadata: { [a: aMeta, b: bMeta][$0] ?? WorkspaceMetadataStore.Metadata() },
            existingBridgeFor: { $0 == a ? dummy : nil }
        )
        if case .error(.alreadyBridged) = result { /* pass */ } else { XCTFail("expected alreadyBridged, got \(result)") }
    }

    func testSameWorkspaceRejected() {
        let proj = UUID()
        let (a, aMeta) = ws(projectId: proj)
        let result = BridgeCreationValidator.validate(
            source: a, target: a,
            metadata: { _ in aMeta },
            existingBridgeFor: { _ in nil }
        )
        if case .error(.sameWorkspace) = result { /* pass */ } else { XCTFail("expected sameWorkspace, got \(result)") }
    }
}

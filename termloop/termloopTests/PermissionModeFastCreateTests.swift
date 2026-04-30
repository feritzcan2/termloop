import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class PermissionModeFastCreateTests: XCTestCase {
    func test_suggestedAgentWorkspaceName_emptyFolder_returnsBareAgent() {
        let name = SidebarInlineCreateCoordinator.suggestedAgentWorkspaceName(
            agentId: "claude",
            existingTitlesInProject: []
        )
        XCTAssertEqual(name, "claude")
    }

    func test_suggestedAgentWorkspaceName_otherAgentPresent_returnsBareAgent() {
        let name = SidebarInlineCreateCoordinator.suggestedAgentWorkspaceName(
            agentId: "claude",
            existingTitlesInProject: ["codex", "codex (2)"]
        )
        XCTAssertEqual(name, "claude")
    }

    func test_suggestedAgentWorkspaceName_oneClaude_returns_claude_2() {
        let name = SidebarInlineCreateCoordinator.suggestedAgentWorkspaceName(
            agentId: "claude",
            existingTitlesInProject: ["claude"]
        )
        XCTAssertEqual(name, "claude (2)")
    }

    func test_suggestedAgentWorkspaceName_skipsTakenCounters() {
        let name = SidebarInlineCreateCoordinator.suggestedAgentWorkspaceName(
            agentId: "claude",
            existingTitlesInProject: ["claude", "claude (2)", "claude (3)"]
        )
        XCTAssertEqual(name, "claude (4)")
    }

    func test_suggestedAgentWorkspaceName_caseInsensitiveMatch() {
        let name = SidebarInlineCreateCoordinator.suggestedAgentWorkspaceName(
            agentId: "Claude",
            existingTitlesInProject: ["CLAUDE", "claude (2)"]
        )
        XCTAssertEqual(name, "Claude (3)")
    }

    func test_suggestedAgentWorkspaceName_gapInSequenceFillsLowest() {
        let name = SidebarInlineCreateCoordinator.suggestedAgentWorkspaceName(
            agentId: "claude",
            existingTitlesInProject: ["claude", "claude (3)"]
        )
        XCTAssertEqual(name, "claude (2)")
    }

    func test_permissionModeMetadata_roundTrips() {
        let store = WorkspaceMetadataStore.shared
        let id = UUID()
        defer { store.setPermissionMode(nil, for: id) }
        XCTAssertNil(store.permissionMode(for: id))
        store.setPermissionMode("plan", for: id)
        XCTAssertEqual(store.permissionMode(for: id), "plan")
        store.setPermissionMode(nil, for: id)
        XCTAssertNil(store.permissionMode(for: id))
        store.setPermissionMode("   ", for: id)
        XCTAssertNil(store.permissionMode(for: id), "blank input should normalize to nil")
    }

    func test_permissionModeCatalog_claudeSurfaces_threeModes() {
        let modes = PermissionModeCatalog.surfaceableModes(forAgentId: "claude")
        XCTAssertEqual(modes.map(\.mode), [.bypassPermissions, .plan, .acceptEdits])
        XCTAssertNil(modes.first { $0.mode == .default })
    }

    func test_permissionModeCatalog_codexSurfaces_threeModes() {
        let modes = PermissionModeCatalog.surfaceableModes(forAgentId: "codex")
        XCTAssertEqual(modes.map(\.mode), [.bypassPermissions, .plan, .acceptEdits])
    }

    func test_permissionModeCatalog_unknownAgent_isEmpty() {
        XCTAssertTrue(PermissionModeCatalog.surfaceableModes(forAgentId: "gemini").isEmpty)
        XCTAssertTrue(PermissionModeCatalog.surfaceableModes(forAgentId: "totally-made-up").isEmpty)
    }

    func test_permissionModePersistence_resolveLaunchMode_fallsBackToCatalogFirst() {
        let agentId = "claude-test-\(UUID().uuidString)"
        let resolved = PermissionModePersistence.resolveLaunchMode(forAgentId: agentId)
        XCTAssertEqual(resolved, .bypassPermissions, "unknown agent → legacy bypass default")

        // After last-used set, that one wins on resolve.
        PermissionModePersistence.setLastUsedMode(.plan, forAgentId: agentId)
        XCTAssertEqual(
            PermissionModePersistence.resolveLaunchMode(forAgentId: agentId),
            .plan
        )
        // Cleanup so the test is hermetic.
        UserDefaults.standard.removeObject(forKey: "termloop.lastMode." + agentId)
    }
}

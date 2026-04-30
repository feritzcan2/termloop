import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class WorkspaceAgentMigrationTests: XCTestCase {
    func testAssignsDefaultWhenMissing() {
        let wsId = UUID()
        TermLoopSettings.shared.defaultTerminalAgentId = "claude"
        // Seed metadata without a terminalAgentId by touching another field.
        WorkspaceMetadataStore.shared.setBranch("main", forWorkspaceId: wsId)
        XCTAssertNil(WorkspaceMetadataStore.shared.terminalAgentId(for: wsId))

        let migrated = WorkspaceAgentMigration.runIfNeeded()
        XCTAssertTrue(migrated.contains(wsId))
        XCTAssertEqual(WorkspaceMetadataStore.shared.terminalAgentId(for: wsId), "claude")
    }

    func testIdempotent() {
        let wsId = UUID()
        WorkspaceMetadataStore.shared.setTerminalAgentId("codex", for: wsId)
        let migrated = WorkspaceAgentMigration.runIfNeeded()
        XCTAssertFalse(migrated.contains(wsId))
        XCTAssertEqual(WorkspaceMetadataStore.shared.terminalAgentId(for: wsId), "codex")
    }
}

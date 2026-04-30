import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class WorkspaceMetadataStoreTerminalAgentTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        WorkspaceMetadataStore.shared.restore([:])
    }

    func testSetAndGet() {
        let store = WorkspaceMetadataStore.shared
        let id = UUID()
        store.setTerminalAgentId("claude", for: id)
        XCTAssertEqual(store.terminalAgentId(for: id), "claude")
        store.setTerminalAgentId("codex", for: id)
        XCTAssertEqual(store.terminalAgentId(for: id), "codex")
    }

    func testSnapshotRoundTrip() throws {
        let store = WorkspaceMetadataStore.shared
        let id = UUID()
        store.setTerminalAgentId("opencode", for: id)
        let snap = store.snapshot()
        let encoded = try JSONEncoder().encode(snap)
        let decoded = try JSONDecoder().decode([String: WorkspaceMetadataStore.Metadata].self, from: encoded)
        XCTAssertEqual(decoded[id.uuidString]?.terminalAgentId, "opencode")
    }

}

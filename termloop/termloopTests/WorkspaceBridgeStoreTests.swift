import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class WorkspaceBridgeStoreTests: XCTestCase {
    /// Shared project UUID so all test workspaces satisfy the same-project check.
    private let testProjectId = UUID()

    /// Creates a bridge whose workspace IDs are pre-registered in
    /// WorkspaceMetadataStore with matching projectId and agent "claude",
    /// satisfying BridgeCreationValidator so store.add() succeeds.
    private func makeBridge() -> WorkspaceBridge {
        let left = UUID()
        let right = UUID()
        // Register metadata for both sides so the validator approves them.
        WorkspaceMetadataStore.shared.setTerminalAgentId("claude", for: left)
        WorkspaceMetadataStore.shared.setTerminalAgentId("claude", for: right)
        WorkspaceMetadataStore.shared.setProjectId(testProjectId, forWorkspaceId: left)
        WorkspaceMetadataStore.shared.setProjectId(testProjectId, forWorkspaceId: right)
        return WorkspaceBridge(
            leftWorkspaceId: left,
            rightWorkspaceId: right,
            kickoffMessage: "test",
            firstSpeaker: .left
        )
    }

    func testCreateAddsToBridges() {
        let store = WorkspaceBridgeStore()
        XCTAssertTrue(store.bridges.isEmpty)
        let bridge = makeBridge()
        store.add(bridge)
        XCTAssertEqual(store.bridges.count, 1)
        XCTAssertEqual(store.bridges.first?.id, bridge.id)
    }

    func testSetForwardModeUpdatesMode() {
        let store = WorkspaceBridgeStore()
        let bridge = makeBridge()
        store.add(bridge)
        store.setForwardMode(id: bridge.id, mode: .auto)
        XCTAssertEqual(store.bridge(id: bridge.id)?.effectiveForwardMode, .auto)
    }


    func testStopSetsReason() {
        let store = WorkspaceBridgeStore()
        let bridge = makeBridge()
        store.add(bridge)
        store.stop(id: bridge.id, reason: .manual)
        XCTAssertEqual(store.bridge(id: bridge.id)?.state, .stopped(.manual))
    }

    func testAppendMessageIncrementsTurnCount() {
        let store = WorkspaceBridgeStore()
        let bridge = makeBridge()
        store.add(bridge)
        store.appendMessage(
            bridgeId: bridge.id,
            sender: .left,
            text: "hello"
        )
        let updated = store.bridge(id: bridge.id)
        XCTAssertEqual(updated?.messages.count, 1)
        XCTAssertEqual(updated?.messages.first?.text, "hello")
    }


    func testDismissRemovesBridge() {
        let store = WorkspaceBridgeStore()
        let bridge = makeBridge()
        store.add(bridge)
        store.dismiss(id: bridge.id)
        XCTAssertTrue(store.bridges.isEmpty)
    }

    func testOverviewVersionIgnoresTranscriptAppends() {
        let store = WorkspaceBridgeStore()
        let bridge = makeBridge()
        let initialVersion = store.overviewVersion
        store.add(bridge)
        let afterAdd = store.overviewVersion
        XCTAssertEqual(afterAdd, initialVersion + 1)

        store.appendMessage(
            bridgeId: bridge.id,
            sender: .left,
            text: "hello"
        )
        XCTAssertEqual(store.overviewVersion, afterAdd)

        store.setForwardMode(id: bridge.id, mode: .auto)
        XCTAssertEqual(store.overviewVersion, afterAdd + 1)
    }

    func testAppendMessageCapsTranscriptHistory() {
        let store = WorkspaceBridgeStore()
        let bridge = makeBridge()
        store.add(bridge)

        for idx in 0..<55 {
            store.appendMessage(
                bridgeId: bridge.id,
                sender: .left,
                text: "m\(idx)"
            )
        }

        let updated = store.bridge(id: bridge.id)
        XCTAssertEqual(updated?.messages.count, 40)
        XCTAssertEqual(updated?.messages.first?.text, "m15")
        XCTAssertEqual(updated?.messages.last?.text, "m54")
    }

    func testBridgeForWorkspaceFindsByEitherSide() {
        let store = WorkspaceBridgeStore()
        let bridge = makeBridge()
        store.add(bridge)
        XCTAssertEqual(
            store.bridge(forWorkspaceId: bridge.leftWorkspaceId)?.id,
            bridge.id
        )
        XCTAssertEqual(
            store.bridge(forWorkspaceId: bridge.rightWorkspaceId)?.id,
            bridge.id
        )
    }

    func testCannotAddSecondBridgeToSameWorkspace() {
        let store = WorkspaceBridgeStore()
        let a = makeBridge()
        store.add(a)
        let b = WorkspaceBridge(
            leftWorkspaceId: a.leftWorkspaceId,  // same left!
            rightWorkspaceId: UUID(),
            kickoffMessage: "b",
            firstSpeaker: .left
        )
        let added = store.add(b)
        XCTAssertFalse(added)
        XCTAssertEqual(store.bridges.count, 1)
    }

}

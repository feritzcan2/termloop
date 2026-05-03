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
    private var temporaryStoreURLs: [URL] = []

    override func tearDown() {
        for url in temporaryStoreURLs {
            try? FileManager.default.removeItem(at: url)
        }
        temporaryStoreURLs.removeAll()
        super.tearDown()
    }

    private func makeStore() -> WorkspaceBridgeStore {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("WorkspaceBridgeStoreTests-\(UUID().uuidString).json")
        temporaryStoreURLs.append(url)
        return WorkspaceBridgeStore(fileURL: url)
    }

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
        let store = makeStore()
        XCTAssertTrue(store.bridges.isEmpty)
        let bridge = makeBridge()
        store.add(bridge)
        XCTAssertEqual(store.bridges.count, 1)
        XCTAssertEqual(store.bridges.first?.id, bridge.id)
    }

    func testAskToReplyTokenPersistsAcrossStoreReload() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("WorkspaceBridgeStoreTests-\(UUID().uuidString).json")
        temporaryStoreURLs.append(url)
        let store = WorkspaceBridgeStore(fileURL: url)
        var bridge = makeBridge()
        bridge.intent = .askAgent
        bridge.askToReplyToken = "reply-token"

        XCTAssertTrue(store.add(bridge))

        let reloaded = WorkspaceBridgeStore(fileURL: url)
        XCTAssertEqual(reloaded.bridge(id: bridge.id)?.askToReplyToken, "reply-token")
    }

    func testSetForwardModeUpdatesMode() {
        let store = makeStore()
        let bridge = makeBridge()
        store.add(bridge)
        store.setForwardMode(id: bridge.id, mode: .auto)
        XCTAssertEqual(store.bridge(id: bridge.id)?.effectiveForwardMode, .auto)
    }


    func testStopSetsReason() {
        let store = makeStore()
        let bridge = makeBridge()
        store.add(bridge)
        store.stop(id: bridge.id, reason: .manual)
        XCTAssertEqual(store.bridge(id: bridge.id)?.state, .stopped(.manual))
    }

    func testAppendMessageIncrementsTurnCount() {
        let store = makeStore()
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

    func testRecordFinalReplyStopsAskAgentBridgeAndStoresSingleReply() {
        let store = makeStore()
        var bridge = makeBridge()
        bridge.intent = .askAgent
        bridge.rightAgentId = "codex"
        store.add(bridge)

        let result = store.recordFinalReply(
            bridgeId: bridge.id,
            text: "final answer"
        )

        guard case .recorded(let messageId) = result else {
            return XCTFail("Expected final reply to be recorded")
        }
        let updated = store.bridge(id: bridge.id)
        XCTAssertEqual(updated?.state, .stopped(.replied))
        XCTAssertEqual(updated?.messages.count, 1)
        XCTAssertEqual(updated?.messages.first?.id, messageId)
        XCTAssertEqual(updated?.messages.first?.sender, .right)
        XCTAssertEqual(updated?.messages.first?.text, "final answer")
        XCTAssertEqual(updated?.finalReply?.messageId, messageId)
        XCTAssertEqual(updated?.finalReply?.text, "final answer")
    }

    func testRecordFinalReplyRejectsDuplicateReply() {
        let store = makeStore()
        var bridge = makeBridge()
        bridge.intent = .askAgent
        bridge.rightAgentId = "codex"
        store.add(bridge)

        let first = store.recordFinalReply(bridgeId: bridge.id, text: "one")
        let second = store.recordFinalReply(bridgeId: bridge.id, text: "two")

        guard case .recorded = first else {
            return XCTFail("Expected first final reply to be recorded")
        }
        XCTAssertEqual(second, .alreadyReplied)
        XCTAssertEqual(store.bridge(id: bridge.id)?.messages.map(\.text), ["one"])
    }

    func testRepliedAskAgentBridgeDoesNotBlockFollowUpRequest() {
        let store = makeStore()
        var first = makeBridge()
        first.intent = .askAgent
        first.leftAgentId = "codex"
        first.rightAgentId = "claude"
        XCTAssertTrue(store.add(first))
        guard case .recorded = store.recordFinalReply(bridgeId: first.id, text: "done") else {
            return XCTFail("Expected first final reply to be recorded")
        }

        let newRight = UUID()
        WorkspaceMetadataStore.shared.setTerminalAgentId("claude", for: newRight)
        WorkspaceMetadataStore.shared.setProjectId(testProjectId, forWorkspaceId: newRight)
        let second = WorkspaceBridge(
            leftWorkspaceId: first.leftWorkspaceId,
            rightWorkspaceId: newRight,
            intent: .askAgent,
            leftAgentId: "codex",
            rightAgentId: "claude",
            kickoffMessage: "follow up",
            firstSpeaker: .right
        )

        XCTAssertTrue(store.add(second))
        XCTAssertEqual(store.activeBridge(forWorkspaceId: first.leftWorkspaceId)?.id, second.id)
        XCTAssertEqual(store.bridge(forWorkspaceId: first.leftWorkspaceId)?.id, second.id)
        XCTAssertEqual(store.bridges.count, 2)
    }

    func testDismissRemovesBridge() {
        let store = makeStore()
        let bridge = makeBridge()
        store.add(bridge)
        store.dismiss(id: bridge.id)
        XCTAssertTrue(store.bridges.isEmpty)
    }

    func testOverviewVersionIgnoresTranscriptAppends() {
        let store = makeStore()
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
        let store = makeStore()
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
        let store = makeStore()
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
        let store = makeStore()
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

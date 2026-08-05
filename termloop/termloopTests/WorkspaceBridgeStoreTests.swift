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

    func testAskToLaunchCredentialMatchesRequestTokenAndAgent() {
        var bridge = makeBridge()
        bridge.intent = .askAgent
        bridge.rightAgentId = "Claude"
        bridge.askToReplyToken = " reply-token "
        let request = AskToRequest(message: "question", kickoffMessage: "question")
        bridge.askToRequests = [request]

        XCTAssertTrue(bridge.acceptsAskToLaunchCredential(
            requestId: request.id,
            replyToken: "reply-token",
            callerAgentId: "claude"
        ))
        XCTAssertTrue(bridge.containsAskToRequest(id: request.id))
    }

    func testAskToLaunchCredentialRejectsWrongRequestTokenOrAgent() {
        var bridge = makeBridge()
        bridge.intent = .askAgent
        bridge.rightAgentId = "claude"
        bridge.askToReplyToken = "reply-token"
        let request = AskToRequest(message: "question", kickoffMessage: "question")
        bridge.askToRequests = [request]

        XCTAssertFalse(bridge.acceptsAskToLaunchCredential(
            requestId: UUID(),
            replyToken: "reply-token",
            callerAgentId: "claude"
        ))
        XCTAssertFalse(bridge.acceptsAskToLaunchCredential(
            requestId: request.id,
            replyToken: "wrong-token",
            callerAgentId: "claude"
        ))
        XCTAssertFalse(bridge.acceptsAskToLaunchCredential(
            requestId: request.id,
            replyToken: "reply-token",
            callerAgentId: "codex"
        ))
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

    func testRecordFinalReplyClosesRequestButKeepsAskAgentBridgeRunning() {
        let store = makeStore()
        var bridge = makeBridge()
        bridge.intent = .askAgent
        bridge.rightAgentId = "codex"
        let request = AskToRequest(message: "question", kickoffMessage: "question")
        bridge.askToRequests = [request]
        store.add(bridge)

        let result = store.recordFinalReply(
            requestId: request.id,
            text: "final answer"
        )

        guard case .recorded(let bridgeId, let messageId) = result else {
            return XCTFail("Expected final reply to be recorded")
        }
        XCTAssertEqual(bridgeId, bridge.id)
        let updated = store.bridge(id: bridge.id)
        XCTAssertEqual(updated?.state, .running)
        XCTAssertEqual(updated?.messages.count, 1)
        XCTAssertEqual(updated?.messages.first?.id, messageId)
        XCTAssertEqual(updated?.messages.first?.sender, .right)
        XCTAssertEqual(updated?.messages.first?.text, "final answer")
        XCTAssertEqual(updated?.finalReply?.messageId, messageId)
        XCTAssertEqual(updated?.finalReply?.text, "final answer")
        XCTAssertEqual(updated?.askToRequest(id: request.id)?.finalReply?.messageId, messageId)
    }

    func testRecordFinalReplyRejectsDuplicateReply() {
        let store = makeStore()
        var bridge = makeBridge()
        bridge.intent = .askAgent
        bridge.rightAgentId = "codex"
        let request = AskToRequest(message: "question", kickoffMessage: "question")
        bridge.askToRequests = [request]
        store.add(bridge)

        let first = store.recordFinalReply(requestId: request.id, text: "one")
        let second = store.recordFinalReply(requestId: request.id, text: "two")

        guard case .recorded = first else {
            return XCTFail("Expected first final reply to be recorded")
        }
        XCTAssertEqual(second, .alreadyReplied)
        XCTAssertEqual(store.bridge(id: bridge.id)?.messages.map(\.text), ["one"])
    }

    func testRepliedAskAgentBridgeAcceptsFollowUpRequestOnSameConversation() {
        let store = makeStore()
        var bridge = makeBridge()
        bridge.intent = .askAgent
        bridge.leftAgentId = "codex"
        bridge.rightAgentId = "claude"
        let firstRequest = AskToRequest(message: "first", kickoffMessage: "first")
        bridge.askToRequests = [firstRequest]
        XCTAssertTrue(store.add(bridge))
        guard case .recorded = store.recordFinalReply(requestId: firstRequest.id, text: "done") else {
            return XCTFail("Expected first final reply to be recorded")
        }

        let followUp = AskToRequest(message: "follow up", kickoffMessage: "follow up")
        XCTAssertEqual(
            store.appendAskToRequest(bridgeId: bridge.id, request: followUp),
            .appended
        )
        XCTAssertEqual(store.bridge(id: bridge.id)?.state, .running)
        XCTAssertEqual(store.bridge(id: bridge.id)?.askToRequests.map(\.id), [
            firstRequest.id,
            followUp.id
        ])
    }

    func testOpenAskToRequestBlocksAnotherFollowUpUntilReplied() {
        let store = makeStore()
        var bridge = makeBridge()
        bridge.intent = .askAgent
        bridge.leftAgentId = "codex"
        bridge.rightAgentId = "claude"
        let firstRequest = AskToRequest(message: "first", kickoffMessage: "first")
        bridge.askToRequests = [firstRequest]
        XCTAssertTrue(store.add(bridge))

        let second = AskToRequest(message: "second", kickoffMessage: "second")
        XCTAssertEqual(
            store.appendAskToRequest(bridgeId: bridge.id, request: second),
            .requestAlreadyOpen
        )
    }

    func testRunningAskAgentBridgeStillBlocksFreshSecondBridgeToSameSource() {
        let store = makeStore()
        var first = makeBridge()
        first.intent = .askAgent
        first.leftAgentId = "codex"
        first.rightAgentId = "claude"
        XCTAssertTrue(store.add(first))

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

        XCTAssertFalse(store.add(second))
        XCTAssertEqual(store.activeBridge(forWorkspaceId: first.leftWorkspaceId)?.id, first.id)
        XCTAssertEqual(store.bridge(forWorkspaceId: first.leftWorkspaceId)?.id, first.id)
        XCTAssertEqual(store.bridges.count, 1)
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

    func testPartialRestoreDoesNotDropBridgeUntilBothEndpointStampsExist() {
        let store = makeStore()
        let bridge = makeBridge()
        XCTAssertTrue(store.add(bridge))

        let restoredLeft = UUID()
        WorkspaceMetadataStore.shared.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: testProjectId,
                terminalAgentId: "claude",
                bridgeMembership: BridgeMembership(bridgeId: bridge.id, role: .left)
            ),
            forWorkspaceId: restoredLeft
        )

        XCTAssertFalse(store.rebindAfterRestore(
            knownWorkspaceIds: [restoredLeft],
            dropUnresolved: false
        ))
        XCTAssertEqual(store.bridge(id: bridge.id)?.leftWorkspaceId, bridge.leftWorkspaceId)
        XCTAssertEqual(store.bridges.count, 1)
    }

    func testFinalRestoreDropsUnresolvedBridgeAndClearsSurvivingStamp() {
        let store = makeStore()
        let bridge = makeBridge()
        XCTAssertTrue(store.add(bridge))

        let restoredLeft = UUID()
        WorkspaceMetadataStore.shared.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: testProjectId,
                terminalAgentId: "claude",
                bridgeMembership: BridgeMembership(bridgeId: bridge.id, role: .left)
            ),
            forWorkspaceId: restoredLeft
        )

        XCTAssertTrue(store.rebindAfterRestore(
            knownWorkspaceIds: [restoredLeft],
            dropUnresolved: true
        ))
        XCTAssertTrue(store.bridges.isEmpty)
        XCTAssertNil(
            WorkspaceMetadataStore.shared
                .metadata(forWorkspaceId: restoredLeft)
                .bridgeMembership
        )
    }

    func testRestoreRebindsBridgeAcrossRemintedWorkspaceIds() {
        let store = makeStore()
        let bridge = makeBridge()
        XCTAssertTrue(store.add(bridge))

        let restoredLeft = UUID()
        let restoredRight = UUID()
        WorkspaceMetadataStore.shared.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: testProjectId,
                terminalAgentId: "claude",
                bridgeMembership: BridgeMembership(bridgeId: bridge.id, role: .left)
            ),
            forWorkspaceId: restoredLeft
        )
        WorkspaceMetadataStore.shared.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: testProjectId,
                terminalAgentId: "claude",
                bridgeMembership: BridgeMembership(bridgeId: bridge.id, role: .right)
            ),
            forWorkspaceId: restoredRight
        )

        XCTAssertTrue(store.rebindAfterRestore(
            knownWorkspaceIds: [restoredLeft, restoredRight],
            dropUnresolved: true
        ))
        XCTAssertEqual(store.bridge(id: bridge.id)?.leftWorkspaceId, restoredLeft)
        XCTAssertEqual(store.bridge(id: bridge.id)?.rightWorkspaceId, restoredRight)
    }

    func testAskToRestoreContextSurvivesReloadAndEndpointRebind() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("WorkspaceBridgeStoreTests-\(UUID().uuidString).json")
        temporaryStoreURLs.append(url)
        let store = WorkspaceBridgeStore(fileURL: url)
        let originalLeft = UUID()
        let originalRight = UUID()
        WorkspaceMetadataStore.shared.setTerminalAgentId("claude", for: originalLeft)
        WorkspaceMetadataStore.shared.setTerminalAgentId("codex", for: originalRight)
        WorkspaceMetadataStore.shared.setProjectId(testProjectId, forWorkspaceId: originalLeft)
        WorkspaceMetadataStore.shared.setProjectId(testProjectId, forWorkspaceId: originalRight)

        let createdAt = Date(timeIntervalSince1970: 1_750_000_000)
        let request = AskToRequest(
            message: "review this",
            kickoffMessage: "review this",
            createdAt: createdAt
        )
        let bridge = WorkspaceBridge(
            leftWorkspaceId: originalLeft,
            rightWorkspaceId: originalRight,
            intent: .askAgent,
            leftAgentId: "claude",
            rightAgentId: "codex",
            askToRequests: [request],
            kickoffMessage: request.kickoffMessage,
            firstSpeaker: .right,
            askToReplyToken: "reply-token",
            createdAt: createdAt
        )
        XCTAssertTrue(store.add(bridge))

        let restoredLeft = UUID()
        let restoredRight = UUID()
        WorkspaceMetadataStore.shared.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: testProjectId,
                terminalAgentId: "claude",
                bridgeMembership: BridgeMembership(bridgeId: bridge.id, role: .left)
            ),
            forWorkspaceId: restoredLeft
        )
        WorkspaceMetadataStore.shared.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: testProjectId,
                terminalAgentId: "codex",
                hideFromWorkspaceTree: true,
                bridgeMembership: BridgeMembership(bridgeId: bridge.id, role: .right)
            ),
            forWorkspaceId: restoredRight
        )

        let reloaded = WorkspaceBridgeStore(fileURL: url)
        XCTAssertTrue(reloaded.rebindAfterRestore(
            knownWorkspaceIds: [restoredLeft, restoredRight],
            dropUnresolved: true
        ))

        let context = reloaded.agentRestoreContext(forWorkspaceId: restoredRight)
        XCTAssertEqual(context?.bridgeId, bridge.id)
        XCTAssertEqual(context?.role, .right)
        XCTAssertEqual(context?.agentId, "codex")
        XCTAssertEqual(context?.isAskToHelper, true)
        XCTAssertEqual(
            context?.minimumSessionDate,
            createdAt.addingTimeInterval(-1)
        )
        XCTAssertEqual(
            context?.launchEnvironment[
                TermLoopBuiltInMCP.askToRequestIdEnvironmentKey
            ],
            request.id.uuidString
        )
        XCTAssertEqual(
            context?.launchEnvironment[
                TermLoopBuiltInMCP.askToReplyTokenEnvironmentKey
            ],
            "reply-token"
        )
    }

    func testAskToRestorePolicyRejectsOlderSameDirectorySession() {
        let minimumDate = Date(timeIntervalSince1970: 1_750_000_000)

        XCTAssertFalse(AskToHelperRestorePolicy.accepts(
            sessionFileCreationDate: minimumDate.addingTimeInterval(-10),
            persistedUpdatedAt: minimumDate.addingTimeInterval(10),
            minimumSessionDate: minimumDate
        ))
        XCTAssertTrue(AskToHelperRestorePolicy.accepts(
            sessionFileCreationDate: minimumDate.addingTimeInterval(1),
            persistedUpdatedAt: nil,
            minimumSessionDate: minimumDate
        ))
        XCTAssertTrue(AskToHelperRestorePolicy.accepts(
            sessionFileCreationDate: nil,
            persistedUpdatedAt: minimumDate,
            minimumSessionDate: minimumDate
        ))
        XCTAssertFalse(AskToHelperRestorePolicy.accepts(
            sessionFileCreationDate: nil,
            persistedUpdatedAt: nil,
            minimumSessionDate: minimumDate
        ))
    }

    func testAskToRestoreReconciliationRecoversClaudeSessionByRequestId() throws {
        let projectsDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("AskToRestoreReconciliation-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: projectsDir) }

        let cwd = "/tmp/ask-to-restore"
        let slugDir = projectsDir.appendingPathComponent(ClaudeSessionScanner.slug(forCwd: cwd))
        try FileManager.default.createDirectory(at: slugDir, withIntermediateDirectories: true)

        let request = AskToRequest(
            message: "question",
            kickoffMessage: "question",
            createdAt: Date().addingTimeInterval(-30)
        )
        let correctSessionId = "correct-helper-session"
        try """
        {"type":"user","cwd":"\(cwd)","message":{"role":"user","content":"TermLoop Ask-To request protocol. Request ID: \(request.id.uuidString)"}}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}
        """.write(
            to: slugDir.appendingPathComponent("\(correctSessionId).jsonl"),
            atomically: true,
            encoding: .utf8
        )

        let bridge = WorkspaceBridge(
            leftWorkspaceId: UUID(),
            rightWorkspaceId: UUID(),
            intent: .askAgent,
            rightAgentId: "claude",
            askToRequests: [request],
            kickoffMessage: "question",
            firstSpeaker: .right,
            createdAt: Date().addingTimeInterval(-60)
        )
        let metadata = WorkspaceMetadataStore.Metadata(
            terminalAgentId: "claude",
            persistedAgentSession: PersistedAgentSession(
                agentId: "claude",
                sessionId: "unrelated-old-session",
                cwd: cwd,
                updatedAt: Date().addingTimeInterval(-3_600)
            ),
            bridgeMembership: BridgeMembership(bridgeId: bridge.id, role: .right)
        )

        let healed = TermLoopHooks.reconciledAskToHelperPersistedAgentSession(
            metadata,
            bridge: bridge,
            workspaceId: bridge.rightWorkspaceId,
            workspaceTitle: "Claude",
            workspaceCurrentDirectory: cwd,
            stampedCurrentDirectory: cwd,
            claudeScanner: ClaudeSessionScanner(projectsDir: projectsDir)
        )

        XCTAssertEqual(healed.persistedAgentSession?.sessionId, correctSessionId)
        XCTAssertEqual(healed.persistedAgentSession?.agentId, "claude")
        XCTAssertEqual(healed.persistedAgentSession?.cwd, cwd)
    }

    func testDismissClearsEveryStaleMembershipForBridgeId() {
        let store = makeStore()
        let bridge = makeBridge()
        XCTAssertTrue(store.add(bridge))

        let staleRemintedHelper = UUID()
        WorkspaceMetadataStore.shared.restoreMetadata(
            WorkspaceMetadataStore.Metadata(
                projectId: testProjectId,
                terminalAgentId: "claude",
                hideFromWorkspaceTree: true,
                bridgeMembership: BridgeMembership(bridgeId: bridge.id, role: .right)
            ),
            forWorkspaceId: staleRemintedHelper
        )

        store.dismiss(id: bridge.id)

        XCTAssertNil(
            WorkspaceMetadataStore.shared
                .metadata(forWorkspaceId: staleRemintedHelper)
                .bridgeMembership
        )
        XCTAssertTrue(store.bridges.isEmpty)
    }

}

import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TerminalAgentPresentationReducerTests: XCTestCase {
    private let wsId = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func makeRaw(
        phase: TerminalAgentActivityPhase,
        attentionKind: TerminalAgentAttentionKind? = nil,
        preview: String? = nil,
        startedAt: Date? = nil,
        updatedAt: Date? = nil
    ) -> TerminalAgentActivityState {
        TerminalAgentActivityState(
            workspaceId: wsId,
            agentId: "claude",
            phase: phase,
            attentionKind: attentionKind,
            preview: preview,
            waitingSince: nil,
            sessionId: nil,
            cwd: nil,
            pid: nil,
            startedAt: startedAt,
            updatedAt: updatedAt ?? now
        )
    }

    private func makeMetadata(
        terminalAgentId: String? = nil,
        persistedAgentSessionAgentId: String? = nil,
        persistedAgentSessionUpdatedAt: Date? = nil,
        awaitingInputSince: Int? = nil,
        lastMessagePreview: String? = nil,
        lastAttentionKind: TerminalAgentAttentionKind? = nil,
        lastUserPromptAt: Date? = nil
    ) -> TerminalAgentMetadataSnapshot {
        TerminalAgentMetadataSnapshot(
            terminalAgentId: terminalAgentId,
            persistedAgentSessionAgentId: persistedAgentSessionAgentId,
            persistedAgentSessionUpdatedAt: persistedAgentSessionUpdatedAt,
            awaitingInputSince: awaitingInputSince,
            lastMessagePreview: lastMessagePreview,
            lastAttentionKindRaw: lastAttentionKind?.rawValue,
            lastUserPromptAt: lastUserPromptAt
        )
    }

    // MARK: - Live

    func testLiveRunningYieldsRunningFromRaw() {
        let raw = makeRaw(phase: .running, startedAt: now.addingTimeInterval(-30))
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: raw,
            metadata: .empty,
            pending: nil
        )
        XCTAssertEqual(result?.displayState, .running)
        XCTAssertEqual(result?.source, .live)
        XCTAssertEqual(result?.agentId, "claude")
        XCTAssertEqual(result?.since, now.addingTimeInterval(-30))
    }

    func testLiveWaitingNotificationYieldsNeedsInput() {
        let raw = makeRaw(phase: .waiting, attentionKind: .notification)
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: raw,
            metadata: .empty,
            pending: nil
        )
        XCTAssertEqual(result?.displayState, .needsInput)
        XCTAssertEqual(result?.source, .live)
    }

    func testLiveWaitingErrorYieldsError() {
        let raw = makeRaw(phase: .waiting, attentionKind: .error)
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: raw,
            metadata: .empty,
            pending: nil
        )
        XCTAssertEqual(result?.displayState, .error)
        XCTAssertEqual(result?.source, .live)
    }

    func testLiveWaitingCompletionYieldsCompleted() {
        let raw = makeRaw(phase: .waiting, attentionKind: .completion)
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: raw,
            metadata: .empty,
            pending: nil
        )
        XCTAssertEqual(result?.displayState, .completed)
        XCTAssertEqual(result?.source, .live)
    }

    // MARK: - Pending restore

    func testPendingRestoreReadyYieldsReady() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(
                terminalAgentId: "claude",
                persistedAgentSessionAgentId: "claude",
                persistedAgentSessionUpdatedAt: now.addingTimeInterval(-600)
            ),
            pending: .ready
        )
        XCTAssertEqual(result?.displayState, .ready)
        XCTAssertEqual(result?.source, .pendingRestore)
        XCTAssertTrue(result?.isPendingRestore == true)
        XCTAssertEqual(result?.agentId, "claude")
    }

    func testPendingRestoreRunningYieldsRunning() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(terminalAgentId: "claude"),
            pending: .running
        )
        XCTAssertEqual(result?.displayState, .running)
        XCTAssertEqual(result?.source, .pendingRestore)
    }

    // MARK: - Sticky

    func testStickyCompletedFromAttentionKind() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(
                terminalAgentId: "claude",
                awaitingInputSince: 1_699_999_000,
                lastMessagePreview: "done",
                lastAttentionKind: .completion
            ),
            pending: nil
        )
        XCTAssertEqual(result?.displayState, .completed)
        XCTAssertEqual(result?.source, .sticky)
        XCTAssertEqual(result?.preview, "done")
    }

    func testStickyErrorFromAttentionKind() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(
                terminalAgentId: "claude",
                awaitingInputSince: 1_699_999_000,
                lastAttentionKind: .error
            ),
            pending: nil
        )
        XCTAssertEqual(result?.displayState, .error)
        XCTAssertEqual(result?.source, .sticky)
    }

    func testStickyNeedsInputFromPermission() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(
                persistedAgentSessionAgentId: "claude",
                awaitingInputSince: 1_699_999_000,
                lastAttentionKind: .permission
            ),
            pending: nil
        )
        XCTAssertEqual(result?.displayState, .needsInput)
        XCTAssertEqual(result?.source, .sticky)
        XCTAssertEqual(result?.agentId, "claude")
    }

    func testStickyNeedsInputFromUserInput() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(
                awaitingInputSince: 1_699_999_000,
                lastAttentionKind: .userInput
            ),
            pending: nil
        )
        XCTAssertEqual(result?.displayState, .needsInput)
        XCTAssertEqual(result?.source, .sticky)
    }

    func testStickyNeedsInputFromNotification() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(
                awaitingInputSince: 1_699_999_000,
                lastAttentionKind: .notification
            ),
            pending: nil
        )
        XCTAssertEqual(result?.displayState, .needsInput)
        XCTAssertEqual(result?.source, .sticky)
    }

    // MARK: - Raw clear + sticky

    func testRawClearPreservesStickyMetadata() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(
                terminalAgentId: "claude",
                awaitingInputSince: 1_699_999_500,
                lastMessagePreview: "ready for review",
                lastAttentionKind: .completion
            ),
            pending: nil
        )
        XCTAssertEqual(result?.source, .sticky)
        XCTAssertEqual(result?.displayState, .completed)
        XCTAssertEqual(result?.preview, "ready for review")
    }

    // MARK: - Raw ready + sticky override

    func testRawReadyWithStickyKeepsStickyState() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: makeRaw(phase: .ready),
            metadata: makeMetadata(
                awaitingInputSince: 1_699_999_000,
                lastMessagePreview: "last message",
                lastAttentionKind: .completion
            ),
            pending: nil
        )
        XCTAssertEqual(result?.source, .sticky)
        XCTAssertEqual(result?.displayState, .completed)
    }

    // MARK: - Bound workspace fallback

    func testBoundWorkspaceWithoutLiveOrStickyYieldsReady() {
        let persistedAt = now.addingTimeInterval(-120)
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(
                terminalAgentId: "codex",
                persistedAgentSessionAgentId: "codex",
                persistedAgentSessionUpdatedAt: persistedAt
            ),
            pending: nil
        )
        XCTAssertEqual(result?.source, .bound)
        XCTAssertEqual(result?.displayState, .ready)
        XCTAssertEqual(result?.agentId, "codex")
        XCTAssertEqual(result?.latestActivityAt, persistedAt)
        XCTAssertEqual(result?.since, persistedAt)
    }

    func testBoundWorkspacePrefersLastUserPromptAtAsBaseline() {
        let promptAt = now.addingTimeInterval(-30)
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: makeMetadata(
                terminalAgentId: "claude",
                persistedAgentSessionAgentId: "claude",
                persistedAgentSessionUpdatedAt: now.addingTimeInterval(-120),
                lastUserPromptAt: promptAt
            ),
            pending: nil
        )
        XCTAssertEqual(result?.source, .bound)
        XCTAssertEqual(result?.displayState, .ready)
        XCTAssertEqual(result?.latestActivityAt, promptAt)
        XCTAssertEqual(result?.since, promptAt)
    }

    // MARK: - Precedence

    func testPreviewPrecedenceRawWinsOverMetadata() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: makeRaw(phase: .running, preview: "raw preview"),
            metadata: makeMetadata(lastMessagePreview: "metadata preview"),
            pending: nil
        )
        XCTAssertEqual(result?.preview, "raw preview")
    }

    func testPreviewFallsBackToMetadataWhenRawMissing() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: makeRaw(phase: .running, preview: nil),
            metadata: makeMetadata(lastMessagePreview: "metadata preview"),
            pending: nil
        )
        XCTAssertEqual(result?.preview, "metadata preview")
    }

    func testLastUserPromptAtPropagates() {
        let promptAt = now.addingTimeInterval(-10)
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: makeRaw(phase: .running),
            metadata: makeMetadata(lastUserPromptAt: promptAt),
            pending: nil
        )
        XCTAssertEqual(result?.lastUserPromptAt, promptAt)
    }

    // MARK: - Empty

    func testNothingYieldsNil() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: nil,
            metadata: .empty,
            pending: nil
        )
        XCTAssertNil(result)
    }

    // MARK: - Live over pending

    func testLiveRawTakesPrecedenceOverPending() {
        let result = TerminalAgentPresentationReducer.computePresentation(
            workspaceId: wsId,
            raw: makeRaw(phase: .running),
            metadata: .empty,
            pending: .ready
        )
        XCTAssertEqual(result?.source, .live)
        XCTAssertEqual(result?.displayState, .running)
    }
}

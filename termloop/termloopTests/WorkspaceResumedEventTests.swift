import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

/// Tests for the `workspace.resumed` event fired when a terminal-agent
/// status flips to "Running" while the workspace is in awaiting-input state.
@MainActor
final class WorkspaceResumedEventTests: XCTestCase {

    // MARK: - B4

    func testResumedEventFiresOnRunningStatus() {
        let store = WorkspaceMetadataStore.shared
        let wsId = UUID()

        // Seed awaiting-input state.
        store.setAwaitingInputSince(1712345678, forWorkspaceId: wsId)
        store.setLastMessagePreview("What now?", forWorkspaceId: wsId)
        store.setLastAttentionKindRaw(TerminalAgentAttentionKind.completion.rawValue, forWorkspaceId: wsId)

        // Subscribe to workspace.resumed events.
        var receivedEvent: EventBus.Event?
        let handle = EventBus.shared.subscribe(
            types: ["workspace.resumed"],
            workspaceIds: [wsId]
        ) { event in
            receivedEvent = event
        }
        defer { EventBus.shared.unsubscribe(handle) }

        // Fire the hook as if the status changed to "Running".
        TermLoopHooks.notifyTerminalAgentStatusChange(workspaceId: wsId, newValue: "Running")

        // awaitingInputSince must be cleared.
        XCTAssertNil(store.metadata(forWorkspaceId: wsId).awaitingInputSince)

        // workspace.resumed event must have been published.
        XCTAssertNotNil(receivedEvent)
        XCTAssertEqual(receivedEvent?.type, "workspace.resumed")
        XCTAssertEqual(receivedEvent?.workspaceId, wsId)
        XCTAssertNotNil(receivedEvent?.payload["at"] as? Int)
    }

    func testResumedEventNotFiredWhenNotAwaiting() {
        let store = WorkspaceMetadataStore.shared
        let wsId = UUID()

        // Do NOT seed awaiting-input state.
        XCTAssertNil(store.metadata(forWorkspaceId: wsId).awaitingInputSince)

        var receivedEvent: EventBus.Event?
        let handle = EventBus.shared.subscribe(
            types: ["workspace.resumed"],
            workspaceIds: [wsId]
        ) { event in
            receivedEvent = event
        }
        defer { EventBus.shared.unsubscribe(handle) }

        TermLoopHooks.notifyTerminalAgentStatusChange(workspaceId: wsId, newValue: "Running")

        XCTAssertNil(receivedEvent, "No event should fire when not in awaiting-input state")
    }

    func testResumedEventNotFiredForNonRunningStatus() {
        let store = WorkspaceMetadataStore.shared
        let wsId = UUID()

        store.setAwaitingInputSince(1712345678, forWorkspaceId: wsId)

        var receivedEvent: EventBus.Event?
        let handle = EventBus.shared.subscribe(
            types: ["workspace.resumed"],
            workspaceIds: [wsId]
        ) { event in
            receivedEvent = event
        }
        defer {
            EventBus.shared.unsubscribe(handle)
            store.setAwaitingInputSince(nil, forWorkspaceId: wsId)
        }

        TermLoopHooks.notifyTerminalAgentStatusChange(workspaceId: wsId, newValue: "Stopped")

        XCTAssertNil(receivedEvent, "No event should fire for non-Running status")
        // awaitingInputSince must be untouched.
        XCTAssertEqual(store.metadata(forWorkspaceId: wsId).awaitingInputSince, 1712345678)
    }
}

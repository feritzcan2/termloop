import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

/// Tests for the events.subscribe / events.unsubscribe socket RPC handlers and
/// the per-socket subscription tracker.
final class EventsSubscribeTests: XCTestCase {

    // MARK: - Tracker unit tests

    @MainActor
    func testSubscribeReturnsHandleId() {
        // Set a fake socket fd in thread-local so eventsSubscribe can register.
        TermLoopTCPBridge.setCurrentSocketFd(999)
        defer { TermLoopSubscriptionTracker.shared.dispose(for: 999) }

        // Call events.subscribe via TermLoopSocketCommands (the canonical path).
        guard let result = TermLoopSocketCommands.handle(method: "events.subscribe", params: [:]) else {
            XCTFail("TermLoopSocketCommands.handle returned nil for events.subscribe")
            return
        }
        guard case .ok(let raw) = result else {
            XCTFail("Expected ok result")
            return
        }
        let payload = raw as? [String: Any]
        let subId = payload?["subscription_id"] as? String
        XCTAssertNotNil(subId, "subscription_id must be a non-nil String")
        XCTAssertNotNil(UUID(uuidString: subId ?? ""), "subscription_id must be a valid UUID")
    }

    func testTrackerRegisterAndDisposeCount() {
        let tracker = TermLoopSubscriptionTracker.shared
        let socket: Int32 = 777
        defer { tracker.dispose(for: socket) }

        _ = tracker.subscribePushFrames(types: nil, workspaceIds: nil, socket: socket) { _, _ in }

        XCTAssertEqual(tracker.handleCount(for: socket), 1)
        tracker.dispose(for: socket)
        XCTAssertEqual(tracker.handleCount(for: socket), 0)
    }

    @MainActor
    func testUnsubscribeByIdRemovesSubscription() {
        let socket: Int32 = 888
        TermLoopTCPBridge.setCurrentSocketFd(socket)
        defer { TermLoopSubscriptionTracker.shared.dispose(for: socket) }

        // Subscribe
        guard let subResult = TermLoopSocketCommands.handle(method: "events.subscribe", params: [:]),
              case .ok(let subRaw) = subResult,
              let subIdStr = (subRaw as? [String: Any])?["subscription_id"] as? String else {
            XCTFail("Subscribe failed")
            return
        }

        // Confirm handle is tracked
        XCTAssertEqual(TermLoopSubscriptionTracker.shared.handleCount(for: socket), 1)

        // Unsubscribe by id
        guard let unsubResult = TermLoopSocketCommands.handle(
            method: "events.unsubscribe",
            params: ["subscription_id": subIdStr]
        ), case .ok(let unsubRaw) = unsubResult else {
            XCTFail("Unsubscribe returned nil or error")
            return
        }
        let unsubPayload = unsubRaw as? [String: Any]
        XCTAssertEqual(unsubPayload?["unsubscribed"] as? Bool, true)

        // Handle should be gone
        XCTAssertEqual(TermLoopSubscriptionTracker.shared.handleCount(for: socket), 0)
    }

    @MainActor
    func testUnsubscribeAllRemovesEverything() {
        let socket: Int32 = 555
        TermLoopTCPBridge.setCurrentSocketFd(socket)
        defer { TermLoopSubscriptionTracker.shared.dispose(for: socket) }

        // Subscribe twice
        _ = TermLoopSocketCommands.handle(method: "events.subscribe", params: [:])
        _ = TermLoopSocketCommands.handle(method: "events.subscribe", params: ["types": ["workspace.attention"]])
        XCTAssertEqual(TermLoopSubscriptionTracker.shared.handleCount(for: socket), 2)

        // Unsubscribe all (no subscription_id)
        guard let result = TermLoopSocketCommands.handle(method: "events.unsubscribe", params: [:]),
              case .ok(let raw) = result else {
            XCTFail("Unsubscribe all returned nil or error")
            return
        }
        let payload = raw as? [String: Any]
        XCTAssertEqual(payload?["all"] as? Bool, true)
        XCTAssertEqual(TermLoopSubscriptionTracker.shared.handleCount(for: socket), 0)
    }
}

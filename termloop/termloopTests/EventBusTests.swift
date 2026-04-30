import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class EventBusTests: XCTestCase {
    func testPublishToSingleSubscriber() {
        let bus = EventBus()
        var received: [EventBus.Event] = []
        let handle = bus.subscribe(types: nil, workspaceIds: nil) { event in
            received.append(event)
        }
        defer { bus.unsubscribe(handle) }

        let evt = EventBus.Event(
            type: "workspace.attention",
            workspaceId: UUID(),
            payload: ["kind": "stop", "message_preview": "hi"]
        )
        bus.publish(evt)
        XCTAssertEqual(received.count, 1)
        XCTAssertEqual(received[0].type, "workspace.attention")
    }

    func testFilterByType() {
        let bus = EventBus()
        var received: [String] = []
        _ = bus.subscribe(types: ["workspace.attention"], workspaceIds: nil) { received.append($0.type) }

        bus.publish(.init(type: "workspace.attention", workspaceId: UUID(), payload: [:]))
        bus.publish(.init(type: "workspace.resumed",   workspaceId: UUID(), payload: [:]))

        XCTAssertEqual(received, ["workspace.attention"])
    }

    func testFilterByWorkspaceId() {
        let bus = EventBus()
        let target = UUID()
        let other = UUID()
        var received: [UUID] = []
        _ = bus.subscribe(types: nil, workspaceIds: [target]) { received.append($0.workspaceId) }

        bus.publish(.init(type: "x", workspaceId: other,  payload: [:]))
        bus.publish(.init(type: "x", workspaceId: target, payload: [:]))

        XCTAssertEqual(received, [target])
    }

    func testUnsubscribeStopsDelivery() {
        let bus = EventBus()
        var count = 0
        let handle = bus.subscribe(types: nil, workspaceIds: nil) { _ in count += 1 }
        bus.publish(.init(type: "x", workspaceId: UUID(), payload: [:]))
        bus.unsubscribe(handle)
        bus.publish(.init(type: "x", workspaceId: UUID(), payload: [:]))
        XCTAssertEqual(count, 1)
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

final class EventBus: @unchecked Sendable {
    static let shared = EventBus()

    struct Event {
        let type: String
        let workspaceId: UUID
        let payload: [String: Any]
    }

    final class SubscriptionHandle {
        let id: UUID
        fileprivate let types: Set<String>?
        fileprivate let workspaceIds: Set<UUID>?
        fileprivate let sink: (Event) -> Void
        init(id: UUID, types: Set<String>?, workspaceIds: Set<UUID>?, sink: @escaping (Event) -> Void) {
            self.id = id
            self.types = types
            self.workspaceIds = workspaceIds
            self.sink = sink
        }
    }

    private let queue = DispatchQueue(label: "cmux.eventbus")
    private var subscriptions: [UUID: SubscriptionHandle] = [:]

    @discardableResult
    func subscribe(types: [String]?, workspaceIds: [UUID]?, sink: @escaping (Event) -> Void) -> SubscriptionHandle {
        subscribe(id: UUID(), types: types, workspaceIds: workspaceIds, sink: sink)
    }

    /// Caller-supplied id overload. Lets callers (specifically
    /// `TermLoopSubscriptionTracker.subscribePushFrames`) allocate the
    /// subscription token *before* the closure is built, so the closure
    /// captures an immutable id. Without this, the closure had to read the
    /// id back through a mutable holder, and a publish that raced subscribe
    /// would see a stale dummy id and drop the first event.
    @discardableResult
    func subscribe(id: UUID, types: [String]?, workspaceIds: [UUID]?, sink: @escaping (Event) -> Void) -> SubscriptionHandle {
        let handle = SubscriptionHandle(
            id: id,
            types: types.map { Set($0) },
            workspaceIds: workspaceIds.map { Set($0) },
            sink: sink
        )
        queue.sync { subscriptions[handle.id] = handle }
        return handle
    }

    func unsubscribe(_ handle: SubscriptionHandle) {
        queue.sync { _ = subscriptions.removeValue(forKey: handle.id) }
    }

    func publish(_ event: Event) {
        let targets: [SubscriptionHandle] = queue.sync {
            subscriptions.values.filter { sub in
                if let types = sub.types, !types.contains(event.type) { return false }
                if let wsIds = sub.workspaceIds, !wsIds.contains(event.workspaceId) { return false }
                return true
            }
        }
        for sub in targets { sub.sink(event) }
    }
}

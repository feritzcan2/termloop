// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Foundation

/// Owns per-socket event subscription state so that TermLoop can dispose
/// EventBus handles when a client socket disconnects.
///
/// **Connection token model.** Subscriptions are keyed by their
/// `EventBus.SubscriptionHandle.id` (the *subscription token*) and resolve
/// to a current fd via `socketBySubscriptionId`. Every push-frame closure
/// captures only the immutable token and asks the tracker for the active
/// fd at write time. After the connection is torn down the mapping is
/// cleared, so a publish that races disconnect resolves to nil and the
/// closure short-circuits — even if EventBus already snapshotted the
/// handle and even if the OS has since recycled the fd.
///
/// **Two distinct lifecycle operations:**
/// - `unsubscribeAll(for:)` — drop subscriptions for a still-open
///   connection (e.g. `events.unsubscribe` with no id). Leaves IO state
///   alone so subsequent commands on the same fd keep working.
/// - `disposeConnection(for:)` — connection lifetime ended (only from the
///   handleClient defer). Drops subscriptions *and* tells `TermLoopSocketIO`
///   to retire the fd's bookkeeping.
///
/// Concurrency: all mutations are guarded by `lock` (NSLock). The singleton
/// is safe to call from any thread (BSD socket I/O threads or main actor).
final class TermLoopSubscriptionTracker: @unchecked Sendable {
    static let shared = TermLoopSubscriptionTracker()

    private let lock = NSLock()
    private var handlesBySocket: [Int32: [EventBus.SubscriptionHandle]] = [:]
    /// Reverse index: subscription id → socket fd. Cleared by every
    /// disposal path so a publish racing disconnect resolves to nil and
    /// the writer skips instead of misrouting to a recycled descriptor.
    private var socketBySubscriptionId: [UUID: Int32] = [:]

    // MARK: - B6: 30-second keepalive ping
    //
    // A single DispatchSourceTimer fires every 30 seconds and writes
    // `{"event":"ping"}\n` to every socket that currently has at least one
    // active subscription. The set of "currently subscribed" sockets is
    // the *snapshot of socketBySubscriptionId values*, not the keys of
    // handlesBySocket — so a connection that called events.unsubscribe
    // (which now leaves an entry in handlesBySocket if it was a fresh
    // subscriber registry but always clears socketBySubscriptionId) does
    // not keep receiving pings, and a still-pending closure for a
    // connection that already disposed is invisible to the iteration.
    //
    // TODO: test coverage deferred — requires a clock-injection seam.
    //       The current implementation uses a real timer which makes unit
    //       tests timing-sensitive and flaky.

    private var pingTimer: DispatchSourceTimer?
    private static let pingIntervalSeconds: Double = 30

    private let pingFrame: Data = {
        var d = Data("{\"event\":\"ping\"}".utf8)
        d.append(UInt8(ascii: "\n"))
        return d
    }()

    private init() {}

    // MARK: - Push-frame subscription

    /// Subscribe `socket` to a filtered EventBus stream that pushes NDJSON
    /// frames back over the same descriptor. Use this instead of calling
    /// `EventBus.shared.subscribe` directly for socket pushes; it allocates
    /// the subscription token *before* the closure is built and registers
    /// the connection mapping under lock, so the closure captures an
    /// immutable token and a publish racing subscribe can never see a
    /// dummy id.
    @discardableResult
    func subscribePushFrames(
        types: [String]?,
        workspaceIds: [UUID]?,
        socket: Int32,
        frameWriter: @escaping (EventBus.Event, Int32) -> Void
    ) -> UUID {
        let token = UUID()
        // Pre-register the token → socket mapping so the closure's
        // activeSocket(forSubscription:) lookup resolves correctly even if
        // EventBus.publish wins the race against subscribe(...).
        let needsTimer: Bool = {
            lock.lock(); defer { lock.unlock() }
            socketBySubscriptionId[token] = socket
            let needs = pingTimer == nil
            return needs
        }()
        let handle = EventBus.shared.subscribe(
            id: token,
            types: types,
            workspaceIds: workspaceIds
        ) { [weak self] event in
            guard let self else { return }
            guard let fd = self.activeSocket(forSubscription: token) else { return }
            frameWriter(event, fd)
        }
        // Disconnect-before-append race: between the pre-register lock
        // section above and this append, disposeConnection(for: socket)
        // can run on another thread. The disposal sweeps the token map
        // by socket value (so it sees our pre-registered entry and
        // clears it) but cannot see our handle yet — so the EventBus
        // subscription would leak if we just blindly appended.
        // Re-check under the same lock: if our token is still mapped to
        // this socket, the connection survived and we append; otherwise
        // disconnect won the race and we unsubscribe the orphan handle.
        let stillLive: Bool = {
            lock.lock(); defer { lock.unlock() }
            guard socketBySubscriptionId[token] == socket else { return false }
            handlesBySocket[socket, default: []].append(handle)
            return true
        }()
        if !stillLive {
            EventBus.shared.unsubscribe(handle)
            return token
        }
        if needsTimer { startPingTimer() }
        return token
    }

    /// Lookup used by push-frame closures to test whether their connection
    /// is still live. Returns nil after any disposal path clears the
    /// reverse-index entry, even if EventBus has already snapshotted the
    /// handle and is mid-fan-out.
    func activeSocket(forSubscription id: UUID) -> Int32? {
        lock.lock(); defer { lock.unlock() }
        return socketBySubscriptionId[id]
    }

    // MARK: - Ping timer

    private func startPingTimer() {
        lock.lock()
        guard pingTimer == nil else { lock.unlock(); return }
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(
            deadline: .now() + TermLoopSubscriptionTracker.pingIntervalSeconds,
            repeating: TermLoopSubscriptionTracker.pingIntervalSeconds
        )
        timer.setEventHandler { [weak self] in self?.sendPingToAllSockets() }
        timer.resume()
        pingTimer = timer
        lock.unlock()
    }

    private func sendPingToAllSockets() {
        // Snapshot the *current set of live subscription fds*, not the
        // keys of handlesBySocket. Going via socketBySubscriptionId means
        // a connection that has been torn down (and had its mapping
        // cleared) is invisible here even if a stale handlesBySocket
        // entry hasn't been cleaned yet.
        let sockets: Set<Int32> = {
            lock.lock(); defer { lock.unlock() }
            return Set(socketBySubscriptionId.values)
        }()
        guard !sockets.isEmpty else { return }
        for fd in sockets where fd >= 0 {
            // writeFrame returns false for fds without live FDState
            // (already-disposed connection, OS-recycled descriptor before
            // a fresh beginConnection landed); we ignore the return value
            // because the tracker's disposal path will catch up shortly.
            _ = TermLoopSocketIO.writeFrame(fd, bytes: pingFrame)
        }
    }

    // MARK: - Disposal

    /// Connection lifetime ended. Called only from the handleClient defer.
    /// Drops subscriptions and tells TermLoopSocketIO to mark the fd
    /// closed before the upstream `defer { close(socket) }` runs.
    ///
    /// Cleanup walks `socketBySubscriptionId` by *value*, not by the
    /// handles in `handlesBySocket`, so a token that was pre-registered
    /// by `subscribePushFrames` but whose handle hasn't been appended yet
    /// is still cleared. The post-subscribe re-check inside
    /// subscribePushFrames will then notice the token is gone and
    /// unsubscribe the orphan EventBus handle.
    func disposeConnection(for socket: Int32) {
        let handles: [EventBus.SubscriptionHandle] = {
            lock.lock(); defer { lock.unlock() }
            let removed = handlesBySocket.removeValue(forKey: socket) ?? []
            sweepSocketByTokenLocked(socket: socket)
            return removed
        }()
        unsubscribe(handles)
        TermLoopSocketIO.endConnection(socket)
    }

    /// Legacy alias: prior callers used dispose(for:) for both meanings.
    /// Kept so the TermLoopHooks disconnect path keeps compiling; new
    /// code should call disposeConnection(for:) (real disconnect) or
    /// unsubscribeAll(for:) (events.unsubscribe with no id).
    func dispose(for socket: Int32) {
        disposeConnection(for: socket)
    }

    /// Drop all subscriptions for `socket` *without* touching the IO
    /// lifecycle — the connection is still open and may issue more
    /// commands. Used by `events.unsubscribe` with no subscription_id.
    ///
    /// Sweeps token mappings by socket value (same reasoning as
    /// `disposeConnection(for:)`).
    func unsubscribeAll(for socket: Int32) {
        let handles: [EventBus.SubscriptionHandle] = {
            lock.lock(); defer { lock.unlock() }
            let removed = handlesBySocket.removeValue(forKey: socket) ?? []
            sweepSocketByTokenLocked(socket: socket)
            return removed
        }()
        unsubscribe(handles)
    }

    private func unsubscribe(_ handles: [EventBus.SubscriptionHandle]) {
        for handle in handles {
            EventBus.shared.unsubscribe(handle)
        }
    }

    /// Sweeps every `socketBySubscriptionId` entry whose value equals
    /// `socket`. Caller must hold `lock`.
    private func sweepSocketByTokenLocked(socket: Int32) {
        let staleTokens: [UUID] = socketBySubscriptionId.compactMap { key, value in
            value == socket ? key : nil
        }
        for token in staleTokens {
            socketBySubscriptionId.removeValue(forKey: token)
        }
    }

    /// Unsubscribe a single handle by its `id` for `socket`. No-op if not
    /// found. Cleans up the per-socket entry when the last handle goes
    /// away so the ping timer doesn't see dead-socket keys.
    func unsubscribeOne(id: UUID, socket: Int32) {
        let handle: EventBus.SubscriptionHandle? = {
            lock.lock(); defer { lock.unlock() }
            guard var list = handlesBySocket[socket] else { return nil }
            guard let idx = list.firstIndex(where: { $0.id == id }) else { return nil }
            let h = list.remove(at: idx)
            if list.isEmpty {
                handlesBySocket.removeValue(forKey: socket)
            } else {
                handlesBySocket[socket] = list
            }
            socketBySubscriptionId.removeValue(forKey: id)
            return h
        }()
        if let handle { EventBus.shared.unsubscribe(handle) }
    }

    // MARK: - Introspection (tests)

    /// Number of active handles tracked for `socket`. Test-only.
    func handleCount(for socket: Int32) -> Int {
        lock.lock(); defer { lock.unlock() }
        return handlesBySocket[socket]?.count ?? 0
    }
}

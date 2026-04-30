// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Foundation
import os

/// Centralized write helpers for TermLoop-owned socket frames.
///
/// Connection lifetime is **explicit**: `beginConnection(_:)` must run for
/// every accepted client fd before any write can succeed; `endConnection(_:)`
/// runs from the disconnect hook before `close(fd)`. There is no longer a
/// lazy "create FDState if missing" path inside `writeFrame` — that path was
/// the OS-fd-reuse misroute Codex flagged: a stale ping or event closure
/// could lazily create fresh state for a recycled descriptor and write to
/// whatever client now owned it.
///
/// Per-fd serialization, SIGPIPE protection, and partial-write handling are
/// the same as before. New: every accepted fd gets `SO_SNDTIMEO` so a slow
/// or silent TCP subscriber can't pin a publisher (often the main actor)
/// for unbounded time.
///
/// `forget(_:)` is preserved as an alias for `endConnection(_:)` so older
/// callers in the SubscriptionTracker keep working.
enum TermLoopSocketIO {
    /// Per-fd lock + closure flag. A new FDState is created on
    /// `beginConnection`; `endConnection` flips the flag while still holding
    /// the lock so an in-flight write either completes (under the pre-close
    /// lock) or sees the flag and returns. When the OS recycles a
    /// descriptor and `beginConnection` runs again, the *prior* state
    /// object is simultaneously marked closed — any in-flight stale writer
    /// holding a reference to it sees `closed = true` and skips before
    /// touching the new connection's fd.
    private final class FDState {
        let lock = NSLock()
        var closed: Bool = false
    }

    private static let registryLock = NSLock()
    private static var states: [Int32: FDState] = [:]
    private static let logger = Logger(subsystem: "ai.termloop", category: "socket-io")

    /// Bound on the main actor / publisher thread when a TCP subscriber's
    /// kernel buffer fills. 5 seconds is generous enough that a
    /// momentarily-paused but otherwise live mobile client won't get
    /// dropped, tight enough that a dead-but-not-yet-RST client can't pin
    /// the UI.
    private static let sendTimeoutSeconds: Int = 5

    /// Establish I/O bookkeeping for a freshly accepted client fd. Sets
    /// `SO_NOSIGPIPE` and `SO_SNDTIMEO`, then installs a fresh `FDState`.
    /// **Replaces** any tombstone left behind by a prior connection on the
    /// same fd value (i.e. an OS-recycled descriptor) and marks the prior
    /// state closed so any in-flight stale writer aborts before it touches
    /// the new client.
    static func beginConnection(_ fd: Int32) {
        guard fd >= 0 else { return }
        var on: Int32 = 1
        _ = setsockopt(
            fd, SOL_SOCKET, SO_NOSIGPIPE,
            &on, socklen_t(MemoryLayout<Int32>.size)
        )
        var tv = timeval(tv_sec: sendTimeoutSeconds, tv_usec: 0)
        _ = setsockopt(
            fd, SOL_SOCKET, SO_SNDTIMEO,
            &tv, socklen_t(MemoryLayout<timeval>.size)
        )
        let newState = FDState()
        let displaced: FDState? = {
            registryLock.lock(); defer { registryLock.unlock() }
            let prior = states[fd]
            states[fd] = newState
            return prior
        }()
        if let displaced {
            displaced.lock.lock()
            displaced.closed = true
            displaced.lock.unlock()
        }
    }

    /// Tear down I/O bookkeeping for `fd`. Caller (the disconnect hook)
    /// must invoke this *before* `close(fd)`. After this point any writer
    /// holding a stale reference to the old `FDState` finds `closed = true`
    /// under the lock and skips; any new writer that arrives via
    /// `state(for:)` finds no entry at all and skips.
    static func endConnection(_ fd: Int32) {
        guard fd >= 0 else { return }
        let state: FDState? = {
            registryLock.lock(); defer { registryLock.unlock() }
            return states.removeValue(forKey: fd)
        }()
        guard let state else { return }
        state.lock.lock()
        state.closed = true
        state.lock.unlock()
    }

    /// Legacy alias so existing tracker disconnect paths keep compiling.
    static func forget(_ fd: Int32) { endConnection(fd) }

    private static func state(for fd: Int32) -> FDState? {
        registryLock.lock(); defer { registryLock.unlock() }
        return states[fd]
    }

    /// Synchronous full-write loop. Retries `EINTR` indefinitely (interrupt)
    /// and `EAGAIN`/`EWOULDBLOCK` with a 1ms backoff. `SO_SNDTIMEO` causes
    /// `write()` to return `-1` with `errno == EAGAIN` after the timeout
    /// window — that case falls through and returns the bytes written so
    /// far, releasing the publisher.
    @discardableResult
    static func writeAll(
        _ fd: Int32,
        bytes: UnsafeRawPointer,
        count: Int
    ) -> Int {
        guard fd >= 0, count > 0 else { return 0 }
        var offset = 0
        var eagainAttempts = 0
        while offset < count {
            let remaining = count - offset
            let n = Darwin.write(fd, bytes.advanced(by: offset), remaining)
            if n > 0 {
                offset += n
                eagainAttempts = 0
                continue
            }
            if n == 0 { return offset }
            let err = errno
            if err == EINTR { continue }
            if err == EAGAIN || err == EWOULDBLOCK {
                // SO_SNDTIMEO surfaces here. After ~5 short retries we stop
                // looping and let the caller move on; further retries can't
                // distinguish a slow client from a dead one.
                eagainAttempts += 1
                if eagainAttempts > 5 { return offset }
                usleep(1000)
                continue
            }
            return offset
        }
        return offset
    }

    /// Synchronous serialized write. Returns `false` if the fd has no live
    /// state (never `beginConnection`'d, or already `endConnection`'d), or
    /// if the write was truncated by SO_SNDTIMEO / peer disconnect mid-frame.
    ///
    /// On truncation we mark the FDState closed *immediately* so a follow-up
    /// frame on the same fd can't append more bytes after a half-frame —
    /// that would corrupt NDJSON for the receiver. The upstream
    /// `handleClient` read loop will notice the connection is no longer
    /// usable (subsequent reads / its peer's close) and drop into the
    /// disconnect defer.
    @discardableResult
    static func writeFrame(_ fd: Int32, bytes: Data) -> Bool {
        guard fd >= 0, !bytes.isEmpty else { return false }
        guard let st = state(for: fd) else { return false }
        st.lock.lock()
        defer { st.lock.unlock() }
        guard !st.closed else { return false }
        let written: Int = bytes.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress else { return 0 }
            return writeAll(fd, bytes: base, count: ptr.count)
        }
        if written < bytes.count {
            st.closed = true
            logger.error(
                "writeFrame: truncated fd=\(fd, privacy: .public) wrote=\(written, privacy: .public)/\(bytes.count, privacy: .public). Marking fd closed to prevent half-frame follow-ups."
            )
            return false
        }
        return true
    }

    /// Convenience for ASCII/UTF-8 string payloads (response frames, ERROR
    /// messages). Caller must include any trailing newline that the wire
    /// format expects.
    @discardableResult
    static func writeText(_ text: String, to fd: Int32) -> Bool {
        guard fd >= 0, !text.isEmpty else { return false }
        return writeFrame(fd, bytes: Data(text.utf8))
    }
}

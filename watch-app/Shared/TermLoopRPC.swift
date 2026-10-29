// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import Network

/// Minimal v2 NDJSON client for the TermLoop TCP bridge.
///
/// Each call opens a fresh `NWConnection`, authenticates with `auth.login`,
/// performs the requested method, then closes. No persistent connection:
/// MVP and avoids background-mode TCP complications on iOS.
final class TermLoopRPC {
    struct Endpoint {
        let host: String
        let port: UInt16
        let password: String
    }

    enum CallError: Error, LocalizedError {
        case connectionFailed(String)
        case authFailed
        case timeout
        case invalidResponse
        case server(code: String, message: String)

        var errorDescription: String? {
            switch self {
            case .connectionFailed(let s): return "Connection failed: \(s)"
            case .authFailed: return "Authentication failed"
            case .timeout: return "Request timed out"
            case .invalidResponse: return "Invalid response"
            case .server(_, let m): return m
            }
        }
    }

    /// Cap on a single response line. Servers in the wild produce small
    /// JSON envelopes; rejecting larger frames bounds memory and prevents
    /// a malicious/buggy peer from growing the read buffer indefinitely.
    private static let maxLineBytes = 1 << 20  // 1 MB
    private static let perStepTimeout: TimeInterval = 10

    let endpoint: Endpoint
    init(endpoint: Endpoint) { self.endpoint = endpoint }

    func ping() async throws {
        _ = try await invoke(method: "project.list", params: [:])
    }

    func launchAgent(prompt: String) async throws -> String {
        let response = try await invoke(method: "watch.launch_agent",
                                        params: ["prompt": prompt])
        guard let branch = response["branch"] as? String else {
            throw CallError.invalidResponse
        }
        return branch
    }

    func sendPrompt(workspaceId: String, text: String) async throws {
        _ = try await invoke(method: "watch.send_prompt",
                             params: ["workspace_id": workspaceId, "text": text])
    }

    func registerPush(deviceToken: String, environment: String) async throws {
        _ = try await invoke(method: "push.register",
                             params: [
                                 "device_token": deviceToken,
                                 "platform": "ios",
                                 "environment": environment
                             ])
    }

    // MARK: - Connection lifecycle

    private func invoke(method: String, params: [String: Any]) async throws -> [String: Any] {
        let queue = DispatchQueue(label: "termloop.rpc")
        let conn = NWConnection(
            host: NWEndpoint.Host(endpoint.host),
            port: NWEndpoint.Port(rawValue: endpoint.port)!,
            using: .tcp
        )
        // Cancel on every exit path — including a thrown timeout — so the
        // suspended `receive`/`send` callbacks resolve and free the
        // continuation. Without this a blackholed peer would let
        // `withTimeout` complete on the parent side while the operation
        // child remains suspended forever.
        defer { conn.cancel() }

        do {
            try await waitReady(conn: conn, queue: queue)
            try await sendJSON(["id": UUID().uuidString,
                                "method": "auth.login",
                                "params": ["password": endpoint.password]],
                               on: conn)
            let authReply = try await readJSON(on: conn)
            guard let authOk = authReply["ok"] as? Bool, authOk else {
                throw CallError.authFailed
            }

            try await sendJSON(["id": UUID().uuidString,
                                "method": method,
                                "params": params],
                               on: conn)
            let resp = try await readJSON(on: conn)
            if let ok = resp["ok"] as? Bool, ok,
               let result = resp["result"] as? [String: Any] {
                return result
            }
            if let err = resp["error"] as? [String: Any] {
                throw CallError.server(
                    code: err["code"] as? String ?? "unknown",
                    message: err["message"] as? String ?? "Unknown error"
                )
            }
            throw CallError.invalidResponse
        } catch {
            // On timeout or other errors, force the connection closed
            // before the defer runs so any in-flight Network.framework
            // callbacks resolve immediately and don't leak the
            // continuation past the function return.
            conn.cancel()
            throw error
        }
    }

    private func waitReady(conn: NWConnection, queue: DispatchQueue) async throws {
        try await withTimeout(Self.perStepTimeout, conn: conn) {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let box = ResumeOnce(cont)
                conn.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        conn.stateUpdateHandler = nil
                        box.resume(.success(()))
                    case .failed(let err):
                        conn.stateUpdateHandler = nil
                        box.resume(.failure(CallError.connectionFailed(err.localizedDescription)))
                    case .cancelled:
                        conn.stateUpdateHandler = nil
                        box.resume(.failure(CallError.connectionFailed("cancelled")))
                    default:
                        break
                    }
                }
                conn.start(queue: queue)
            }
        }
    }

    private func sendJSON(_ envelope: [String: Any], on conn: NWConnection) async throws {
        var data = try JSONSerialization.data(withJSONObject: envelope)
        data.append(0x0A)
        try await withTimeout(Self.perStepTimeout, conn: conn) {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let box = ResumeOnce(cont)
                conn.send(content: data, completion: .contentProcessed { err in
                    if let err {
                        box.resume(.failure(CallError.connectionFailed(err.localizedDescription)))
                    } else {
                        box.resume(.success(()))
                    }
                })
            }
        }
    }

    private func readJSON(on conn: NWConnection) async throws -> [String: Any] {
        let line = try await readLine(on: conn)
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CallError.invalidResponse
        }
        return obj
    }

    /// Reads bytes until a newline. Appends each chunk in place to a single
    /// buffer to avoid the O(N²) copy-per-chunk cost of recursive
    /// accumulation; caps at `maxLineBytes` so a non-newline-emitting peer
    /// can't grow the buffer without bound.
    private func readLine(on conn: NWConnection) async throws -> String {
        try await withTimeout(Self.perStepTimeout, conn: conn) {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
                let buffer = Buffer()
                let box = ResumeOnce(cont)
                func step() {
                    conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, isComplete, err in
                        if let err {
                            box.resume(.failure(CallError.connectionFailed(err.localizedDescription)))
                            return
                        }
                        if let data, !data.isEmpty {
                            buffer.bytes.append(data)
                        }
                        if buffer.bytes.count > Self.maxLineBytes {
                            box.resume(.failure(CallError.invalidResponse))
                            return
                        }
                        if let nl = buffer.bytes.firstIndex(of: 0x0A) {
                            let lineData = buffer.bytes.prefix(upTo: nl)
                            box.resume(.success(String(data: lineData, encoding: .utf8) ?? ""))
                            return
                        }
                        if isComplete {
                            let s = String(data: buffer.bytes, encoding: .utf8) ?? ""
                            if s.isEmpty {
                                box.resume(.failure(CallError.invalidResponse))
                            } else {
                                box.resume(.success(s))
                            }
                            return
                        }
                        step()
                    }
                }
                step()
            }
        }
    }

    private final class Buffer { var bytes = Data() }

    /// Wraps a `CheckedContinuation` so that exactly one resume is honored
    /// — extra resume() calls become no-ops instead of crashing. The
    /// underlying NWConnection callback paths run on a serial queue so
    /// races are unlikely, but a defensive guard keeps the contract clean
    /// when a timeout fires concurrently with the final callback.
    private final class ResumeOnce<T> {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<T, Error>?

        init(_ continuation: CheckedContinuation<T, Error>) {
            self.continuation = continuation
        }

        func resume(_ result: Result<T, Error>) {
            lock.lock()
            let cont = continuation
            continuation = nil
            lock.unlock()
            guard let cont else { return }
            switch result {
            case .success(let v): cont.resume(returning: v)
            case .failure(let e): cont.resume(throwing: e)
            }
        }
    }

    /// Races `operation` against a sleep. On timeout we cancel the
    /// connection so any in-flight Network.framework callbacks resolve
    /// (the operation child can't be left suspended after the parent
    /// throws). On success the sleep child is cancelled.
    private func withTimeout<T: Sendable>(
        _ seconds: TimeInterval,
        conn: NWConnection,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                conn.cancel()
                throw CallError.timeout
            }
            do {
                let result = try await group.next()!
                group.cancelAll()
                return result
            } catch {
                group.cancelAll()
                conn.cancel()
                throw error
            }
        }
    }
}

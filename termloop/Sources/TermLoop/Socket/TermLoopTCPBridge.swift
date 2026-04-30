// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import Darwin

/// Optional TCP listener that mirrors the Unix socket command pipeline for mobile
/// clients (e.g. reachable over Tailscale). All TCP-specific state lives here so
/// upstream `TerminalController` stays pristine. The bridge is driven by two
/// single-line hooks in `TerminalController.start()` / `.stop()`.
///
/// Concurrency: BSD socket I/O runs on detached threads; shared state is guarded
/// by an internal lock. The class is `@unchecked Sendable` because its mutable
/// state is only touched under `lock`.
final class TermLoopTCPBridge: @unchecked Sendable {
    static let shared = TermLoopTCPBridge()

    private let lock = NSLock()
    private var fd: Int32 = -1
    private var port: UInt16 = 0
    private var bindHost: String = ""
    private var isRunning = false
    private var clientHandler: ((Int32) -> Void)?

    private init() {}

    /// Start the TCP listener if a port is configured. The supplied `clientHandler`
    /// is invoked on a detached thread for each accepted client socket. Safe to call
    /// repeatedly; no-ops if the bridge is already running.
    func start(clientHandler: @escaping (Int32) -> Void) {
        let alreadyRunning: Bool = {
            lock.lock(); defer { lock.unlock() }
            if isRunning { return true }
            self.clientHandler = clientHandler
            isRunning = true
            return false
        }()
        if alreadyRunning { return }
        startListenerIfConfigured()
    }

    /// Close the listener and release state. Safe to call from any thread.
    func stop() {
        let previousFd: Int32 = {
            lock.lock(); defer { lock.unlock() }
            let prev = fd
            fd = -1
            port = 0
            bindHost = ""
            isRunning = false
            return prev
        }()
        if previousFd >= 0 {
            close(previousFd)
        }
    }

    /// Close the current listener (if any) and re-apply settings. Invoked by the
    /// TermLoop Settings UI when the user changes TCP port / bind-all.
    func reload() {
        let (previousFd, handler) = withLock { () -> (Int32, ((Int32) -> Void)?) in
            let prev = fd
            fd = -1
            port = 0
            bindHost = ""
            return (prev, clientHandler)
        }
        if previousFd >= 0 {
            close(previousFd)
        }
        guard withLock({ isRunning }), handler != nil else { return }
        startListenerIfConfigured()
    }

    /// Snapshot of the listener state for the sidebar TCP status pill.
    /// `port == 0` means "no listener bound" (either UserDefaults are unset or
    /// `bind()` failed). `bindHost` reflects the resolved bind address (e.g.
    /// "0.0.0.0" for bind-all, "127.0.0.1" for loopback).
    struct StatusSnapshot: Equatable {
        let isRunning: Bool
        let port: UInt16
        let bindHost: String
    }

    func currentStatus() -> StatusSnapshot {
        withLock {
            StatusSnapshot(isRunning: isRunning && fd >= 0, port: port, bindHost: bindHost)
        }
    }

    /// Thread-local flag set by `acceptLoop` on every TCP client thread so
    /// `TermLoopSocketCommands.handle` can apply the read-only guardrail
    /// without threading a parameter through upstream `TerminalController`.
    private static let tcpThreadKey = "ai.termloop.isTcpClient"

    /// Thread-local key for the current client socket fd. Set by the accept
    /// loop (TCP) and by `handleClient` entry for Unix clients. Lets
    /// TermLoop hooks read the socket without it being threaded through
    /// upstream `TerminalController.processV2Command`.
    static let currentSocketFdKey = "ai.termloop.currentSocketFd"

    /// Marks the current thread as serving a TCP client. Called from the
    /// accept loop before the upstream handler is invoked.
    static func markCurrentThreadAsTcpClient() {
        Thread.current.threadDictionary[tcpThreadKey] = true
    }

    /// Reads the thread-local flag. Returns `false` on Unix-socket threads or
    /// any thread the bridge didn't mark.
    static func isCurrentThreadTcpClient() -> Bool {
        (Thread.current.threadDictionary[tcpThreadKey] as? Bool) == true
    }

    /// Stores the client socket fd in thread-local storage for the duration
    /// of the `handleClient` call. Called once per client thread (both TCP
    /// and Unix) via a marker-wrapped single-line hook in
    /// `TerminalController.handleClient`.
    static func setCurrentSocketFd(_ fd: Int32) {
        Thread.current.threadDictionary[currentSocketFdKey] = fd
    }

    /// Reads the current socket fd from thread-local storage.
    /// Returns `-1` when not set (e.g. unit-test contexts).
    static func currentSocketFd() -> Int32 {
        (Thread.current.threadDictionary[currentSocketFdKey] as? Int32) ?? -1
    }

    /// Pre-auth filter applied to every incoming TCP client. TCP has no peer PID
    /// / ancestry, so only `.password` and `.allowAll` modes may accept. Writes a
    /// refusal JSON and returns `false` when the connection should be dropped.
    ///
    /// Routed through `TermLoopSocketIO.writeText` for SIGPIPE safety and
    /// to keep the "all client writes go through one helper" contract — even
    /// though this fd is fresh and the upstream `handleClient` accept hook
    /// hasn't run yet, the writeText path is safe to call before
    /// `beginConnection`: it returns `false` (no live state) and we drop
    /// the connection anyway. Doing the setsockopt+write here is preferable
    /// to a raw `write()` because it preserves the single-helper invariant
    /// for any future reviewer auditing client writes.
    static func preflightAuth(socket clientFd: Int32, accessMode: SocketControlMode) -> Bool {
        switch accessMode {
        case .password, .allowAll:
            return true
        case .off, .cmuxOnly, .automation:
            let msg = "{\"ok\":false,\"error\":{\"code\":\"auth_unconfigured\",\"message\":\"TCP bridge requires password access mode\"}}\n"
            // Briefly stand the fd up in the IO registry so writeText
            // succeeds, then immediately retire it — this connection is
            // about to be dropped without entering handleClient.
            TermLoopSocketIO.beginConnection(clientFd)
            _ = TermLoopSocketIO.writeText(msg, to: clientFd)
            TermLoopSocketIO.endConnection(clientFd)
            return false
        }
    }

    // MARK: - private

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    private func startListenerIfConfigured() {
        guard let desiredPort = SocketControlSettings.resolvedTcpPort() else { return }
        let desiredBindHost = SocketControlSettings.resolvedTcpBindHost()

        let listenerFd = socket(AF_INET, SOCK_STREAM, 0)
        guard listenerFd >= 0 else {
            print("TermLoopTCPBridge: failed to create socket (errno=\(errno))")
            return
        }

        var reuse: Int32 = 1
        _ = setsockopt(listenerFd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        memset(&addr, 0, MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(desiredPort).bigEndian

        let parsedInAddr: in_addr_t = desiredBindHost.withCString { cstr in
            var result = in_addr()
            if inet_pton(AF_INET, cstr, &result) == 1 {
                return result.s_addr
            }
            return INADDR_ANY.bigEndian
        }
        addr.sin_addr = in_addr(s_addr: parsedInAddr)

        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(listenerFd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult >= 0 else {
            print("TermLoopTCPBridge: bind failed on \(desiredBindHost):\(desiredPort) (errno=\(errno))")
            close(listenerFd)
            return
        }
        guard listen(listenerFd, 128) >= 0 else {
            print("TermLoopTCPBridge: listen failed (errno=\(errno))")
            close(listenerFd)
            return
        }

        withLock {
            fd = listenerFd
            port = desiredPort
            bindHost = desiredBindHost
        }

        print("TermLoopTCPBridge: listening on \(desiredBindHost):\(desiredPort)")

        Thread.detachNewThread { [weak self] in
            self?.acceptLoop(listenerSocket: listenerFd)
        }
    }

    private func acceptLoop(listenerSocket: Int32) {
        while withLock({ isRunning && fd == listenerSocket }) {
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientFd = withUnsafeMutablePointer(to: &clientAddr) { ptr -> Int32 in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    accept(listenerSocket, sa, &clientLen)
                }
            }
            if clientFd < 0 {
                if errno == EINTR { continue }
                if !withLock({ isRunning && fd == listenerSocket }) {
                    break
                }
                usleep(50_000)
                continue
            }

            let handler = withLock { clientHandler }
            if let handler {
                Thread.detachNewThread {
                    TermLoopTCPBridge.markCurrentThreadAsTcpClient()
                    handler(clientFd)
                }
            } else {
                close(clientFd)
            }
        }
    }
}

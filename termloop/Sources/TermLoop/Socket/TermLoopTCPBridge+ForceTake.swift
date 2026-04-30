// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import Darwin

extension TermLoopTCPBridge {
    /// Kills any other process currently listening on our configured TCP port,
    /// then re-binds our own listener. Used by the sidebar "retry" affordance
    /// when a sibling tagged termloop build has grabbed :7878 and forced us to
    /// show `tcp:off`.
    ///
    /// Runs on a background thread; completion is observed by the sidebar
    /// pill's 1 Hz poll, so there's no callback.
    func forceTakePort() {
        DispatchQueue.global(qos: .userInitiated).async {
            guard let desiredPort = SocketControlSettings.resolvedTcpPort() else { return }
            let myPid = getpid()

            let initial = Self.pidsHoldingPort(desiredPort).filter { $0 != myPid }
            for pid in initial {
                _ = kill(pid, SIGTERM)
            }

            if !initial.isEmpty {
                usleep(300_000)
                let survivors = Self.pidsHoldingPort(desiredPort).filter { $0 != myPid }
                for pid in survivors {
                    _ = kill(pid, SIGKILL)
                }
                if !survivors.isEmpty {
                    usleep(100_000)
                }
            }

            self.reload()
        }
    }

    /// Shells out to `lsof` to list PIDs holding a LISTEN socket on the given
    /// TCP port. Returns empty on any error.
    private static func pidsHoldingPort(_ port: UInt16) -> [pid_t] {
        let task = Process()
        task.launchPath = "/usr/sbin/lsof"
        task.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"]
        let out = Pipe()
        task.standardOutput = out
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
        } catch {
            return []
        }
        out.fileHandleForWriting.closeFile()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard let text = String(data: data, encoding: .utf8) else { return [] }
        return text
            .split(whereSeparator: { $0.isNewline })
            .compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
    }
}

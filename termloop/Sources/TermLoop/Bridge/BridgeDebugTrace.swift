// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Dedicated file trace for bridge persistence and lifecycle events. Written
/// to `/tmp/termloop-bridge-trace.log` so we can debug restart/restore
/// without depending on os.Logger filtering or Bonsplit's tagged debug log.
/// Always-on (no `#if DEBUG`) — keep it until the persistence story is
/// confirmed working, then delete.
enum BridgeDebugTrace {
    private static let queue = DispatchQueue(label: "com.termloop.bridge.trace")
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let logURL: URL = {
        URL(fileURLWithPath: "/tmp/termloop-bridge-trace.log")
    }()

    static func log(_ msg: String) {
        let line = "\(formatter.string(from: Date())) \(msg)\n"
        queue.async {
            if let data = line.data(using: .utf8) {
                if let handle = try? FileHandle(forWritingTo: logURL) {
                    handle.seekToEndOfFile()
                    handle.write(data)
                    try? handle.close()
                } else {
                    try? data.write(to: logURL)
                }
            }
        }
    }
}

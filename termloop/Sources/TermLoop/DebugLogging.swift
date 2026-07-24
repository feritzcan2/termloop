// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Bonsplit
import Foundation
import os

#if DEBUG
private let termLoopDebugLogger = Logger(
    subsystem: "com.termloop.fork",
    category: "debug"
)
private let termLoopRestoreAuditLogger = Logger(
    subsystem: "com.termloop.fork",
    category: "restore-audit"
)

@inline(__always)
func dlog(_ message: String) {
    termLoopDebugLogger.debug("\(message, privacy: .public)")
}

/// Restore diagnostics need to survive the process that emitted them. Keep
/// these events in both Unified Logging and the DEBUG event-log file so a
/// failed relaunch can be investigated after the app has already restarted.
@inline(__always)
func restoreAuditLog(_ message: String) {
    let rendered = "restore.audit pid=\(ProcessInfo.processInfo.processIdentifier) \(message)"
    termLoopRestoreAuditLogger.debug("\(rendered, privacy: .public)")
    DebugEventLog.shared.log(rendered)
}
#else
@inline(__always)
func dlog(_ message: String) {}

@inline(__always)
func restoreAuditLog(_ message: String) {}
#endif

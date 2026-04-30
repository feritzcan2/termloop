// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import os

#if DEBUG
private let termLoopDebugLogger = Logger(
    subsystem: "com.termloop.fork",
    category: "debug"
)

@inline(__always)
func dlog(_ message: String) {
    termLoopDebugLogger.debug("\(message, privacy: .public)")
}
#else
@inline(__always)
func dlog(_ message: String) {}
#endif

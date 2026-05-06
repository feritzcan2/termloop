// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// WCSession message keys. Both iOS and watchOS targets ship this file so
/// the dict shapes agree on the wire.
enum WatchBridgeMessage {
    static let kindKey = "kind"
    static let kindLaunch = "launch_agent"

    static let promptKey = "prompt"

    static let okKey = "ok"
    static let branchKey = "branch"
    static let errorKey = "error"
}

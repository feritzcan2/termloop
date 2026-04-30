// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Observes the TermLoop TCP bridge UserDefaults and reloads the listener on change.
/// Inserted into the upstream `cmuxApp` root via `.background(...)` as a single-line hook.
struct TermLoopTCPBridgeCoordinator: View {
    @AppStorage(SocketControlSettings.tcpPortDefaultsKey)
    private var tcpPort = Int(SocketControlSettings.tcpPortDefault)
    @AppStorage(SocketControlSettings.tcpBindAllDefaultsKey) private var tcpBindAll = true

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .onChange(of: tcpPort) { _ in
                TermLoopTCPBridge.shared.reload()
            }
            .onChange(of: tcpBindAll) { _ in
                TermLoopTCPBridge.shared.reload()
            }
    }
}

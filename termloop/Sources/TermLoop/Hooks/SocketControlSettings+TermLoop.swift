// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

extension SocketControlSettings {
    static let tcpPortDefaultsKey = "socketControl.tcpPort"
    static let tcpBindAllDefaultsKey = "socketControl.tcpBindAll"
    static let tcpPortEnvKey = "TERMLOOP_SOCKET_TCP_PORT"
    static let tcpBindEnvKey = "TERMLOOP_SOCKET_TCP_BIND"

    /// Built-in TCP port used when the user has not configured one. Chosen to
    /// match what the mobile client expects out of the box so the bridge is
    /// on by default and new installs (or fresh tagged debug builds) don't
    /// need a Settings visit to start accepting connections.
    static let tcpPortDefault: UInt16 = 7878

    /// Returns configured TCP port (env overrides UserDefaults).
    ///
    /// Resolution order:
    /// 1. `TERMLOOP_SOCKET_TCP_PORT` env — wins outright. Empty string or zero
    ///    disables (returns nil).
    /// 2. `socketControl.tcpPort` UserDefaults — if the key exists the user
    ///    has an opinion: positive = port, 0 = "disable bridge".
    /// 3. Key absent → fall back to `tcpPortDefault` so the bridge is on by
    ///    default. This is what the "Leave empty to disable" copy in the
    ///    Settings card refers to — the user explicitly writes 0 to disable.
    static func resolvedTcpPort(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard
    ) -> UInt16? {
        if let raw = environment[tcpPortEnvKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !raw.isEmpty {
            if let v = UInt16(raw), v > 0 { return v }
            return nil
        }
        guard defaults.object(forKey: tcpPortDefaultsKey) != nil else {
            return tcpPortDefault
        }
        let stored = defaults.integer(forKey: tcpPortDefaultsKey)
        guard stored > 0, stored <= Int(UInt16.max) else { return nil }
        return UInt16(stored)
    }

    /// Returns bind host. Default is `0.0.0.0` so Tailscale peers can reach the bridge.
    static func resolvedTcpBindHost(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard
    ) -> String {
        if let raw = environment[tcpBindEnvKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !raw.isEmpty {
            return raw
        }
        let explicit = defaults.object(forKey: tcpBindAllDefaultsKey) as? Bool
        return (explicit ?? true) ? "0.0.0.0" : "127.0.0.1"
    }
}

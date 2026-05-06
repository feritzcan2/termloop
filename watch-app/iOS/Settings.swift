// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Connection settings + APNs token cache. Persisted in UserDefaults for
/// MVP — production should move credentials to Keychain.
final class WatchAppSettings: ObservableObject {
    static let shared = WatchAppSettings()

    private enum Key {
        static let host = "tl_host"
        static let port = "tl_port"
        static let password = "tl_password"
        static let pendingPushToken = "tl_pending_push_token"
        static let registeredPushToken = "tl_registered_push_token"
    }

    @Published var host: String { didSet { UserDefaults.standard.set(host, forKey: Key.host) } }
    @Published var port: Int    { didSet { UserDefaults.standard.set(port, forKey: Key.port) } }
    @Published var password: String { didSet { UserDefaults.standard.set(password, forKey: Key.password) } }

    /// APNs token captured before the user finished filling host/port/password.
    /// Cleared on successful `push.register`.
    var pendingPushToken: String? {
        get { UserDefaults.standard.string(forKey: Key.pendingPushToken) }
        set { UserDefaults.standard.set(newValue, forKey: Key.pendingPushToken) }
    }

    /// Last successfully-registered `(token, endpoint, env)` triple, joined
    /// by `\n`. iOS may call `didRegister...` on every cold launch — we
    /// skip the redundant TCP round-trip when the same triple has already
    /// been delivered. Endpoint/env are part of the key so changing the
    /// host or DEBUG-vs-release re-registers automatically.
    var registeredPushFingerprint: String? {
        get { UserDefaults.standard.string(forKey: Key.registeredPushToken) }
        set { UserDefaults.standard.set(newValue, forKey: Key.registeredPushToken) }
    }

    static func pushFingerprint(token: String,
                                endpoint: TermLoopRPC.Endpoint,
                                environment: String) -> String {
        "\(token)\n\(endpoint.host):\(endpoint.port)\n\(environment)"
    }

    private init() {
        let d = UserDefaults.standard
        self.host = d.string(forKey: Key.host) ?? ""
        self.port = (d.object(forKey: Key.port) as? Int) ?? 7878
        self.password = d.string(forKey: Key.password) ?? ""
    }

    var endpoint: TermLoopRPC.Endpoint? {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty,
              port > 0,
              port < 65536,
              !password.isEmpty else { return nil }
        return TermLoopRPC.Endpoint(host: trimmedHost,
                                    port: UInt16(port),
                                    password: password)
    }

    /// "development" in DEBUG, "production" otherwise — matches Apple's
    /// APNs sandbox/prod split.
    static var apnsEnvironment: String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }
}

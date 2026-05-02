// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Socket command dispatch owned by the mobile bridge.
///
/// Keeping this separate prevents mobile-only auth/pairing concerns from
/// growing inside the general TermLoop socket registry.
@MainActor
enum TermLoopMobileSocketCommands {
    static let preAuthCredentialMethods: Set<String> = [
        "auth.token",
        "pairing.claim"
    ]

    static func handle(
        method: String,
        params: [String: Any],
        isTcpClient: Bool
    ) -> TerminalController.V2CallResult? {
        switch method {
        case "auth.token":
            return TermLoopMobilePairingStore.authenticate(params: params)
        case "pairing.create":
            guard !isTcpClient else {
                return .err(
                    code: "forbidden",
                    message: "pairing.create requires a local TermLoop client",
                    data: nil
                )
            }
            return TermLoopMobilePairingStore.createPairing(params: params)
        case "pairing.claim":
            return TermLoopMobilePairingStore.claim(params: params)
        case "pairing.list_devices":
            return TermLoopMobilePairingStore.listDevices()
        case "pairing.revoke_device":
            return TermLoopMobilePairingStore.revokeDevice(params: params)
        default:
            return nil
        }
    }

    static func handlePreAuthCredential(
        method: String,
        params: [String: Any]
    ) -> TerminalController.V2CallResult? {
        guard preAuthCredentialMethods.contains(method) else { return nil }
        switch method {
        case "auth.token":
            return TermLoopMobilePairingStore.authenticate(params: params)
        case "pairing.claim":
            return TermLoopMobilePairingStore.claim(params: params)
        default:
            return nil
        }
    }
}

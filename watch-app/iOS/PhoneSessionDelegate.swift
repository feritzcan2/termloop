// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import WatchConnectivity

/// iPhone-side WCSession delegate. Receives `launch_agent` messages from
/// the Watch, forwards to the TermLoop TCP RPC, replies with the resulting
/// branch name (or error string).
final class PhoneSessionDelegate: NSObject, WCSessionDelegate {
    static let shared = PhoneSessionDelegate()

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {}

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }

    func session(_ session: WCSession,
                 didReceiveMessage message: [String: Any],
                 replyHandler: @escaping ([String: Any]) -> Void) {
        guard message[WatchBridgeMessage.kindKey] as? String == WatchBridgeMessage.kindLaunch else {
            replyHandler(rejection("unknown_kind"))
            return
        }
        let prompt = (message[WatchBridgeMessage.promptKey] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !prompt.isEmpty else {
            replyHandler(rejection("empty_prompt"))
            return
        }
        guard let endpoint = WatchAppSettings.shared.endpoint else {
            replyHandler(rejection("not_configured"))
            return
        }

        Task {
            let rpc = TermLoopRPC(endpoint: endpoint)
            do {
                let branch = try await rpc.launchAgent(prompt: prompt)
                replyHandler([
                    WatchBridgeMessage.okKey: true,
                    WatchBridgeMessage.branchKey: branch
                ])
            } catch {
                replyHandler(rejection(error.localizedDescription))
            }
        }
    }

    private func rejection(_ message: String) -> [String: Any] {
        [WatchBridgeMessage.okKey: false, WatchBridgeMessage.errorKey: message]
    }
}

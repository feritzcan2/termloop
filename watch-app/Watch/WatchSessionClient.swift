// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import WatchConnectivity

/// watchOS-side WCSession client. Sends `launch_agent` messages to the
/// iPhone companion and waits for the reply.
final class WatchSessionClient: NSObject, WCSessionDelegate, ObservableObject {
    static let shared = WatchSessionClient()

    enum SendError: Error, LocalizedError {
        case sessionNotActivated
        case rejected(String)

        var errorDescription: String? {
            switch self {
            case .sessionNotActivated:
                return "Watch session not activated"
            case .rejected(let s):
                return s
            }
        }
    }

    @Published var isActivated = false

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    func sendLaunch(prompt: String) async throws -> String {
        let session = WCSession.default
        guard session.activationState == .activated else {
            throw SendError.sessionNotActivated
        }
        // Don't pre-check `isReachable`. WCSession.sendMessage on a paired
        // (but not currently reachable) iPhone wakes the companion app
        // briefly; pre-checking turns that into a hard failure.
        let message: [String: Any] = [
            WatchBridgeMessage.kindKey: WatchBridgeMessage.kindLaunch,
            WatchBridgeMessage.promptKey: prompt
        ]
        return try await withCheckedThrowingContinuation { cont in
            session.sendMessage(message, replyHandler: { reply in
                if let ok = reply[WatchBridgeMessage.okKey] as? Bool, ok,
                   let branch = reply[WatchBridgeMessage.branchKey] as? String {
                    cont.resume(returning: branch)
                } else {
                    let msg = reply[WatchBridgeMessage.errorKey] as? String ?? "Unknown error"
                    cont.resume(throwing: SendError.rejected(msg))
                }
            }, errorHandler: { err in
                cont.resume(throwing: err)
            })
        }
    }

    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        Task { @MainActor in
            self.isActivated = (activationState == .activated)
        }
    }
}

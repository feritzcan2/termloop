// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import UIKit
import UserNotifications

/// Owns the APNs registration handshake and incoming-notification handling.
///
/// 1. Ask the user for notification permission.
/// 2. `registerForRemoteNotifications()` ⇒ system delivers a token to
///    `AppDelegate.application(_:didRegister...)`.
/// 3. Forward the token to the Mac via `push.register` so `PushDispatcher`
///    starts targeting this device.
/// 4. Register a UN category with a `UNTextInputNotificationAction` so the
///    notification (mirrored to Watch) shows a Reply action with built-in
///    dictation.
/// 5. When the user submits a reply, hand the transcript back to the Mac
///    via `watch.send_prompt`.
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    static let attentionCategoryId = "TERMLOOP_ATTENTION"
    static let replyActionId = "TERMLOOP_REPLY"

    func bootstrap() {
        UNUserNotificationCenter.current().delegate = self
        registerCategories()
        Task { @MainActor in
            await requestPermissionAndRegister()
        }
    }

    private func registerCategories() {
        let reply = UNTextInputNotificationAction(
            identifier: Self.replyActionId,
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Voice reply…"
        )
        let category = UNNotificationCategory(
            identifier: Self.attentionCategoryId,
            actions: [reply],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    @MainActor
    private func requestPermissionAndRegister() async {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .badge, .sound])
            guard granted else { return }
        } catch {
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didReceiveDeviceToken(_ token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        let settings = WatchAppSettings.shared
        guard let endpoint = settings.endpoint else {
            settings.pendingPushToken = hex
            return
        }
        let env = WatchAppSettings.apnsEnvironment
        let fingerprint = WatchAppSettings.pushFingerprint(
            token: hex, endpoint: endpoint, environment: env
        )
        if settings.registeredPushFingerprint == fingerprint {
            return
        }
        Task {
            let rpc = TermLoopRPC(endpoint: endpoint)
            do {
                try await rpc.registerPush(deviceToken: hex, environment: env)
                settings.registeredPushFingerprint = fingerprint
                settings.pendingPushToken = nil
            } catch {
                NSLog("push.register failed: \(error)")
                settings.pendingPushToken = hex
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // The iPhone here is a passive forwarder; the user is on the Mac,
        // so foreground silence isn't useful.
        completionHandler([.banner, .sound, .badge])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard response.actionIdentifier == Self.replyActionId,
              let textResponse = response as? UNTextInputNotificationResponse else {
            return
        }
        let userInfo = response.notification.request.content.userInfo
        let workspaceId = (userInfo["workspace_id"] as? String) ?? ""
        let text = textResponse.userText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !workspaceId.isEmpty, !text.isEmpty,
              let endpoint = WatchAppSettings.shared.endpoint else { return }
        Task {
            let rpc = TermLoopRPC(endpoint: endpoint)
            do {
                try await rpc.sendPrompt(workspaceId: workspaceId, text: text)
            } catch {
                NSLog("watch.send_prompt failed: \(error)")
            }
        }
    }
}

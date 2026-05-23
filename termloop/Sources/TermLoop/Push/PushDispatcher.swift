// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import CoreGraphics
import Foundation

@MainActor
final class PushDispatcher {
    static let shared = PushDispatcher()
    static let workspaceCooldownInterval: TimeInterval = 120
    /// If the Mac user has produced any input in the last N seconds, we
    /// consider them "at the Mac" and suppress non-urgent pushes. Urgent
    /// attentions (.permission, .error) bypass this.
    static let activeUserIdleThresholdSeconds: TimeInterval = 60

    private var client: APNsClient?
    private var subscription: EventBus.SubscriptionHandle?
    private var started = false
    private var lastPushDateByWorkspaceId: [UUID: Date] = [:]

    func start() {
        guard !started else { return }
        started = true
        guard let config = APNsConfig.load() else {
            NSLog("PushDispatcher: APNs config missing, push disabled")
            return
        }
        do {
            self.client = try APNsClient(config: config)
        } catch {
            NSLog("PushDispatcher: failed to init APNsClient: \(error)")
            return
        }

        self.subscription = EventBus.shared.subscribe(
            types: ["workspace.attention"],
            workspaceIds: nil
        ) { [weak self] event in
            Task { @MainActor in
                await self?.handle(event: event)
            }
        }
    }

    private func handle(event: EventBus.Event) async {
        guard let record = PushTokenStore.shared.currentRecord() else { return }
        guard let client = self.client else { return }

        let data = event.payload
        let attentionKind = (data["attention_kind"] as? String)
            .flatMap(TerminalAgentAttentionKind.init(rawValue:))
        let now = Date()
        guard !Self.shouldSuppressPushDelivery(
            workspaceId: event.workspaceId,
            isAppFocused: AppFocusState.isAppFocused(),
            selectedWorkspaceId: AppDelegate.shared?.tabManager?.selectedTabId,
            userIdleSeconds: Self.userIdleSeconds(),
            isScreenLocked: Self.isScreenLocked(),
            attentionKind: attentionKind
        ) else {
            return
        }
        guard !shouldThrottlePush(
            workspaceId: event.workspaceId,
            attentionKind: attentionKind,
            now: now
        ) else {
            return
        }

        let wsId = event.workspaceId.uuidString
        let preview = (data["message_preview"] as? String) ?? ""
        let wsName = resolveWorkspaceName(workspaceId: event.workspaceId) ?? String(wsId.prefix(6))

        let needsInputTitle: Bool
        switch attentionKind {
        case .notification, .permission, .error:
            needsInputTitle = true
        case .completion, .userInput, .none:
            needsInputTitle = false
        }
        let title = needsInputTitle ? "\(wsName) · izin bekliyor" : wsName
        let body = preview.isEmpty ? "Agent cevap bekliyor" : preview

        let payload = APNsPayload(
            aps: .init(
                alert: .init(title: title, body: body),
                category: "TERMLOOP_ATTENTION",
                sound: "default",
                mutableContent: 1,
                contentAvailable: nil
            ),
            workspaceId: wsId,
            attentionKind: attentionKind?.rawValue
        )

        let result = await client.sendWithFallback(
            payload: payload,
            deviceToken: record.deviceToken,
            primaryEnvironment: record.environment
        )

        switch result {
        case .success:
            if Self.shouldApplyCooldown(attentionKind: attentionKind) {
                lastPushDateByWorkspaceId[event.workspaceId] = now
            }
        case .badDeviceToken:
            NSLog("PushDispatcher: token invalid in both envs, unregistering")
            PushTokenStore.shared.unregister(deviceToken: record.deviceToken)
        case .otherError(let status, let body):
            NSLog("PushDispatcher: APNs error \(status): \(body)")
        case .transportError(let e):
            NSLog("PushDispatcher: transport error: \(e)")
        }
    }

    private func resolveWorkspaceName(workspaceId: UUID) -> String? {
        AppDelegate.shared?.workspaceFor(tabId: workspaceId)?.title
    }

    private func shouldThrottlePush(
        workspaceId: UUID,
        attentionKind: TerminalAgentAttentionKind?,
        now: Date
    ) -> Bool {
        guard Self.shouldApplyCooldown(attentionKind: attentionKind),
              let lastPushDate = lastPushDateByWorkspaceId[workspaceId] else {
            return false
        }
        return now.timeIntervalSince(lastPushDate) < Self.workspaceCooldownInterval
    }

    static func shouldSuppressPushDelivery(
        workspaceId: UUID,
        isAppFocused: Bool,
        selectedWorkspaceId: UUID?,
        userIdleSeconds: TimeInterval,
        isScreenLocked: Bool,
        attentionKind: TerminalAgentAttentionKind?
    ) -> Bool {
        // Screen locked → user is away from Mac, deliver everything.
        if isScreenLocked { return false }
        // App focused on this exact workspace → user is already looking at
        // it, no need to ping mobile.
        if isAppFocused && selectedWorkspaceId == workspaceId { return true }
        // Recent user input on the Mac → user is at the desk. Suppress
        // routine attentions; pass urgent ones (permission/error).
        if userIdleSeconds < activeUserIdleThresholdSeconds {
            switch attentionKind {
            case .permission, .error:
                return false
            case .completion, .notification, .userInput, .none:
                return true
            }
        }
        return false
    }

    /// Seconds since the last system-wide HID input event (mouse, keyboard,
    /// trackpad). Returns `.infinity` if the underlying event source can
    /// not be queried, which fail-opens to "user is idle".
    static func userIdleSeconds() -> TimeInterval {
        guard let anyInput = CGEventType(rawValue: ~UInt32(0)) else {
            return .infinity
        }
        return CGEventSource.secondsSinceLastEventType(
            .combinedSessionState,
            eventType: anyInput
        )
    }

    static func isScreenLocked() -> Bool {
        guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else {
            return false
        }
        if let locked = dict["CGSSessionScreenIsLocked"] as? Bool {
            return locked
        }
        if let lockedNum = dict["CGSSessionScreenIsLocked"] as? Int {
            return lockedNum != 0
        }
        return false
    }

    static func shouldApplyCooldown(attentionKind: TerminalAgentAttentionKind?) -> Bool {
        switch attentionKind {
        case .permission, .error:
            return false
        case .completion, .notification, .userInput, .none:
            return true
        }
    }
}

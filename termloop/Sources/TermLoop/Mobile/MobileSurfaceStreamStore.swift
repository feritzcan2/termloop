// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Foundation

/// Owns mobile `surface.subscribe` streams.
///
/// V2 deliberately keeps this in the mobile backend layer: the general socket
/// dispatcher remains transport/API plumbing, while this store owns mobile's
/// terminal-surface live view contract.
final class TermLoopMobileSurfaceStreamStore: @unchecked Sendable {
    static let shared = TermLoopMobileSurfaceStreamStore()

    private final class Entry {
        let id: UUID
        let socket: Int32
        let workspaceId: String
        let surfaceId: String?
        let timer: DispatchSourceTimer
        var lastText: String

        init(
            id: UUID,
            socket: Int32,
            workspaceId: String,
            surfaceId: String?,
            lastText: String,
            timer: DispatchSourceTimer
        ) {
            self.id = id
            self.socket = socket
            self.workspaceId = workspaceId
            self.surfaceId = surfaceId
            self.lastText = lastText
            self.timer = timer
        }
    }

    private let lock = NSLock()
    private var entries: [UUID: Entry] = [:]
    private var idsBySocket: [Int32: Set<UUID>] = [:]

    private static let pollIntervalMs: Int = 350
    private static let maxPushedTextChars = 64_000

    private init() {}

    @MainActor
    func subscribe(params: [String: Any], socketFd: Int32 = -1) -> TerminalController.V2CallResult {
        guard let workspaceId = normalizedString(params["workspace_id"]) else {
            return .err(code: "invalid_params", message: "Missing workspace_id", data: nil)
        }
        let surfaceId = normalizedString(params["surface_id"])
        let socket = socketFd >= 0 ? socketFd : TermLoopTCPBridge.currentSocketFd()
        guard socket >= 0 else {
            return .err(code: "unavailable", message: "No active socket for subscription", data: nil)
        }

        let initial = TerminalController.shared.termLoopMobileReadSurfaceText(
            workspaceId: workspaceId,
            surfaceId: surfaceId
        )
        let initialText: String
        if case .ok(let payload) = initial,
           let dict = payload as? [String: Any],
           let text = dict["text"] as? String {
            initialText = capLeft(text)
        } else {
            // Surface startup can lag behind workspace/surface discovery.
            // Subscription should still establish so mobile does not fall
            // back to polling just because the first snapshot was early.
            initialText = ""
        }

        let id = UUID()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        let entry = Entry(
            id: id,
            socket: socket,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            lastText: initialText,
            timer: timer
        )

        lock.lock()
        entries[id] = entry
        idsBySocket[socket, default: []].insert(id)
        lock.unlock()

        timer.schedule(
            deadline: .now() + .milliseconds(Self.pollIntervalMs),
            repeating: .milliseconds(Self.pollIntervalMs)
        )
        timer.setEventHandler { [weak self] in
            self?.poll(subscriptionId: id)
        }
        timer.resume()

        if !entry.lastText.isEmpty {
            push(type: "surface.snapshot", subscriptionId: id, text: entry.lastText, socket: socket)
        }
        return .ok(["subscription_id": id.uuidString])
    }

    func unsubscribe(params: [String: Any], socketFd: Int32 = -1) -> TerminalController.V2CallResult {
        guard let idString = normalizedString(params["subscription_id"]),
              let id = UUID(uuidString: idString) else {
            return .err(code: "invalid_params", message: "Missing or invalid subscription_id", data: nil)
        }

        let socket = socketFd >= 0 ? socketFd : TermLoopTCPBridge.currentSocketFd()
        guard unsubscribe(id: id, socket: socket) else {
            return .ok(["subscription_id": idString, "unsubscribed": false])
        }
        return .ok(["subscription_id": idString, "unsubscribed": true])
    }

    func disposeConnection(for socket: Int32) {
        let removed: [Entry] = {
            lock.lock(); defer { lock.unlock() }
            let ids = idsBySocket.removeValue(forKey: socket) ?? []
            return ids.compactMap { entries.removeValue(forKey: $0) }
        }()
        for entry in removed {
            entry.timer.cancel()
        }
    }

    private func unsubscribe(id: UUID, socket: Int32) -> Bool {
        let removed: Entry? = {
            lock.lock(); defer { lock.unlock() }
            guard let entry = entries[id] else { return nil }
            if socket >= 0, entry.socket != socket { return nil }
            entries.removeValue(forKey: id)
            if var ids = idsBySocket[entry.socket] {
                ids.remove(id)
                if ids.isEmpty {
                    idsBySocket.removeValue(forKey: entry.socket)
                } else {
                    idsBySocket[entry.socket] = ids
                }
            }
            return entry
        }()
        removed?.timer.cancel()
        return removed != nil
    }

    private func poll(subscriptionId: UUID) {
        let snapshot: (workspaceId: String, surfaceId: String?)? = {
            lock.lock(); defer { lock.unlock() }
            guard let entry = entries[subscriptionId] else { return nil }
            return (entry.workspaceId, entry.surfaceId)
        }()
        guard let snapshot else { return }

        Task { @MainActor in
            let result = TerminalController.shared.termLoopMobileReadSurfaceText(
                workspaceId: snapshot.workspaceId,
                surfaceId: snapshot.surfaceId
            )
            TermLoopMobileSurfaceStreamStore.shared.deliverPollResult(
                subscriptionId: subscriptionId,
                result: result
            )
        }
    }

    private func deliverPollResult(
        subscriptionId: UUID,
        result: TerminalController.V2CallResult
    ) {
        switch result {
        case .ok(let payload):
            guard let dict = payload as? [String: Any],
                  let rawText = dict["text"] as? String else {
                sendErrorAndDrop(subscriptionId: subscriptionId, message: "Failed to read surface snapshot")
                return
            }
            let text = capLeft(rawText)
            let event: (type: String, text: String, socket: Int32)? = {
                lock.lock(); defer { lock.unlock() }
                guard let entry = entries[subscriptionId] else { return nil }
                guard entry.lastText != text else { return nil }
                let old = entry.lastText
                entry.lastText = text
                if text.hasPrefix(old) {
                    let suffix = String(text.dropFirst(old.count))
                    return ("surface.output", suffix, entry.socket)
                }
                return ("surface.snapshot", text, entry.socket)
            }()
            if let event {
                push(
                    type: event.type,
                    subscriptionId: subscriptionId,
                    text: event.text,
                    socket: event.socket
                )
            }
        case .err(let code, let message, _):
            if code == "not_found" || code == "invalid_params" || code == "internal_error" {
                // Terminal surfaces may be briefly unavailable while Ghostty
                // attaches or after a workspace switch. Keep the subscription
                // alive and retry instead of degrading mobile to polling.
                return
            }
            sendErrorAndDrop(subscriptionId: subscriptionId, message: message)
        }
    }

    private func sendClosedAndDrop(subscriptionId: UUID) {
        guard let entry = remove(subscriptionId: subscriptionId) else { return }
        writeFrame(["type": "surface.closed", "subscription_id": subscriptionId.uuidString], to: entry.socket)
    }

    private func sendErrorAndDrop(subscriptionId: UUID, message: String) {
        guard let entry = remove(subscriptionId: subscriptionId) else { return }
        writeFrame([
            "type": "surface.error",
            "subscription_id": subscriptionId.uuidString,
            "message": message
        ], to: entry.socket)
    }

    private func remove(subscriptionId: UUID) -> Entry? {
        let removed: Entry? = {
            lock.lock(); defer { lock.unlock() }
            guard let entry = entries.removeValue(forKey: subscriptionId) else { return nil }
            if var ids = idsBySocket[entry.socket] {
                ids.remove(subscriptionId)
                if ids.isEmpty {
                    idsBySocket.removeValue(forKey: entry.socket)
                } else {
                    idsBySocket[entry.socket] = ids
                }
            }
            return entry
        }()
        removed?.timer.cancel()
        return removed
    }

    private func push(type: String, subscriptionId: UUID, text: String, socket: Int32) {
        writeFrame([
            "type": type,
            "subscription_id": subscriptionId.uuidString,
            "text": text
        ], to: socket)
    }

    private func writeFrame(_ object: [String: Any], to socket: Int32) {
        guard socket >= 0,
              JSONSerialization.isValidJSONObject(object),
              let bytes = try? JSONSerialization.data(withJSONObject: object, options: []) else {
            return
        }
        var payload = bytes
        payload.append(UInt8(ascii: "\n"))
        if !TermLoopSocketIO.writeFrame(socket, bytes: payload) {
            disposeConnection(for: socket)
        }
    }

    private func capLeft(_ text: String) -> String {
        guard text.count > Self.maxPushedTextChars else { return text }
        return String(text.suffix(Self.maxPushedTextChars))
    }

    private func normalizedString(_ raw: Any?) -> String? {
        guard let value = raw as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

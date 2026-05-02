// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import CryptoKit
import Foundation
#if canImport(Security)
import Security
#endif

/// Minimal credential store for QR/mobile pairing.
///
/// Pairing tokens are intentionally short-lived and memory-only. Claimed mobile
/// devices get a persistent opaque access token whose SHA-256 hash is stored
/// under Application Support alongside the socket password file.
enum TermLoopMobilePairingStore {
    private struct PairingSession {
        let id: String
        let token: String
        let serverName: String?
        let createdAt: TimeInterval
        let expiresAt: TimeInterval
    }

    private struct DeviceRecord: Codable {
        let deviceId: String
        var deviceName: String
        var tokenHash: String
        let createdAt: TimeInterval
        var lastSeenAt: TimeInterval?
        var revokedAt: TimeInterval?
    }

    private struct DeviceFile: Codable {
        var version: Int
        var devices: [DeviceRecord]
    }

    private static let lock = NSLock()
    private static var pairings: [String: PairingSession] = [:]
    private static var cachedDevices: [DeviceRecord]?
    private static let defaultPairingTTL: TimeInterval = 120
    private static let maxPairingTTL: TimeInterval = 600
    private static let minPairingTTL: TimeInterval = 30
    private static let revokedDeviceRetention: TimeInterval = 30 * 24 * 60 * 60
    private static let maxStoredDevices = 100

    static func createPairing(params: [String: Any]) -> TerminalController.V2CallResult {
        let ttlSeconds = sanitizedTTL(params["ttl_seconds"])
        let now = Date().timeIntervalSince1970
        let session = PairingSession(
            id: UUID().uuidString,
            token: randomToken(),
            serverName: nonEmptyString(params["server_name"]),
            createdAt: now,
            expiresAt: now + ttlSeconds
        )

        lock.lock()
        pruneExpiredPairingsLocked(now: now)
        pairings[session.token] = session
        lock.unlock()

        var result: [String: Any] = [
            "pairing_id": session.id,
            "token": session.token,
            "expires_at": session.expiresAt,
            "ttl_seconds": Int(ttlSeconds),
            "port": SocketControlSettings.resolvedTcpPort() as Any? ?? NSNull()
        ]
        result["server_name"] = session.serverName as Any? ?? NSNull()
        return .ok(result)
    }

    static func claim(params: [String: Any]) -> TerminalController.V2CallResult {
        guard let token = nonEmptyString(params["token"]) else {
            return .err(code: "invalid_params", message: "pairing.claim requires token", data: nil)
        }
        let deviceName = nonEmptyString(params["device_name"]) ?? "Mobile device"
        let now = Date().timeIntervalSince1970

        lock.lock()
        pruneExpiredPairingsLocked(now: now)
        guard let session = pairings.removeValue(forKey: token) else {
            lock.unlock()
            return .err(code: "pairing_invalid", message: "Pairing token is invalid or expired", data: nil)
        }
        let accessToken = randomToken()
        var devices = loadDevicesLocked()
        let requestedDeviceId = nonEmptyString(params["device_id"])
        let record: DeviceRecord
        if let requestedDeviceId,
           let index = devices.firstIndex(where: { $0.deviceId == requestedDeviceId }) {
            devices[index].deviceName = deviceName
            devices[index].tokenHash = tokenHash(accessToken)
            devices[index].lastSeenAt = now
            devices[index].revokedAt = nil
            record = devices[index]
        } else {
            record = DeviceRecord(
                deviceId: UUID().uuidString,
                deviceName: deviceName,
                tokenHash: tokenHash(accessToken),
                createdAt: now,
                lastSeenAt: now,
                revokedAt: nil
            )
            devices.append(record)
        }
        devices = prunedDevices(devices, now: now)
        let saved = saveDevicesLocked(devices)
        lock.unlock()

        guard saved else {
            return .err(code: "internal_error", message: "Failed to save paired mobile device", data: nil)
        }

        return .ok([
            "authenticated": true,
            "device_id": record.deviceId,
            "device_name": record.deviceName,
            "access_token": accessToken,
            "server_name": session.serverName as Any? ?? NSNull(),
            "capabilities": mobileCapabilities()
        ])
    }

    static func authenticate(params: [String: Any]) -> TerminalController.V2CallResult {
        guard let deviceId = nonEmptyString(params["device_id"]) else {
            return .err(code: "invalid_params", message: "auth.token requires device_id", data: nil)
        }
        guard let accessToken = nonEmptyString(params["access_token"]) else {
            return .err(code: "invalid_params", message: "auth.token requires access_token", data: nil)
        }

        let now = Date().timeIntervalSince1970
        lock.lock()
        var devices = loadDevicesLocked()
        guard let index = devices.firstIndex(where: { $0.deviceId == deviceId }) else {
            lock.unlock()
            return .err(code: "auth_failed", message: "Unknown mobile device", data: nil)
        }
        guard devices[index].revokedAt == nil,
              devices[index].tokenHash == tokenHash(accessToken) else {
            lock.unlock()
            return .err(code: "auth_failed", message: "Invalid mobile access token", data: nil)
        }
        devices[index].lastSeenAt = now
        let record = devices[index]
        _ = saveDevicesLocked(prunedDevices(devices, now: now))
        lock.unlock()

        return .ok([
            "authenticated": true,
            "device_id": record.deviceId,
            "device_name": record.deviceName,
            "capabilities": mobileCapabilities()
        ])
    }

    static func listDevices() -> TerminalController.V2CallResult {
        lock.lock()
        let devices = loadDevicesLocked()
        lock.unlock()
        return .ok([
            "devices": devices.map(devicePayload)
        ])
    }

    static func revokeDevice(params: [String: Any]) -> TerminalController.V2CallResult {
        guard let deviceId = nonEmptyString(params["device_id"]) else {
            return .err(code: "invalid_params", message: "pairing.revoke_device requires device_id", data: nil)
        }
        let now = Date().timeIntervalSince1970
        lock.lock()
        var devices = loadDevicesLocked()
        guard let index = devices.firstIndex(where: { $0.deviceId == deviceId }) else {
            lock.unlock()
            return .err(code: "not_found", message: "Mobile device not found", data: nil)
        }
        devices[index].revokedAt = now
        let saved = saveDevicesLocked(prunedDevices(devices, now: now))
        lock.unlock()
        guard saved else {
            return .err(code: "internal_error", message: "Failed to revoke mobile device", data: nil)
        }
        return .ok(["revoked": true, "device_id": deviceId])
    }

    static func restoreBridgeSettingsForPairedDevicesIfNeeded(defaults: UserDefaults = .standard) {
        guard defaults.object(forKey: SocketControlSettings.tcpPortDefaultsKey) == nil else {
            return
        }

        lock.lock()
        let hasActiveDevice = loadDevicesLocked().contains { $0.revokedAt == nil }
        lock.unlock()
        guard hasActiveDevice else { return }

        defaults.set(Int(SocketControlSettings.tcpPortDefault),
                     forKey: SocketControlSettings.tcpPortDefaultsKey)
        defaults.set(true, forKey: SocketControlSettings.tcpBindAllDefaultsKey)
        if defaults.object(forKey: SocketControlSettings.appStorageKey) == nil {
            defaults.set(SocketControlMode.password.rawValue,
                         forKey: SocketControlSettings.appStorageKey)
        }
    }

    private static func mobileCapabilities() -> [String] {
        [
            "system.ping",
            "project.list",
            "project.current",
            "project.switch",
            "workspace.list",
            "surface.list",
            "surface.read_text",
            "surface.send_text",
            "surface.send_key",
            "surface.subscribe",
            "surface.unsubscribe"
        ]
    }

    private static func devicePayload(_ record: DeviceRecord) -> [String: Any] {
        [
            "device_id": record.deviceId,
            "device_name": record.deviceName,
            "created_at": record.createdAt,
            "last_seen_at": record.lastSeenAt as Any? ?? NSNull(),
            "revoked_at": record.revokedAt as Any? ?? NSNull(),
            "revoked": record.revokedAt != nil
        ]
    }

    private static func sanitizedTTL(_ raw: Any?) -> TimeInterval {
        let parsed: TimeInterval?
        if let number = raw as? NSNumber {
            parsed = number.doubleValue
        } else if let string = raw as? String {
            parsed = Double(string.trimmingCharacters(in: .whitespacesAndNewlines))
        } else {
            parsed = nil
        }
        guard let parsed, parsed.isFinite, parsed > 0 else {
            return defaultPairingTTL
        }
        return min(max(parsed, minPairingTTL), maxPairingTTL)
    }

    private static func nonEmptyString(_ raw: Any?) -> String? {
        guard let string = raw as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func pruneExpiredPairingsLocked(now: TimeInterval) {
        pairings = pairings.filter { $0.value.expiresAt > now }
    }

    private static func loadDevicesLocked() -> [DeviceRecord] {
        if let cachedDevices {
            return cachedDevices
        }
        guard let url = devicesFileURL(),
              FileManager.default.fileExists(atPath: url.path) else {
            cachedDevices = []
            return []
        }
        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(DeviceFile.self, from: data)
            let devices = prunedDevices(decoded.devices, now: Date().timeIntervalSince1970)
            cachedDevices = devices
            if devices.count != decoded.devices.count {
                _ = saveDevicesLocked(devices)
            }
            return devices
        } catch {
            backupCorruptDevicesFile(url)
            cachedDevices = []
            return []
        }
    }

    @discardableResult
    private static func saveDevicesLocked(_ devices: [DeviceRecord]) -> Bool {
        guard let url = devicesFileURL() else { return false }
        do {
            let directory = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            let payload = DeviceFile(version: 1, devices: devices)
            let data = try JSONEncoder().encode(payload)
            try data.write(to: url, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            cachedDevices = devices
            return true
        } catch {
            return false
        }
    }

    private static func devicesFileURL() -> URL? {
        SocketControlPasswordStore.defaultPasswordFileURL()?.deletingLastPathComponent()
            .appendingPathComponent("mobile-devices.json", isDirectory: false)
    }

    private static func prunedDevices(_ devices: [DeviceRecord], now: TimeInterval) -> [DeviceRecord] {
        let active = devices.filter { $0.revokedAt == nil }
        let revoked = devices.filter { record in
            guard let revokedAt = record.revokedAt else { return false }
            return now - revokedAt <= revokedDeviceRetention
        }
        let remainingSlots = max(0, maxStoredDevices - active.count)
        let retainedRevoked = revoked
            .sorted { lhs, rhs in
                deviceSortDate(lhs) > deviceSortDate(rhs)
            }
            .prefix(remainingSlots)
            .map { $0 }
        return active + retainedRevoked
    }

    private static func deviceSortDate(_ record: DeviceRecord) -> TimeInterval {
        record.lastSeenAt ?? record.revokedAt ?? record.createdAt
    }

    private static func backupCorruptDevicesFile(_ url: URL) {
        let stamp = Int(Date().timeIntervalSince1970)
        let backupURL = url.deletingLastPathComponent()
            .appendingPathComponent("mobile-devices.corrupt-\(stamp).json", isDirectory: false)
        try? FileManager.default.moveItem(at: url, to: backupURL)
    }

    private static func tokenHash(_ token: String) -> String {
        let digest = SHA256.hash(data: Data(token.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
#if canImport(Security)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status == errSecSuccess {
            return base64URL(Data(bytes))
        }
#endif
        return "\(UUID().uuidString).\(UUID().uuidString)"
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

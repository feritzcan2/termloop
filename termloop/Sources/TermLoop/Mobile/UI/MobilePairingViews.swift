// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import CoreImage.CIFilterBuiltins
import Darwin
import SwiftUI

private enum TermLoopMobilePasteboard {
    static func copy(_ string: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(string, forType: .string)
    }
}

/// Opens a mobile pairing sheet. TCP stays off by default; this button
/// enables the mobile bridge on demand and creates a short-lived QR token.
struct MobilePairingButton: View {
    private static let refreshInterval: TimeInterval = 5.0
    @EnvironmentObject private var tabManager: TabManager
    @State private var status: TermLoopTCPBridge.StatusSnapshot =
        TermLoopTCPBridge.shared.currentStatus()
    @State private var showingSheet = false
    private let timer = Timer.publish(
        every: refreshInterval,
        on: .main,
        in: .common
    ).autoconnect()

    private var label: String {
        status.isRunning ? "mobile:\(status.port)" : "Connect Mobile"
    }

    var body: some View {
        Button {
            enableMobileBridge()
            showingSheet = true
        } label: {
            pill
        }
        .buttonStyle(.plain)
        .help(status.isRunning
              ? "Pair a mobile app. Mobile bridge listening on \(status.bindHost):\(status.port)."
              : "Enable the mobile bridge and show a pairing QR code.")
        .sheet(isPresented: $showingSheet) {
            MobilePairingSheet()
        }
        .onReceive(timer) { _ in
            let nextStatus = TermLoopTCPBridge.shared.currentStatus()
            guard nextStatus != status else { return }
            status = nextStatus
        }
    }

    private var pill: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(status.isRunning ? Color.green : Color.blue.opacity(0.85))
                .frame(width: 5, height: 5)
            Text(verbatim: label)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .overlay(
            Rectangle()
                .stroke(TermLoopSidebarTheme.rule, lineWidth: 1)
        )
    }

    private func enableMobileBridge() {
        UserDefaults.standard.set(Int(SocketControlSettings.tcpPortDefault),
                                  forKey: SocketControlSettings.tcpPortDefaultsKey)
        UserDefaults.standard.set(true, forKey: SocketControlSettings.tcpBindAllDefaultsKey)
        UserDefaults.standard.set(SocketControlMode.password.rawValue,
                                  forKey: SocketControlSettings.appStorageKey)
        TerminalController.shared.stop()
        TerminalController.shared.start(
            tabManager: tabManager,
            socketPath: SocketControlSettings.socketPath(),
            accessMode: .password
        )
        TermLoopTCPBridge.shared.reload()
        status = TermLoopTCPBridge.shared.currentStatus()
    }
}

private struct MobilePairingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var pairing: PairingDisplay?
    @State private var devices: [MobileDeviceDisplay] = []
    @State private var errorMessage: String?
    @State private var now = Date()
    @State private var lastDeviceReload = Date.distantPast
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Connect Mobile")
                        .font(.title2.weight(.semibold))
                    Text("Scan this QR from the TermLoop mobile app.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }

            Group {
                if let pairing {
                    HStack(alignment: .top, spacing: 18) {
                        if let image = pairing.qrImage {
                            Image(nsImage: image)
                                .interpolation(.none)
                                .resizable()
                                .frame(width: 220, height: 220)
                                .background(Color.white)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text(pairing.serverName)
                                .font(.headline)
                            Text("\(pairing.host):\(pairing.port)")
                                .font(.system(.body, design: .monospaced))
                            Text(pairingStatusText(pairing))
                                .foregroundStyle(pairing.isExpired(at: now) ? .red : .secondary)
                            HStack(spacing: 8) {
                                Button("Copy payload") {
                                    TermLoopMobilePasteboard.copy(pairing.payloadString)
                                }
                                Button(pairing.isExpired(at: now) ? "Regenerate QR" : "New QR") {
                                    createPairing()
                                }
                            }
                            Text("Keep this window open while pairing. Only the TermLoop mobile app can claim this QR token.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else if let errorMessage {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                        Button("Try again") { createPairing() }
                    }
                } else {
                    ProgressView()
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Paired Devices")
                        .font(.headline)
                    Spacer()
                    Button("Refresh") { loadDevices() }
                }
                if devices.isEmpty {
                    Text("No paired devices yet.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 10)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(devices) { device in
                                deviceRow(device)
                            }
                        }
                    }
                    .frame(maxHeight: 170)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(22)
        .frame(width: 680, height: 540)
        .onAppear {
            createPairing()
            loadDevices()
        }
        .onReceive(timer) { date in
            now = date
            if date.timeIntervalSince(lastDeviceReload) >= 3 {
                loadDevices()
            }
        }
    }

    @ViewBuilder
    private func deviceRow(_ device: MobileDeviceDisplay) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(device.revoked ? Color.red.opacity(0.7) : Color.green)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 3) {
                Text(device.deviceName)
                    .font(.body.weight(.medium))
                Text(deviceSubtitle(device))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if device.revoked {
                Text("Revoked")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Button("Revoke") {
                    revoke(device)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func createPairing() {
        errorMessage = nil
        pairing = nil
        let serverName = Host.current().localizedName ?? "TermLoop Mac"
        let result = TermLoopMobilePairingStore.createPairing(params: [
            "server_name": serverName
        ])
        guard case .ok(let rawPayload) = result,
              let payload = rawPayload as? [String: Any],
              let token = payload["token"] as? String,
              let expiresAt = payload["expires_at"] as? TimeInterval else {
            errorMessage = "Could not create a mobile pairing token."
            return
        }
        let host = Self.localIPv4Address() ?? "127.0.0.1"
        let port = Int(SocketControlSettings.resolvedTcpPort() ?? SocketControlSettings.tcpPortDefault)
        let qrPayload: [String: Any] = [
            "type": "termloop.pairing",
            "version": 1,
            "server_name": serverName,
            "host": host,
            "port": port,
            "token": token,
            "expires_at": expiresAt
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: qrPayload, options: []),
              let payloadString = String(data: data, encoding: .utf8) else {
            errorMessage = "Could not encode the pairing QR payload."
            return
        }
        pairing = PairingDisplay(
            serverName: serverName,
            host: host,
            port: port,
            expiresAt: Date(timeIntervalSince1970: expiresAt),
            payloadString: payloadString,
            qrImage: Self.qrImage(for: payloadString)
        )
    }

    private func loadDevices() {
        lastDeviceReload = Date()
        let result = TermLoopMobilePairingStore.listDevices()
        guard case .ok(let rawPayload) = result,
              let payload = rawPayload as? [String: Any],
              let rawDevices = payload["devices"] as? [[String: Any]] else {
            return
        }
        devices = rawDevices.compactMap(MobileDeviceDisplay.init(payload:))
            .sorted { lhs, rhs in
                if lhs.revoked != rhs.revoked { return !lhs.revoked }
                return lhs.sortDate > rhs.sortDate
            }
    }

    private func revoke(_ device: MobileDeviceDisplay) {
        let result = TermLoopMobilePairingStore.revokeDevice(params: [
            "device_id": device.id
        ])
        guard case .ok = result else {
            NSSound.beep()
            return
        }
        loadDevices()
    }

    private func pairingStatusText(_ pairing: PairingDisplay) -> String {
        let remaining = max(0, Int(pairing.expiresAt.timeIntervalSince(now).rounded(.down)))
        guard remaining > 0 else { return "Expired. Generate a new QR to pair another device." }
        return "Expires in \(remaining / 60):\(String(format: "%02d", remaining % 60))"
    }

    private func deviceSubtitle(_ device: MobileDeviceDisplay) -> String {
        let created = Self.shortDate(device.createdAt)
        let seen = device.lastSeenAt.map { Self.relativeDate($0) } ?? "never seen"
        return "Created \(created) - last seen \(seen)"
    }

    private static func shortDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private static func relativeDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private static func qrImage(for string: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    private static func localIPv4Address() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0 else { return nil }
        defer { freeifaddrs(ifaddr) }

        var pointer = ifaddr
        while pointer != nil {
            defer { pointer = pointer?.pointee.ifa_next }
            guard let interface = pointer?.pointee,
                  interface.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: interface.ifa_name)
            guard name == "en0" || name == "en1" || name.hasPrefix("utun") else { continue }
            var addr = interface.ifa_addr.pointee
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                &addr,
                socklen_t(interface.ifa_addr.pointee.sa_len),
                &hostname,
                socklen_t(hostname.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            guard result == 0 else { continue }
            let ip = String(cString: hostname)
            if ip != "127.0.0.1" {
                return ip
            }
        }
        return nil
    }

    private struct PairingDisplay {
        let serverName: String
        let host: String
        let port: Int
        let expiresAt: Date
        let payloadString: String
        let qrImage: NSImage?

        func isExpired(at date: Date) -> Bool {
            expiresAt <= date
        }
    }

    private struct MobileDeviceDisplay: Identifiable {
        let id: String
        let deviceName: String
        let createdAt: Date
        let lastSeenAt: Date?
        let revokedAt: Date?
        let revoked: Bool

        var sortDate: Date {
            lastSeenAt ?? createdAt
        }

        init?(payload: [String: Any]) {
            guard let id = payload["device_id"] as? String,
                  let deviceName = payload["device_name"] as? String,
                  let created = Self.time(payload["created_at"]) else {
                return nil
            }
            self.id = id
            self.deviceName = deviceName
            self.createdAt = Date(timeIntervalSince1970: created)
            if let lastSeen = Self.time(payload["last_seen_at"]) {
                self.lastSeenAt = Date(timeIntervalSince1970: lastSeen)
            } else {
                self.lastSeenAt = nil
            }
            if let revokedAt = Self.time(payload["revoked_at"]) {
                self.revokedAt = Date(timeIntervalSince1970: revokedAt)
            } else {
                self.revokedAt = nil
            }
            self.revoked = (payload["revoked"] as? Bool) ?? (self.revokedAt != nil)
        }

        private static func time(_ raw: Any?) -> TimeInterval? {
            if let value = raw as? TimeInterval {
                return value
            }
            if let number = raw as? NSNumber {
                return number.doubleValue
            }
            return nil
        }
    }
}

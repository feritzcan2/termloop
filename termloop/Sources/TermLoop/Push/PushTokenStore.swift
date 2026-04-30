// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
final class PushTokenStore {
    static let shared = PushTokenStore()

    struct Record: Codable, Equatable {
        let deviceToken: String
        let platform: String
        let environment: String
        let lastSeen: TimeInterval

        enum CodingKeys: String, CodingKey {
            case deviceToken = "device_token"
            case platform
            case environment
            case lastSeen = "last_seen"
        }
    }

    private var current: Record?

    init() {
        self.current = Self.read()
    }

    private static func fileURL() -> URL {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("termloop")
        try? fm.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("push-tokens.json")
    }

    private static func read() -> Record? {
        guard let data = try? Data(contentsOf: fileURL()) else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }

    private func persist() {
        guard let record = current else {
            try? FileManager.default.removeItem(at: Self.fileURL())
            return
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(record) {
            try? data.write(to: Self.fileURL(), options: .atomic)
        }
    }

    func register(deviceToken: String, platform: String, environment: String) {
        current = Record(
            deviceToken: deviceToken,
            platform: platform,
            environment: environment,
            lastSeen: Date().timeIntervalSince1970
        )
        persist()
    }

    func unregister(deviceToken: String) {
        if current?.deviceToken == deviceToken {
            current = nil
            persist()
        }
    }

    func currentRecord() -> Record? {
        current
    }
}

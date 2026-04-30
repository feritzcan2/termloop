// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct APNsConfig: Codable {
    let teamId: String
    let keyId: String
    let keyFile: String
    let bundleId: String

    enum CodingKeys: String, CodingKey {
        case teamId = "team_id"
        case keyId = "key_id"
        case keyFile = "key_file"
        case bundleId = "bundle_id"
    }

    static func apnsDirectory() -> URL {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("termloop")
            .appendingPathComponent("apns")
        try? fm.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    static func configURL() -> URL {
        apnsDirectory().appendingPathComponent("config.json")
    }

    static func load() -> APNsConfig? {
        let url = configURL()
        guard let data = try? Data(contentsOf: url) else { return nil }
        do {
            return try JSONDecoder().decode(APNsConfig.self, from: data)
        } catch {
            NSLog("APNsConfig: decode failed: \(error)")
            return nil
        }
    }

    func keyURL() -> URL {
        Self.apnsDirectory().appendingPathComponent(keyFile)
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct WebhookDiscovery: IntegrationDiscovery {
    let kind: IntegrationKind = .webhook

    struct StoredWebhook: Codable {
        let name: String
        let url: String
        var method: String?
        var summary: String?
        var headerSecretRefs: [String: String]?
    }

    func discover(projectRoot: URL?) async -> [IntegrationItem] {
        let file = IntegrationsPaths.webhooksFile()
        guard let data = try? Data(contentsOf: file) else { return [] }
        guard let stored = try? JSONDecoder().decode([StoredWebhook].self, from: data) else { return [] }
        return stored.map { wh in
            IntegrationItem(
                id: IntegrationItem.makeId(kind: .webhook, name: wh.name),
                kind: .webhook,
                displayName: wh.name,
                summary: wh.summary ?? wh.url,
                source: .termLoop,
                status: .idle,
                lastTestedAt: nil,
                lastTestDurationMs: nil,
                capabilities: [],
                configRef: nil,
                attachedToActiveSpawn: false,
                binaryPath: nil,
                version: nil,
                authSubject: nil
            )
        }
    }
}

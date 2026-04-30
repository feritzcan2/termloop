// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct WebhookTestRunner: TestRunner {
    func run(_ item: IntegrationItem) async -> IntegrationTestResult {
        guard let url = URL(string: item.summary) else {
            return .failure("invalid url")
        }
        let start = Date()
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 5
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            guard let http = response as? HTTPURLResponse else {
                return .failure("no http response", durationMs: ms)
            }
            let ok = (200...399).contains(http.statusCode)
            return IntegrationTestResult(success: ok,
                                         message: "HTTP \(http.statusCode)",
                                         durationMs: ms,
                                         capabilities: [],
                                         logPath: nil)
        } catch {
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            return .failure(error.localizedDescription, durationMs: ms)
        }
    }
}

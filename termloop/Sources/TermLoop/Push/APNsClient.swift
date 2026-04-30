// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct APNsPayload: Codable {
    struct APS: Codable {
        let alert: Alert
        let category: String
        let sound: String?
        let mutableContent: Int?
        let contentAvailable: Int?

        struct Alert: Codable {
            let title: String
            let body: String
        }

        enum CodingKeys: String, CodingKey {
            case alert, category, sound
            case mutableContent = "mutable-content"
            case contentAvailable = "content-available"
        }
    }

    let aps: APS
    let workspaceId: String
    let attentionKind: String?

    enum CodingKeys: String, CodingKey {
        case aps
        case workspaceId = "workspace_id"
        case attentionKind = "attention_kind"
    }
}

enum APNsResult {
    case success
    case badDeviceToken
    case otherError(status: Int, body: String)
    case transportError(Error)
}

actor APNsClient {
    private let config: APNsConfig
    private let signer: APNsJWTSigner
    private let session: URLSession

    init(config: APNsConfig) throws {
        self.config = config
        self.signer = try APNsJWTSigner(config: config)
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 15
        c.httpMaximumConnectionsPerHost = 2
        self.session = URLSession(configuration: c)
    }

    func send(
        payload: APNsPayload,
        deviceToken: String,
        environment: String
    ) async -> APNsResult {
        let host = environment == "production"
            ? "api.push.apple.com"
            : "api.sandbox.push.apple.com"
        guard let url = URL(string: "https://\(host)/3/device/\(deviceToken)") else {
            return .otherError(status: -1, body: "bad url")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        do {
            let jwt = try await signer.token()
            req.setValue("bearer \(jwt)", forHTTPHeaderField: "authorization")
        } catch {
            return .transportError(error)
        }
        req.setValue(config.bundleId, forHTTPHeaderField: "apns-topic")
        req.setValue("alert", forHTTPHeaderField: "apns-push-type")
        req.setValue("10", forHTTPHeaderField: "apns-priority")
        req.setValue(UUID().uuidString, forHTTPHeaderField: "apns-id")

        do {
            req.httpBody = try JSONEncoder().encode(payload)
        } catch {
            return .transportError(error)
        }

        do {
            let (data, resp) = try await session.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if status == 200 { return .success }
            let body = String(data: data, encoding: .utf8) ?? ""
            if body.contains("BadDeviceToken") || body.contains("Unregistered") {
                return .badDeviceToken
            }
            return .otherError(status: status, body: body)
        } catch {
            return .transportError(error)
        }
    }

    func sendWithFallback(
        payload: APNsPayload,
        deviceToken: String,
        primaryEnvironment: String
    ) async -> APNsResult {
        let primary = await send(payload: payload, deviceToken: deviceToken, environment: primaryEnvironment)
        switch primary {
        case .badDeviceToken:
            let other = primaryEnvironment == "production" ? "development" : "production"
            return await send(payload: payload, deviceToken: deviceToken, environment: other)
        default:
            return primary
        }
    }
}

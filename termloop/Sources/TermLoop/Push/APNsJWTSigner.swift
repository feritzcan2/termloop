// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import CryptoKit

actor APNsJWTSigner {
    private let config: APNsConfig
    private let privateKey: P256.Signing.PrivateKey

    private var cachedToken: String?
    private var cachedAt: Date?

    init(config: APNsConfig) throws {
        self.config = config
        let pem = try String(contentsOf: config.keyURL(), encoding: .utf8)
        self.privateKey = try P256.Signing.PrivateKey(pemRepresentation: pem)
    }

    func token() throws -> String {
        if let cached = cachedToken, let at = cachedAt, Date().timeIntervalSince(at) < 50 * 60 {
            return cached
        }
        let header: [String: String] = ["alg": "ES256", "kid": config.keyId, "typ": "JWT"]
        let claims: [String: Any] = [
            "iss": config.teamId,
            "iat": Int(Date().timeIntervalSince1970),
        ]
        let headerB64 = Self.b64url(try JSONSerialization.data(withJSONObject: header))
        let claimsB64 = Self.b64url(try JSONSerialization.data(withJSONObject: claims))
        let signingInput = "\(headerB64).\(claimsB64)"
        let signature = try privateKey.signature(for: Data(signingInput.utf8))
        let sigB64 = Self.b64url(signature.rawRepresentation)
        let jwt = "\(signingInput).\(sigB64)"
        cachedToken = jwt
        cachedAt = Date()
        return jwt
    }

    private static func b64url(_ data: Data) -> String {
        var s = data.base64EncodedString()
        s = s.replacingOccurrences(of: "+", with: "-")
             .replacingOccurrences(of: "/", with: "_")
             .replacingOccurrences(of: "=", with: "")
        return s
    }

}

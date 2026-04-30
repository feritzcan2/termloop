// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import Security

/// Splits integration config into two stores: secrets go to the macOS
/// Keychain, non-secret values live in
/// `~/Library/Application Support/TermLoop/integrations/config.json`.
/// Preset `persist()` implementations call into this helper.
final class IntegrationConfigStore {
    static let shared = IntegrationConfigStore()
    private let service = "com.termloop.integrations"
    private let queue = DispatchQueue(label: "termloop.integrations.config")

    private init() {}

    // MARK: - Non-secret values (config.json)

    func loadNonSecrets() -> [String: [String: String]] {
        let url = IntegrationsPaths.configFile()
        guard let data = try? Data(contentsOf: url) else { return [:] }
        return (try? JSONDecoder().decode([String: [String: String]].self, from: data)) ?? [:]
    }

    func setNonSecret(presetId: String, key: String, value: String?) throws {
        queue.sync {
            var all = loadNonSecrets()
            var fields = all[presetId] ?? [:]
            if let value { fields[key] = value } else { fields.removeValue(forKey: key) }
            if fields.isEmpty { all.removeValue(forKey: presetId) } else { all[presetId] = fields }
            try? writeAtomically(all: all)
        }
    }

    private func writeAtomically(all: [String: [String: String]]) throws {
        IntegrationsPaths.ensureSupportDir()
        let url = IntegrationsPaths.configFile()
        let data = try JSONEncoder().encode(all)
        let tmp = url.appendingPathExtension("tmp")
        try data.write(to: tmp, options: .atomic)
        _ = try? FileManager.default.replaceItemAt(url, withItemAt: tmp)
    }

    // MARK: - Secrets (Keychain)

    func setSecret(presetId: String, key: String, value: String?) throws {
        let account = "\(presetId):\(key)"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        guard let value, !value.isEmpty else { return }
        guard let data = value.data(using: .utf8) else { return }
        var insert = query
        insert[kSecValueData as String] = data
        let status = SecItemAdd(insert as CFDictionary, nil)
        if status != errSecSuccess {
            throw KeychainError.osStatus(status)
        }
    }

    func loadSecret(presetId: String, key: String) -> String? {
        let account = "\(presetId):\(key)"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - Placeholder expansion

    /// Replace `${keychain:<presetId>:<key>}` placeholders with actual
    /// secret values. Used by `IntegrationsSpawnPrep` right before spawn.
    func expandPlaceholders(in string: String) -> String {
        let pattern = #"\$\{keychain:([^:}]+):([^}]+)\}"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return string }
        let ns = string as NSString
        var out = string
        let matches = regex.matches(in: string, range: NSRange(location: 0, length: ns.length))
        for match in matches.reversed() {
            let preset = ns.substring(with: match.range(at: 1))
            let key = ns.substring(with: match.range(at: 2))
            let secret = loadSecret(presetId: preset, key: key) ?? ""
            out = (out as NSString).replacingCharacters(in: match.range, with: secret)
        }
        return out
    }
}

enum KeychainError: Error, LocalizedError {
    case osStatus(OSStatus)
    var errorDescription: String? {
        switch self {
        case .osStatus(let s):
            return String(localized: "integrations.config.keychainFail",
                          defaultValue: "Keychain access denied (\(s)).",
                          table: "TermLoop")
        }
    }
}

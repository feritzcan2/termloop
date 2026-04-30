// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import Security
import SwiftUI

/// Non-secret descriptor of a Claude credential profile. The actual
/// `CLAUDE_CODE_OAUTH_TOKEN` value lives in the macOS Keychain and is
/// looked up by `id` at agent launch time.
struct ClaudeCredentialProfile: Identifiable, Codable, Hashable, Sendable {
    /// Stable identifier. Used as the Keychain account and persisted by
    /// `Project.claudeCredentialProfileId`. Lowercase ascii, e.g. `work`.
    let id: String
    /// Display label shown in Settings and project pickers.
    var displayName: String
    let createdAt: Date

    init(id: String, displayName: String, createdAt: Date = Date()) {
        self.id = id
        self.displayName = displayName
        self.createdAt = createdAt
    }
}

enum ClaudeCredentialError: Error, LocalizedError {
    case invalidId
    case duplicateId(String)
    case notFound(String)
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidId:
            return String(
                localized: "claude.credential.error.invalidId",
                defaultValue: "Profile id must be non-empty and contain only letters, digits, dashes, or underscores.",
                table: "TermLoop"
            )
        case .duplicateId(let id):
            return String(
                localized: "claude.credential.error.duplicate",
                defaultValue: "A Claude account profile named \"\(id)\" already exists.",
                table: "TermLoop"
            )
        case .notFound(let id):
            return String(
                localized: "claude.credential.error.notFound",
                defaultValue: "Claude account profile \"\(id)\" was not found.",
                table: "TermLoop"
            )
        case .keychain(let status):
            return String(
                localized: "claude.credential.error.keychain",
                defaultValue: "Keychain access failed (\(status)).",
                table: "TermLoop"
            )
        }
    }
}

/// Manages a small catalog of named Claude credential profiles. Tokens
/// (long-lived OAuth tokens from `claude setup-token`) are stored in the
/// Keychain; the non-secret index of profile ids and display names lives
/// at `~/Library/Application Support/TermLoop/claude-credentials/profiles.json`.
///
/// At agent launch, callers resolve a project's `claudeCredentialProfileId`
/// to a token via `token(forProfileId:)` and inject it as
/// `CLAUDE_CODE_OAUTH_TOKEN` in the spawn environment.
@MainActor
final class ClaudeCredentialStore: ObservableObject {
    static let shared = ClaudeCredentialStore()

    @Published private(set) var profiles: [ClaudeCredentialProfile] = []
    /// Profile ids with a Keychain-stored token. Cached so SwiftUI rows can
    /// render a "token saved" / "no token" indicator without an XPC
    /// round-trip per row per redraw.
    @Published private(set) var profileIdsWithTokens: Set<String> = []

    private let service = "com.termloop.claude.credentials"
    private let queue = DispatchQueue(label: "termloop.claude.credentials")

    private init() {
        profiles = loadFromDisk()
        profileIdsWithTokens = Set(profiles.map(\.id).filter { loadSecret(account: $0) != nil })
    }

    // MARK: - Lookup

    func profile(id: String) -> ClaudeCredentialProfile? {
        profiles.first { $0.id == id }
    }

    /// Whether a token has been stored for the given profile id. Used by UI
    /// to surface "missing token" warnings without exposing the secret.
    func hasToken(forProfileId id: String) -> Bool {
        profileIdsWithTokens.contains(id)
    }

    /// Reads the token for a profile from the Keychain. Returns `nil` when
    /// no token has been set (or the profile is unknown — `loadSecret`
    /// returns nil for missing accounts).
    func token(forProfileId id: String) -> String? {
        loadSecret(account: id)
    }

    // MARK: - Mutations

    @discardableResult
    func addProfile(id: String, displayName: String, token: String) throws -> ClaudeCredentialProfile {
        let normalizedId = try validateId(id)
        let trimmedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = trimmedName.isEmpty ? normalizedId : trimmedName
        if profiles.contains(where: { $0.id == normalizedId }) {
            throw ClaudeCredentialError.duplicateId(normalizedId)
        }
        try setSecret(account: normalizedId, value: token)
        let profile = ClaudeCredentialProfile(id: normalizedId, displayName: resolvedName)
        profiles.append(profile)
        if !token.isEmpty { profileIdsWithTokens.insert(normalizedId) }
        persist()
        return profile
    }

    func rename(id: String, newDisplayName: String) throws {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else {
            throw ClaudeCredentialError.notFound(id)
        }
        let trimmed = newDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = trimmed.isEmpty ? id : trimmed
        guard profiles[index].displayName != resolvedName else { return }
        profiles[index].displayName = resolvedName
        persist()
    }

    func updateToken(id: String, token: String) throws {
        guard profile(id: id) != nil else { throw ClaudeCredentialError.notFound(id) }
        try setSecret(account: id, value: token)
        if token.isEmpty {
            profileIdsWithTokens.remove(id)
        } else {
            profileIdsWithTokens.insert(id)
        }
    }

    func delete(id: String) throws {
        guard profiles.contains(where: { $0.id == id }) else {
            throw ClaudeCredentialError.notFound(id)
        }
        try? setSecret(account: id, value: nil)
        profiles.removeAll { $0.id == id }
        profileIdsWithTokens.remove(id)
        persist()
    }

    // MARK: - Disk persistence (non-secret)

    private func loadFromDisk() -> [ClaudeCredentialProfile] {
        let url = ClaudeCredentialPaths.profilesFile()
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([ClaudeCredentialProfile].self, from: data)) ?? []
    }

    private func persist() {
        let snapshot = profiles
        queue.async {
            ClaudeCredentialPaths.ensureSupportDir()
            let url = ClaudeCredentialPaths.profilesFile()
            guard let data = try? JSONEncoder().encode(snapshot) else { return }
            let tmp = url.appendingPathExtension("tmp")
            do {
                try data.write(to: tmp, options: .atomic)
                _ = try? FileManager.default.replaceItemAt(url, withItemAt: tmp)
            } catch {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    // MARK: - Keychain

    private func setSecret(account: String, value: String?) throws {
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
            throw ClaudeCredentialError.keychain(status)
        }
    }

    private func loadSecret(account: String) -> String? {
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

    // MARK: - Validation

    private func validateId(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { throw ClaudeCredentialError.invalidId }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-_")
        guard trimmed.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw ClaudeCredentialError.invalidId
        }
        return trimmed
    }
}

enum ClaudeCredentialPaths {
    static func supportDir() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        return base.appendingPathComponent("TermLoop/claude-credentials", isDirectory: true)
    }

    static func profilesFile() -> URL {
        supportDir().appendingPathComponent("profiles.json", isDirectory: false)
    }

    static func ensureSupportDir() {
        try? FileManager.default.createDirectory(at: supportDir(),
                                                 withIntermediateDirectories: true)
    }
}

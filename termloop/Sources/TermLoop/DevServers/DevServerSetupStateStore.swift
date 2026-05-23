// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import CryptoKit
import Foundation
import SwiftUI

public struct DevServerSetupStateFile: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var records: [DevServerSetupRecord]
    public var updatedAt: Date

    public init(
        schemaVersion: Int = Self.currentSchemaVersion,
        records: [DevServerSetupRecord] = [],
        updatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.records = records
        self.updatedAt = updatedAt
    }
}

public struct DevServerSetupRecord: Codable, Equatable, Sendable {
    public var worktreePath: String
    public var profileId: String
    public var configHash: String
    public var completedAt: Date
}

@MainActor
public final class DevServerSetupStateStore: ObservableObject {
    public let projectRoot: URL

    @Published public private(set) var file = DevServerSetupStateFile()

    public init(projectRoot: URL) {
        self.projectRoot = projectRoot
        load()
    }

    public func needsSetup(profile: DevServerProfile, worktreePath: String) -> Bool {
        guard profile.setupCommand != nil else { return false }
        switch profile.setupPolicy {
        case .never:
            return false
        case .always:
            return true
        case .oncePerWorktreeProfileConfig:
            let hash = Self.configHash(for: profile)
            return !file.records.contains {
                $0.worktreePath == worktreePath
                    && $0.profileId == profile.id
                    && $0.configHash == hash
            }
        }
    }

    public func markComplete(profile: DevServerProfile, worktreePath: String) throws {
        let record = DevServerSetupRecord(
            worktreePath: worktreePath,
            profileId: profile.id,
            configHash: Self.configHash(for: profile),
            completedAt: Date()
        )
        file.records.removeAll {
            $0.worktreePath == worktreePath && $0.profileId == profile.id
        }
        file.records.append(record)
        try save()
    }

    public func clear(worktreePath: String, profileId: String? = nil) throws {
        let before = file.records
        file.records.removeAll { record in
            record.worktreePath == worktreePath && (profileId == nil || record.profileId == profileId)
        }
        guard file.records != before else { return }
        try save()
    }

    public static func configHash(for profile: DevServerProfile) -> String {
        let fingerprint = DevServerSetupFingerprint(
            profileId: profile.id,
            workingDirectory: profile.workingDirectory,
            env: profile.env,
            setupCommand: profile.setupCommand,
            setupPolicy: profile.setupPolicy
        )
        let data = (try? JSONEncoder.devServers.encode(fingerprint)) ?? Data(String(describing: fingerprint).utf8)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func load() {
        let url = stateFileURL()
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder.devServers.decode(DevServerSetupStateFile.self, from: data),
              decoded.schemaVersion <= DevServerSetupStateFile.currentSchemaVersion else {
            file = DevServerSetupStateFile()
            return
        }
        file = decoded
    }

    private func save() throws {
        file.updatedAt = Date()
        let dir = stateFileURL().deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONEncoder.devServers.encode(file)
        try data.write(to: stateFileURL(), options: .atomic)
    }

    private func stateFileURL() -> URL {
        projectRoot.appendingPathComponent(".termloop/devserver-setup-state.json")
    }
}

private struct DevServerSetupFingerprint: Codable, CustomStringConvertible {
    let profileId: String
    let workingDirectory: String
    let env: [String: String]
    let setupCommand: String?
    let setupPolicy: DevServerSetupPolicy

    var description: String {
        "\(profileId)|\(workingDirectory)|\(env.sorted { $0.key < $1.key })|\(setupCommand ?? "")|\(setupPolicy.rawValue)"
    }
}

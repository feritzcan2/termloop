// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import CryptoKit
import Foundation
import SwiftUI

private struct WorktreeSetupSchemaHeader: Codable {
    let schemaVersion: Int
}

@MainActor
public final class WorktreeSetupStore: ObservableObject {
    public let projectRoot: URL
    public let projectId: UUID

    @Published public private(set) var file = WorktreeSetupFile()
    @Published public private(set) var configExists = false
    @Published public private(set) var loadError: WorktreeSetupError?

    public init(projectRoot: URL, projectId: UUID) {
        self.projectRoot = projectRoot
        self.projectId = projectId
    }

    public func load() {
        let url = configFileURL()
        guard FileManager.default.fileExists(atPath: url.path) else {
            file = WorktreeSetupFile()
            configExists = false
            loadError = nil
            return
        }

        do {
            let data = try Data(contentsOf: url)
            let schemaVersion: Int
            do {
                schemaVersion = try JSONDecoder.devServers.decode(WorktreeSetupSchemaHeader.self, from: data).schemaVersion
            } catch {
                throw WorktreeSetupError.decodingFailed(String(describing: error))
            }
            guard schemaVersion <= WorktreeSetupFile.currentSchemaVersion else {
                throw WorktreeSetupError.unsupportedSchema(
                    found: schemaVersion,
                    supported: WorktreeSetupFile.currentSchemaVersion
                )
            }
            file = try JSONDecoder.devServers.decode(WorktreeSetupFile.self, from: data)
            configExists = true
            loadError = nil
        } catch let error as WorktreeSetupError {
            file = WorktreeSetupFile()
            configExists = true
            loadError = error
        } catch {
            file = WorktreeSetupFile()
            configExists = true
            loadError = .decodingFailed(String(describing: error))
        }
    }

    public func saveNow() throws {
        file.updatedAt = Date()
        try write(file, to: configFileURL())
        configExists = true
        loadError = nil
        objectWillChange.send()
    }

    public func ensureConfigFile() throws -> URL {
        if !configExists {
            file = WorktreeSetupFile()
            try saveNow()
        }
        return configFileURL()
    }

    public func configFileURL() -> URL {
        projectRoot.appendingPathComponent(".termloop/worktree-setup.json")
    }

    public static func configHash(for file: WorktreeSetupFile) -> String {
        let fingerprint = WorktreeSetupFingerprint(
            schemaVersion: file.schemaVersion,
            policy: file.policy,
            steps: file.steps,
            cleanupSteps: file.cleanupSteps
        )
        let data = (try? JSONEncoder.devServers.encode(fingerprint)) ?? Data(String(describing: fingerprint).utf8)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func write(_ file: WorktreeSetupFile, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data: Data
        do {
            data = try JSONEncoder.devServers.encode(file)
        } catch {
            throw WorktreeSetupError.writeFailed("encode: \(error)")
        }
        let tmp = url.appendingPathExtension("tmp-\(UUID().uuidString)")
        do {
            try data.write(to: tmp, options: .atomic)
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: url)
            }
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw WorktreeSetupError.writeFailed(String(describing: error))
        }
    }
}

@MainActor
public final class WorktreeSetupStoreProvider: ObservableObject {
    public static let shared = WorktreeSetupStoreProvider {
        guard let project = ProjectStore.shared.project(id: $0) else { return nil }
        return URL(fileURLWithPath: project.folderPath)
    }

    private var stores: [UUID: WorktreeSetupStore] = [:]
    private var projectRoots: [UUID: URL] = [:]
    private let resolveRoot: (UUID) -> URL?

    private init(resolveRoot: @escaping (UUID) -> URL?) {
        self.resolveRoot = resolveRoot
    }

    public func registerProjectRoot(_ root: URL, for projectId: UUID) {
        projectRoots[projectId] = root
        objectWillChange.send()
    }

    public func remove(projectId: UUID) {
        stores.removeValue(forKey: projectId)
        projectRoots.removeValue(forKey: projectId)
        objectWillChange.send()
    }

    public func removeAll() {
        stores.removeAll()
        projectRoots.removeAll()
        objectWillChange.send()
    }

    public func store(for projectId: UUID) -> WorktreeSetupStore? {
        if let existing = stores[projectId] { return existing }
        let root: URL
        if let registered = projectRoots[projectId] {
            root = registered
        } else if let resolved = resolveRoot(projectId) {
            projectRoots[projectId] = resolved
            root = resolved
        } else {
            return nil
        }
        let store = WorktreeSetupStore(projectRoot: root, projectId: projectId)
        store.load()
        stores[projectId] = store
        return store
    }
}

public struct WorktreeSetupStateFile: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var records: [WorktreeSetupRecord]
    public var skips: [WorktreeSetupSkipRecord]
    public var updatedAt: Date

    public init(
        schemaVersion: Int = Self.currentSchemaVersion,
        records: [WorktreeSetupRecord] = [],
        skips: [WorktreeSetupSkipRecord] = [],
        updatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.records = records
        self.skips = skips
        self.updatedAt = updatedAt
    }
}

public struct WorktreeSetupRecord: Codable, Equatable, Sendable {
    public var worktreePath: String
    public var configHash: String
    public var completedAt: Date
}

public struct WorktreeSetupSkipRecord: Codable, Equatable, Sendable {
    public var worktreePath: String
    public var configHash: String
    public var skippedAt: Date
}

@MainActor
public final class WorktreeSetupStateStore: ObservableObject {
    public let projectRoot: URL

    @Published public private(set) var file = WorktreeSetupStateFile()

    public init(projectRoot: URL) {
        self.projectRoot = projectRoot
        load()
    }

    public func setupState(for setupFile: WorktreeSetupFile, worktreePath: String) -> WorktreeSetupPhase {
        guard setupFile.hasRunnableSetup else { return .ready }
        let hash = WorktreeSetupStore.configHash(for: setupFile)
        if file.skips.contains(where: { $0.worktreePath == worktreePath && $0.configHash == hash }) {
            return .skipped
        }
        switch setupFile.policy {
        case .never:
            return .ready
        case .always:
            return .needed
        case .oncePerWorktreeConfig:
            if file.records.contains(where: { $0.worktreePath == worktreePath && $0.configHash == hash }) {
                return .ready
            }
            return .needed
        }
    }

    public func needsSetup(_ setupFile: WorktreeSetupFile, worktreePath: String) -> Bool {
        setupState(for: setupFile, worktreePath: worktreePath) == .needed
    }

    public func markComplete(setupFile: WorktreeSetupFile, worktreePath: String) throws {
        let hash = WorktreeSetupStore.configHash(for: setupFile)
        file.records.removeAll { $0.worktreePath == worktreePath }
        file.skips.removeAll { $0.worktreePath == worktreePath }
        file.records.append(WorktreeSetupRecord(worktreePath: worktreePath, configHash: hash, completedAt: Date()))
        try save()
    }

    public func markSkipped(setupFile: WorktreeSetupFile, worktreePath: String) throws {
        let hash = WorktreeSetupStore.configHash(for: setupFile)
        file.records.removeAll { $0.worktreePath == worktreePath }
        file.skips.removeAll { $0.worktreePath == worktreePath }
        file.skips.append(WorktreeSetupSkipRecord(worktreePath: worktreePath, configHash: hash, skippedAt: Date()))
        try save()
    }

    public func clear(worktreePath: String) throws {
        let beforeRecords = file.records
        let beforeSkips = file.skips
        file.records.removeAll { $0.worktreePath == worktreePath }
        file.skips.removeAll { $0.worktreePath == worktreePath }
        guard beforeRecords != file.records || beforeSkips != file.skips else { return }
        try save()
    }

    private func load() {
        let url = stateFileURL()
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder.devServers.decode(WorktreeSetupStateFile.self, from: data),
              decoded.schemaVersion <= WorktreeSetupStateFile.currentSchemaVersion else {
            file = WorktreeSetupStateFile()
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
        projectRoot.appendingPathComponent(".termloop/worktree-setup-state.json")
    }
}

private struct WorktreeSetupFingerprint: Codable, CustomStringConvertible {
    let schemaVersion: Int
    let policy: WorktreeSetupPolicy
    let steps: [WorktreeSetupStep]
    let cleanupSteps: [WorktreeSetupStep]

    var description: String {
        "\(schemaVersion)|\(policy.rawValue)|\(steps)|\(cleanupSteps)"
    }
}

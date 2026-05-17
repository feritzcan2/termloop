// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public enum WorktreeSetupPolicy: String, Codable, CaseIterable, Identifiable, Equatable, Hashable, Sendable {
    case oncePerWorktreeConfig = "once_per_worktree_config"
    case always
    case never

    public var id: String { rawValue }

    public var localizedLabel: String {
        switch self {
        case .oncePerWorktreeConfig:
            return String(localized: "worktreeSetup.policy.once", defaultValue: "Once per config", table: "TermLoop")
        case .always:
            return String(localized: "worktreeSetup.policy.always", defaultValue: "Always", table: "TermLoop")
        case .never:
            return String(localized: "worktreeSetup.policy.never", defaultValue: "Never", table: "TermLoop")
        }
    }
}

public enum WorktreeSetupStepType: String, Codable, Equatable, Hashable, Sendable {
    case copy
    case mkdir
    case template
    case command
}

public enum WorktreeSetupSourceScope: String, Codable, Equatable, Hashable, Sendable {
    case projectRoot = "project_root"
    case worktreeRoot = "worktree_root"
}

public struct WorktreeSetupPathRef: Codable, Equatable, Sendable {
    public var scope: WorktreeSetupSourceScope
    public var path: String

    public init(scope: WorktreeSetupSourceScope = .projectRoot, path: String) {
        self.scope = scope
        self.path = path
    }
}

public struct WorktreeSetupStep: Codable, Equatable, Sendable {
    public var id: String?
    public var type: WorktreeSetupStepType
    public var from: WorktreeSetupPathRef?
    public var to: String?
    public var command: String?
    public var workingDirectory: String?
    public var timeoutSeconds: Int?
    public var overwrite: Bool
    public var ifMissingOnly: Bool
    public var required: Bool
    public var content: String?
    public var env: [String: String]

    public init(
        id: String? = nil,
        type: WorktreeSetupStepType,
        from: WorktreeSetupPathRef? = nil,
        to: String? = nil,
        command: String? = nil,
        workingDirectory: String? = nil,
        timeoutSeconds: Int? = nil,
        overwrite: Bool = false,
        ifMissingOnly: Bool = true,
        required: Bool = true,
        content: String? = nil,
        env: [String: String] = [:]
    ) {
        self.id = id?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        self.type = type
        self.from = from
        self.to = to?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        self.command = command?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        self.workingDirectory = workingDirectory?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        self.timeoutSeconds = timeoutSeconds
        self.overwrite = overwrite
        self.ifMissingOnly = ifMissingOnly
        self.required = required
        self.content = content
        self.env = env.compactMapValues { $0.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank }
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case type
        case from
        case to
        case command
        case workingDirectory
        case timeoutSeconds
        case overwrite
        case ifMissingOnly
        case required
        case content
        case env
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decodeIfPresent(String.self, forKey: .id),
            type: try container.decode(WorktreeSetupStepType.self, forKey: .type),
            from: try container.decodeIfPresent(WorktreeSetupPathRef.self, forKey: .from),
            to: try container.decodeIfPresent(String.self, forKey: .to),
            command: try container.decodeIfPresent(String.self, forKey: .command),
            workingDirectory: try container.decodeIfPresent(String.self, forKey: .workingDirectory),
            timeoutSeconds: try container.decodeIfPresent(Int.self, forKey: .timeoutSeconds),
            overwrite: try container.decodeIfPresent(Bool.self, forKey: .overwrite) ?? false,
            ifMissingOnly: try container.decodeIfPresent(Bool.self, forKey: .ifMissingOnly) ?? true,
            required: try container.decodeIfPresent(Bool.self, forKey: .required) ?? true,
            content: try container.decodeIfPresent(String.self, forKey: .content),
            env: try container.decodeIfPresent([String: String].self, forKey: .env) ?? [:]
        )
    }
}

public struct WorktreeSetupFile: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var policy: WorktreeSetupPolicy
    public var steps: [WorktreeSetupStep]
    public var cleanupSteps: [WorktreeSetupStep]
    public var updatedAt: Date

    public init(
        schemaVersion: Int = Self.currentSchemaVersion,
        policy: WorktreeSetupPolicy = .oncePerWorktreeConfig,
        steps: [WorktreeSetupStep] = [],
        cleanupSteps: [WorktreeSetupStep] = [],
        updatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.policy = policy
        self.steps = steps
        self.cleanupSteps = cleanupSteps
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case policy
        case steps
        case cleanupSteps
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            schemaVersion: try container.decode(Int.self, forKey: .schemaVersion),
            policy: try container.decodeIfPresent(WorktreeSetupPolicy.self, forKey: .policy) ?? .oncePerWorktreeConfig,
            steps: try container.decodeIfPresent([WorktreeSetupStep].self, forKey: .steps) ?? [],
            cleanupSteps: try container.decodeIfPresent([WorktreeSetupStep].self, forKey: .cleanupSteps) ?? [],
            updatedAt: try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(WorktreeSetupFile.currentSchemaVersion, forKey: .schemaVersion)
        try container.encode(policy, forKey: .policy)
        try container.encode(steps, forKey: .steps)
        try container.encode(cleanupSteps, forKey: .cleanupSteps)
        try container.encode(updatedAt, forKey: .updatedAt)
    }

    public var hasRunnableSetup: Bool { policy != .never && !steps.isEmpty }
    public var hasCleanup: Bool { !cleanupSteps.isEmpty }
}

public enum WorktreeSetupPhase: String, Codable, Equatable, Hashable, Sendable {
    case needed
    case running
    case failed
    case ready
    case skipped
    case loadFailed = "load_failed"

    public var localizedLabel: String {
        switch self {
        case .needed:
            return String(localized: "worktreeSetup.phase.needed", defaultValue: "Local setup needed", table: "TermLoop")
        case .running:
            return String(localized: "worktreeSetup.phase.running", defaultValue: "Setting up…", table: "TermLoop")
        case .failed:
            return String(localized: "worktreeSetup.phase.failed", defaultValue: "Local setup failed", table: "TermLoop")
        case .ready:
            return String(localized: "worktreeSetup.phase.ready", defaultValue: "Local setup ready", table: "TermLoop")
        case .skipped:
            return String(localized: "worktreeSetup.phase.skipped", defaultValue: "Local setup skipped", table: "TermLoop")
        case .loadFailed:
            return String(localized: "worktreeSetup.phase.loadFailed", defaultValue: "Local setup config failed", table: "TermLoop")
        }
    }
}

public struct WorktreeSetupStatusSnapshot: Equatable, Sendable {
    public var projectId: UUID
    public var worktreePath: String
    public var phase: WorktreeSetupPhase
    public var errorMessage: String?
    public var startedAt: Date?
    public var updatedAt: Date
    public var logCursor: Int
}

public struct WorktreeSetupLogLine: Identifiable, Equatable, Sendable {
    public var id: Int { sequence }
    public let sequence: Int
    public let stream: DevServerLogStream
    public let text: String
    public let timestamp: Date
}

public enum WorktreeSetupError: Error, Equatable, LocalizedError {
    case unsupportedSchema(found: Int, supported: Int)
    case decodingFailed(String)
    case writeFailed(String)
    case configMissing
    case stepInvalid(String)
    case pathEscapesRoot(String)
    case sourceMissing(String)
    case destinationExists(String)
    case commandFailed(String, Int32)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .unsupportedSchema(let found, let supported):
            return String(localized: "worktreeSetup.error.unsupportedSchema", defaultValue: "Unsupported local setup schema \(found). This TermLoop build supports up to \(supported).", table: "TermLoop")
        case .decodingFailed(let message):
            return String(localized: "worktreeSetup.error.decodingFailed", defaultValue: "Could not read local setup config: \(message)", table: "TermLoop")
        case .writeFailed(let message):
            return String(localized: "worktreeSetup.error.writeFailed", defaultValue: "Could not write local setup config: \(message)", table: "TermLoop")
        case .configMissing:
            return String(localized: "worktreeSetup.error.configMissing", defaultValue: "No local setup config exists for this project.", table: "TermLoop")
        case .stepInvalid(let message):
            return String(localized: "worktreeSetup.error.stepInvalid", defaultValue: "Invalid local setup step: \(message)", table: "TermLoop")
        case .pathEscapesRoot(let path):
            return String(localized: "worktreeSetup.error.pathEscapesRoot", defaultValue: "Local setup path escapes the allowed root: \(path)", table: "TermLoop")
        case .sourceMissing(let path):
            return String(localized: "worktreeSetup.error.sourceMissing", defaultValue: "Local setup source does not exist: \(path)", table: "TermLoop")
        case .destinationExists(let path):
            return String(localized: "worktreeSetup.error.destinationExists", defaultValue: "Local setup destination already exists: \(path)", table: "TermLoop")
        case .commandFailed(let command, let code):
            return String(localized: "worktreeSetup.error.commandFailed", defaultValue: "Local setup command failed with code \(Int(code)): \(command)", table: "TermLoop")
        case .cancelled:
            return String(localized: "worktreeSetup.error.cancelled", defaultValue: "Local setup was cancelled.", table: "TermLoop")
        }
    }
}

private extension String {
    var nilIfBlank: String? {
        isEmpty ? nil : self
    }
}

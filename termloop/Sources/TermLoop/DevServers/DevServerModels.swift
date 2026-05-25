// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public enum RunProfileKind: String, Codable, CaseIterable, Identifiable, Equatable, Hashable, Sendable {
    case devServer = "dev_server"
    case testRunner = "test_runner"
    case worker
    case storybook
    case typecheck

    public var id: String { rawValue }

    public var localizedLabel: String {
        switch self {
        case .devServer:
            return String(localized: "devservers.kind.devServer", defaultValue: "Dev server", table: "TermLoop")
        case .testRunner:
            return String(localized: "devservers.kind.testRunner", defaultValue: "Test runner", table: "TermLoop")
        case .worker:
            return String(localized: "devservers.kind.worker", defaultValue: "Worker", table: "TermLoop")
        case .storybook:
            return String(localized: "devservers.kind.storybook", defaultValue: "Storybook", table: "TermLoop")
        case .typecheck:
            return String(localized: "devservers.kind.typecheck", defaultValue: "Typecheck", table: "TermLoop")
        }
    }
}

public enum DevServerRunPhase: String, Codable, Equatable, Hashable, Sendable {
    case idle
    case starting
    case settingUp = "setting_up"
    case running
    case stopping
    case exited
    case failed

    public var localizedLabel: String {
        switch self {
        case .idle:
            return String(localized: "devservers.phase.idle", defaultValue: "idle", table: "TermLoop")
        case .starting:
            return String(localized: "devservers.phase.starting", defaultValue: "starting", table: "TermLoop")
        case .settingUp:
            return String(localized: "devservers.phase.settingUp", defaultValue: "setting up", table: "TermLoop")
        case .running:
            return String(localized: "devservers.phase.running", defaultValue: "running", table: "TermLoop")
        case .stopping:
            return String(localized: "devservers.phase.stopping", defaultValue: "stopping", table: "TermLoop")
        case .exited:
            return String(localized: "devservers.phase.exited", defaultValue: "exited", table: "TermLoop")
        case .failed:
            return String(localized: "devservers.phase.failed", defaultValue: "failed", table: "TermLoop")
        }
    }
}

public enum DevServerLogStream: String, Codable, Equatable, Hashable, Sendable {
    case stdout
    case stderr
    case system
}

public enum DevServerProfileError: Error, Equatable, LocalizedError {
    case invalidProfileId
    case invalidName
    case invalidCommand
    case invalidWorkingDirectory

    public var errorDescription: String? {
        switch self {
        case .invalidProfileId:
            return String(
                localized: "devservers.error.invalidProfileId",
                defaultValue: "Profile id must contain letters, numbers, dot, underscore, or dash.",
                table: "TermLoop"
            )
        case .invalidName:
            return String(
                localized: "devservers.error.invalidName",
                defaultValue: "Profile name cannot be empty.",
                table: "TermLoop"
            )
        case .invalidCommand:
            return String(
                localized: "devservers.error.invalidCommand",
                defaultValue: "Profile command cannot be empty.",
                table: "TermLoop"
            )
        case .invalidWorkingDirectory:
            return String(
                localized: "devservers.error.invalidWorkingDirectory",
                defaultValue: "Working directory cannot be empty.",
                table: "TermLoop"
            )
        }
    }
}

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct DevServerDefaults: Codable, Equatable, Sendable {
    public var autoOpenFirstUrl: Bool
    public var logLineLimit: Int

    public init(autoOpenFirstUrl: Bool = false, logLineLimit: Int = 1_000) {
        self.autoOpenFirstUrl = autoOpenFirstUrl
        self.logLineLimit = Self.normalizedLogLineLimit(logLineLimit)
    }

    private enum CodingKeys: String, CodingKey {
        case autoOpenFirstUrl
        case logLineLimit
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.autoOpenFirstUrl = try container.decodeIfPresent(Bool.self, forKey: .autoOpenFirstUrl) ?? false
        self.logLineLimit = Self.normalizedLogLineLimit(
            try container.decodeIfPresent(Int.self, forKey: .logLineLimit) ?? 1_000
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(autoOpenFirstUrl, forKey: .autoOpenFirstUrl)
        try container.encode(Self.normalizedLogLineLimit(logLineLimit), forKey: .logLineLimit)
    }

    public static func normalizedLogLineLimit(_ value: Int) -> Int {
        max(100, min(value, 10_000))
    }
}

public struct DevServerURLDetection: Codable, Equatable, Sendable {
    public var autoDetect: Bool
    public var fallbackUrls: [String]
    public var readyRegexes: [String]

    public init(
        autoDetect: Bool = true,
        fallbackUrls: [String] = [],
        readyRegexes: [String] = []
    ) {
        self.autoDetect = autoDetect
        self.fallbackUrls = fallbackUrls.compactMap(Self.normalizedNonEmpty(_:))
        self.readyRegexes = readyRegexes.compactMap(Self.normalizedNonEmpty(_:))
    }

    private enum CodingKeys: String, CodingKey {
        case autoDetect
        case fallbackUrls
        case readyRegexes
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.autoDetect = try container.decodeIfPresent(Bool.self, forKey: .autoDetect) ?? true
        self.fallbackUrls = (try container.decodeIfPresent([String].self, forKey: .fallbackUrls) ?? [])
            .compactMap(Self.normalizedNonEmpty(_:))
        self.readyRegexes = (try container.decodeIfPresent([String].self, forKey: .readyRegexes) ?? [])
            .compactMap(Self.normalizedNonEmpty(_:))
    }

    private static func normalizedNonEmpty(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

public struct DevServerPresentation: Codable, Equatable, Sendable {
    public var autoOpenFirstUrl: Bool?

    public init(autoOpenFirstUrl: Bool? = nil) {
        self.autoOpenFirstUrl = autoOpenFirstUrl
    }
}

public enum DevServerSetupPolicy: String, Codable, CaseIterable, Identifiable, Equatable, Hashable, Sendable {
    case oncePerWorktreeProfileConfig = "once_per_worktree_profile_config"
    case always
    case never

    public var id: String { rawValue }

    public var localizedLabel: String {
        switch self {
        case .oncePerWorktreeProfileConfig:
            return String(localized: "devservers.setupPolicy.once", defaultValue: "Once per config", table: "TermLoop")
        case .always:
            return String(localized: "devservers.setupPolicy.always", defaultValue: "Always", table: "TermLoop")
        case .never:
            return String(localized: "devservers.setupPolicy.never", defaultValue: "Never", table: "TermLoop")
        }
    }
}

public struct DevServerProfile: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var kind: RunProfileKind
    public var command: String
    public var workingDirectory: String
    public var env: [String: String]
    public var setupCommand: String?
    public var cleanupCommand: String?
    public var setupPolicy: DevServerSetupPolicy
    public var requiresLocalSetup: Bool
    public var urlDetection: DevServerURLDetection
    public var presentation: DevServerPresentation
    public var extensions: [String: JSONValue]

    public init(
        id: String,
        name: String,
        kind: RunProfileKind = .devServer,
        command: String,
        workingDirectory: String = ".",
        env: [String: String] = [:],
        setupCommand: String? = nil,
        cleanupCommand: String? = nil,
        setupPolicy: DevServerSetupPolicy = .oncePerWorktreeProfileConfig,
        requiresLocalSetup: Bool = false,
        urlDetection: DevServerURLDetection = DevServerURLDetection(),
        presentation: DevServerPresentation = DevServerPresentation(),
        extensions: [String: JSONValue] = [:]
    ) throws {
        let normalizedId = Self.normalizedId(id)
        guard Self.isValidId(normalizedId) else { throw DevServerProfileError.invalidProfileId }
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty else { throw DevServerProfileError.invalidName }
        let normalizedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedCommand.isEmpty else { throw DevServerProfileError.invalidCommand }
        let normalizedWorkingDirectory = workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedWorkingDirectory.isEmpty else { throw DevServerProfileError.invalidWorkingDirectory }

        self.id = normalizedId
        self.name = normalizedName
        self.kind = kind
        self.command = normalizedCommand
        self.workingDirectory = normalizedWorkingDirectory
        self.env = env.compactMapValues { value in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        self.setupCommand = Self.normalizedOptionalCommand(setupCommand)
        self.cleanupCommand = Self.normalizedOptionalCommand(cleanupCommand)
        self.setupPolicy = setupPolicy
        self.requiresLocalSetup = requiresLocalSetup
        self.urlDetection = urlDetection
        self.presentation = presentation
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case kind
        case command
        case workingDirectory
        case env
        case setupCommand
        case cleanupCommand
        case setupPolicy
        case requiresLocalSetup
        case urlDetection
        case presentation
        case extensions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            id: try container.decode(String.self, forKey: .id),
            name: try container.decode(String.self, forKey: .name),
            kind: try container.decodeIfPresent(RunProfileKind.self, forKey: .kind) ?? .devServer,
            command: try container.decode(String.self, forKey: .command),
            workingDirectory: try container.decodeIfPresent(String.self, forKey: .workingDirectory) ?? ".",
            env: try container.decodeIfPresent([String: String].self, forKey: .env) ?? [:],
            setupCommand: try container.decodeIfPresent(String.self, forKey: .setupCommand),
            cleanupCommand: try container.decodeIfPresent(String.self, forKey: .cleanupCommand),
            setupPolicy: try container.decodeIfPresent(DevServerSetupPolicy.self, forKey: .setupPolicy)
                ?? .oncePerWorktreeProfileConfig,
            requiresLocalSetup: try container.decodeIfPresent(Bool.self, forKey: .requiresLocalSetup) ?? false,
            urlDetection: try container.decodeIfPresent(DevServerURLDetection.self, forKey: .urlDetection) ?? DevServerURLDetection(),
            presentation: try container.decodeIfPresent(DevServerPresentation.self, forKey: .presentation) ?? DevServerPresentation(),
            extensions: try container.decodeIfPresent([String: JSONValue].self, forKey: .extensions) ?? [:]
        )
    }

    public static func normalizedId(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func isValidId(_ id: String) -> Bool {
        guard !id.isEmpty else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar)
                || scalar == "."
                || scalar == "_"
                || scalar == "-"
        }
    }

    public static func normalizedOptionalCommand(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

public struct DevServerProfileFile: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var defaults: DevServerDefaults
    public var profiles: [DevServerProfile]
    public var updatedAt: Date

    public init(
        schemaVersion: Int = DevServerProfileFile.currentSchemaVersion,
        defaults: DevServerDefaults = DevServerDefaults(),
        profiles: [DevServerProfile] = [],
        updatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.defaults = defaults
        self.profiles = Self.normalizedProfiles(profiles)
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case defaults
        case profiles
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        self.defaults = try container.decodeIfPresent(DevServerDefaults.self, forKey: .defaults) ?? DevServerDefaults()
        self.profiles = Self.normalizedProfiles(
            try container.decodeIfPresent([DevServerProfile].self, forKey: .profiles) ?? []
        )
        self.updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(DevServerProfileFile.currentSchemaVersion, forKey: .schemaVersion)
        try container.encode(defaults, forKey: .defaults)
        try container.encode(Self.normalizedProfiles(profiles), forKey: .profiles)
        try container.encode(updatedAt, forKey: .updatedAt)
    }

    public func profile(id rawId: String) -> DevServerProfile? {
        let id = DevServerProfile.normalizedId(rawId)
        return profiles.first { $0.id == id }
    }

    public static func normalizedProfiles(_ input: [DevServerProfile]) -> [DevServerProfile] {
        var seen = Set<String>()
        return input.compactMap { profile in
            guard seen.insert(profile.id).inserted else { return nil }
            return profile
        }
        .sorted { lhs, rhs in
            lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }
}

struct DevServerProfileSchemaHeader: Decodable {
    let schemaVersion: Int
}

public struct DevServerRunKey: Codable, Equatable, Hashable, Sendable {
    public let projectId: UUID
    public let taskId: UUID?
    public let worktreePath: String?
    public let profileId: String

    public init(projectId: UUID, taskId: UUID, profileId: String) {
        self.init(projectId: projectId, taskId: taskId, worktreePath: nil, profileId: profileId)
    }

    public init(projectId: UUID, worktreePath: String, profileId: String) {
        self.init(projectId: projectId, taskId: nil, worktreePath: worktreePath, profileId: profileId)
    }

    public init(projectId: UUID, taskId: UUID?, worktreePath: String?, profileId: String) {
        self.projectId = projectId
        self.taskId = taskId
        self.worktreePath = DevServerRunKey.normalizedWorktreePath(worktreePath)
        self.profileId = DevServerProfile.normalizedId(profileId)
    }

    public static func == (lhs: DevServerRunKey, rhs: DevServerRunKey) -> Bool {
        lhs.projectId == rhs.projectId
            && lhs.profileId == rhs.profileId
            && lhs.identity == rhs.identity
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(projectId)
        hasher.combine(profileId)
        hasher.combine(identity)
    }

    private var identity: Identity {
        if let worktreePath {
            return .worktree(worktreePath)
        }
        return .task(taskId)
    }

    private enum Identity: Hashable {
        case task(UUID?)
        case worktree(String)
    }

    public static func normalizedWorktreePath(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return URL(fileURLWithPath: trimmed).resolvingSymlinksInPath().standardizedFileURL.path
    }
}

public struct DevServerLogLine: Identifiable, Codable, Equatable, Sendable {
    public let runId: UUID
    public let sequence: Int
    public let stream: DevServerLogStream
    public let text: String
    public let timestamp: Date

    public var id: String { "\(runId.uuidString):\(sequence)" }

    public init(
        runId: UUID,
        sequence: Int,
        stream: DevServerLogStream,
        text: String,
        timestamp: Date = Date()
    ) {
        self.runId = runId
        self.sequence = sequence
        self.stream = stream
        self.text = text
        self.timestamp = timestamp
    }
}

public struct DevServerRunSnapshot: Identifiable, Equatable, Sendable {
    public let runId: UUID
    public let key: DevServerRunKey
    public let profileName: String
    public let workspaceId: UUID?
    public let worktreePath: String
    public let cwd: String
    public let command: String
    public let phase: DevServerRunPhase
    public let pid: Int32?
    public let processGroupId: Int32?
    public let urls: [String]
    public let latestURL: String?
    public let recentErrorLines: [String]
    public let logCursor: Int
    public let startedAt: Date
    public let updatedAt: Date
    public let exitedAt: Date?
    public let exitCode: Int32?
    public let errorMessage: String?

    public var id: UUID { runId }

    public var isActive: Bool {
        phase == .starting || phase == .settingUp || phase == .running || phase == .stopping
    }
}

public struct TaskDevServerSummary: Equatable, Sendable {
    public let taskId: UUID
    public let runs: [DevServerRunSnapshot]

    public init(taskId: UUID, runs: [DevServerRunSnapshot]) {
        self.taskId = taskId
        self.runs = runs
    }

    public var activeRuns: [DevServerRunSnapshot] {
        runs.filter(\.isActive)
    }

    public var dominantPhase: DevServerRunPhase {
        let phases = runs.map(\.phase)
        if phases.contains(.failed) { return .failed }
        if phases.contains(.running) { return .running }
        if phases.contains(.settingUp) { return .settingUp }
        if phases.contains(.starting) { return .starting }
        if phases.contains(.stopping) { return .stopping }
        if phases.contains(.exited) { return .exited }
        return .idle
    }

    public var latestURL: String? {
        runs.compactMap(\.latestURL).first
    }

    public var recentErrorLines: [String] {
        Array(runs.flatMap(\.recentErrorLines).suffix(5))
    }

    public var compactLabel: String {
        if runs.count == 1, let run = runs.first {
            return String(
                localized: "devservers.card.singleLabel",
                defaultValue: "\(run.profileName) · \(run.phase.localizedLabel)",
                table: "TermLoop"
            )
        }
        return String(
            localized: "devservers.card.multiLabel",
            defaultValue: "Dev (\(runs.count)) · \(dominantPhase.localizedLabel)",
            table: "TermLoop"
        )
    }
}

public enum DevServerRunError: Error, Equatable, LocalizedError {
    case noProject
    case storeUnavailable
    case profileStoreLoadFailed(String)
    case profileNotFound(String)
    case taskNotFound(UUID)
    case taskNotBound(UUID)
    case worktreeMissing(String)
    case invalidWorkingDirectory(String)
    case launchFailed(String)
    case setupFailed(String)
    case runNotFound(UUID)
    case forbidden(String)

    public var code: String {
        switch self {
        case .noProject: return "no_project"
        case .storeUnavailable, .profileStoreLoadFailed: return "store_unavailable"
        case .profileNotFound: return "profile_not_found"
        case .taskNotFound: return "task_not_found"
        case .taskNotBound: return "task_not_bound"
        case .worktreeMissing: return "worktree_missing"
        case .invalidWorkingDirectory: return "invalid_params"
        case .launchFailed: return "launch_failed"
        case .setupFailed: return "setup_failed"
        case .runNotFound: return "run_not_found"
        case .forbidden: return "forbidden"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .noProject:
            return String(
                localized: "devservers.error.noProject",
                defaultValue: "No active project",
                table: "TermLoop"
            )
        case .storeUnavailable:
            return String(
                localized: "devservers.error.storeUnavailable",
                defaultValue: "Dev server store is unavailable",
                table: "TermLoop"
            )
        case .profileStoreLoadFailed(let message):
            return message
        case .profileNotFound(let id):
            return String(
                localized: "devservers.error.profileNotFound",
                defaultValue: "Dev server profile not found: \(id)",
                table: "TermLoop"
            )
        case .taskNotFound(let id):
            return String(
                localized: "devservers.error.taskNotFound",
                defaultValue: "Task not found: \(id.uuidString)",
                table: "TermLoop"
            )
        case .taskNotBound:
            return String(
                localized: "devservers.error.taskNotBound",
                defaultValue: "Task is not bound to a worktree",
                table: "TermLoop"
            )
        case .worktreeMissing(let path):
            return String(
                localized: "devservers.error.worktreeMissing",
                defaultValue: "Worktree is missing: \(path)",
                table: "TermLoop"
            )
        case .invalidWorkingDirectory(let path):
            return String(
                localized: "devservers.error.invalidWorkingDirectoryPath",
                defaultValue: "Invalid working directory: \(path)",
                table: "TermLoop"
            )
        case .launchFailed(let message):
            return String(
                localized: "devservers.error.launchFailed",
                defaultValue: "Dev server launch failed: \(message)",
                table: "TermLoop"
            )
        case .setupFailed(let message):
            return String(
                localized: "devservers.error.setupFailed",
                defaultValue: "Dev server setup failed: \(message)",
                table: "TermLoop"
            )
        case .runNotFound(let id):
            return String(
                localized: "devservers.error.runNotFound",
                defaultValue: "Dev server run not found: \(id.uuidString)",
                table: "TermLoop"
            )
        case .forbidden(let message):
            return message
        }
    }
}

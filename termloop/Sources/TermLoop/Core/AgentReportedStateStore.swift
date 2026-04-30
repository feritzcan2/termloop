// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Persistent worktree-scoped store for MCP-reported context that should
/// be SHARED across every agent session in the same worktree (ability
/// binding chips). Keyed by the canonical worktree root path so the
/// binding survives:
///
/// - workspace UUID changes (app restart, panel close/reopen)
/// - the agent that originally reported it being long gone
/// - parallel split-panel sessions in the same worktree
///
/// File: `~/Library/Application Support/TermLoop/agent-reported-state-<bundleId>.json`
@MainActor
final class AgentReportedStateStore {
    static let shared = AgentReportedStateStore()

    struct Entry: Codable, Equatable {
        /// Ability-driven bindings, keyed by `"<abilityId>.<bindingId>"`.
        /// Schema-flexible; the surfaced ability decides what `label` /
        /// `status` / `url` mean.
        var bindings: [String: AgentReportedBinding] = [:]

        init(bindings: [String: AgentReportedBinding] = [:]) {
            self.bindings = bindings
        }

        // Custom decoder: Swift's synthesized `Codable` init does not
        // honor stored-property defaults for missing keys. Keep `bindings`
        // optional at the JSON boundary so older payloads still decode as
        // an empty binding map; unknown keys are ignored by this keyed
        // container.
        private enum CodingKeys: String, CodingKey { case bindings }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.bindings = try c.decodeIfPresent(
                [String: AgentReportedBinding].self,
                forKey: .bindings
            ) ?? [:]
        }
    }

    private var entriesByPath: [String: Entry] = [:]
    private let fileURL: URL
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    private init() {
        self.fileURL = Self.defaultFileURL()
        load()
    }

    // MARK: - Public API (path-keyed)

    func entry(forPath path: String) -> Entry? {
        entriesByPath[path]
    }

    static func bindingKey(abilityId: String, bindingId: String) -> String {
        "\(abilityId).\(bindingId)"
    }

    /// Generic binding setter. Pass nil to clear. Dedupes; commits only
    /// when the stored value would change so disk + observers don't churn
    /// on repeated identical reports.
    func setBinding(_ value: AgentReportedBinding?,
                    abilityId: String,
                    bindingId: String,
                    forPath path: String) {
        var current = entriesByPath[path, default: Entry()]
        let key = Self.bindingKey(abilityId: abilityId, bindingId: bindingId)
        if value == current.bindings[key] { return }
        if let value {
            current.bindings[key] = value
        } else {
            current.bindings.removeValue(forKey: key)
        }
        commit(path: path, entry: current)
    }

    func binding(abilityId: String,
                 bindingId: String,
                 forPath path: String) -> AgentReportedBinding? {
        entriesByPath[path]?.bindings[Self.bindingKey(abilityId: abilityId,
                                                      bindingId: bindingId)]
    }

    func bindings(forPath path: String) -> [AgentReportedBinding] {
        guard let entry = entriesByPath[path] else { return [] }
        return Array(entry.bindings.values)
            .sorted { ($0.abilityId, $0.bindingId) < ($1.abilityId, $1.bindingId) }
    }

    /// Best-effort repair path for restore-time worktree path corrections.
    /// If older metadata caused an agent to publish bindings under a stale
    /// path, carry any missing binding keys forward to the corrected path.
    @discardableResult
    func copyMissingBindings(fromPath sourcePath: String, toPath destinationPath: String) -> Bool {
        guard sourcePath != destinationPath,
              let source = entriesByPath[sourcePath],
              !source.bindings.isEmpty else { return false }
        var destination = entriesByPath[destinationPath, default: Entry()]
        var didChange = false
        for (key, value) in source.bindings where destination.bindings[key] == nil {
            destination.bindings[key] = value
            didChange = true
        }
        guard didChange else { return false }
        commit(path: destinationPath, entry: destination)
        return true
    }

    /// Atomic full-replace under one ability. Removes every binding currently
    /// stored for `abilityId` at this path, then writes `values`. Single
    /// commit so disk and observers fire once per replace, not per binding.
    /// Dedupes via `sameMaterial` so re-publishing the same set with a fresh
    /// `reportedAt` does NOT count as a change (synthesized `==` would,
    /// because it covers the timestamp — defeats the no-op path entirely).
    @discardableResult
    func replaceBindings(
        underAbilityId abilityId: String,
        with values: [AgentReportedBinding],
        forPath path: String
    ) -> Bool {
        let current = entriesByPath[path] ?? Entry()
        let prefix = abilityId + "."
        let priorUnderAbility = current.bindings.filter { $0.key.hasPrefix(prefix) }
        if priorUnderAbility.count == values.count {
            let allSame = values.allSatisfy { value in
                let key = Self.bindingKey(abilityId: abilityId, bindingId: value.bindingId)
                return AgentReportedBinding.sameMaterial(priorUnderAbility[key], value)
            }
            if allSame { return false }
        }
        var next = current.bindings
        for key in current.bindings.keys where key.hasPrefix(prefix) {
            next.removeValue(forKey: key)
        }
        for value in values {
            let key = Self.bindingKey(abilityId: abilityId, bindingId: value.bindingId)
            next[key] = value
        }
        commit(path: path, entry: Entry(bindings: next))
        return true
    }

    // MARK: - Persistence

    private func commit(path: String, entry: Entry) {
        if entry.bindings.isEmpty {
            entriesByPath.removeValue(forKey: path)
        } else {
            entriesByPath[path] = entry
        }
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? decoder.decode([String: Entry].self, from: data) else {
            return
        }
        self.entriesByPath = decoded
    }

    private func save() {
        guard let data = try? encoder.encode(entriesByPath) else { return }
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: [.atomic])
    }

    // MARK: - Binding value type

    /// Pure-telemetry payload reported by an agent after it took some
    /// action it wants surfaced on the workspace (Jira-style ticket,
    /// deploy chip, incident link, …). Schema is intentionally flat so
    /// any ability can use it without app code changes — the ability's
    /// `binding.title` provides the column heading; `label` / `status` /
    /// `url` carry the per-instance data.
    struct AgentReportedBinding: Codable, Equatable, Hashable {
        let abilityId: String
        let bindingId: String
        let label: String
        let status: String?
        let url: String?
        let reportedAt: Date

        var displayLabel: String {
            if let status, !status.isEmpty {
                return "\(label) · \(status)"
            }
            return label
        }

        var destinationURL: URL? {
            guard let url, !url.isEmpty else { return nil }
            return URL(string: url)
        }

        /// Equality on the user-visible payload only. The synthesized
        /// `Equatable` covers `reportedAt` too, which is fine for storage /
        /// round-trip tests but useless for dedupe — the socket handler
        /// stamps `Date()` on every call, so two identical re-reports would
        /// never compare equal and the version counter would bump on
        /// every no-op. Use this from the setter and any other dedupe path.
        static func sameMaterial(_ a: Self?, _ b: Self?) -> Bool {
            switch (a, b) {
            case (nil, nil): return true
            case let (lhs?, rhs?):
                return lhs.label == rhs.label
                    && lhs.status == rhs.status
                    && lhs.url == rhs.url
            default: return false
            }
        }
    }

    private static func defaultFileURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        let dir = base.appendingPathComponent("TermLoop", isDirectory: true)
        let bundleId = Bundle.main.bundleIdentifier ?? "com.termloop.app"
        return dir.appendingPathComponent("agent-reported-state-\(bundleId).json", isDirectory: false)
    }
}

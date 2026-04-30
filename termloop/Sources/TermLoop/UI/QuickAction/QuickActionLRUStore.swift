// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Free-prompt row sentinel key for `QuickActionLRUState.advanced`.
let quickActionFreePromptSentinel = "__free_prompt__"

struct QuickActionAdvancedMemory: Codable, Equatable {
    var permissionMode: String?
    var variableValues: [String: String] = [:]
    /// Typed persisted model choice. Optional so pre-redesign blobs and
    /// legacy unrecognized model strings decode to `nil` rather than
    /// failing the whole record.
    var modelOverride: AgentModelOption?
    /// Typed persisted reasoning-effort choice. Optional for the same
    /// migration reason as `modelOverride`.
    var reasoningOverride: AgentReasoningOption?
    /// Per-invocation system / developer instructions.
    var systemPrompt: String?

    init(
        permissionMode: String? = nil,
        variableValues: [String: String] = [:],
        modelOverride: AgentModelOption? = nil,
        reasoningOverride: AgentReasoningOption? = nil,
        systemPrompt: String? = nil
    ) {
        self.permissionMode = permissionMode
        self.variableValues = variableValues
        self.modelOverride = modelOverride
        self.reasoningOverride = reasoningOverride
        self.systemPrompt = systemPrompt
    }

    private enum CodingKeys: String, CodingKey {
        case permissionMode, variableValues, modelOverride, reasoningOverride, systemPrompt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        permissionMode = try c.decodeIfPresent(String.self, forKey: .permissionMode)
        variableValues = try c.decodeIfPresent([String: String].self, forKey: .variableValues) ?? [:]
        // Accept both the typed enum (current encoding) and the legacy raw
        // String ("opus" / "sonnet" / "default" / anything-else). Unknown
        // strings fall through to nil so upgrades don't break the record.
        modelOverride = (try? c.decodeIfPresent(AgentModelOption.self, forKey: .modelOverride))
            ?? (try? c.decodeIfPresent(String.self, forKey: .modelOverride))
                .flatMap { AgentModelOption(rawValue: $0) }
        reasoningOverride = (try? c.decodeIfPresent(AgentReasoningOption.self, forKey: .reasoningOverride))
            ?? (try? c.decodeIfPresent(String.self, forKey: .reasoningOverride))
                .flatMap { AgentReasoningOption(rawValue: $0) }
        systemPrompt = try c.decodeIfPresent(String.self, forKey: .systemPrompt)
    }
}

struct QuickActionAgentMemory: Codable, Equatable {
    var modelOverride: AgentModelOption?
    var reasoningOverride: AgentReasoningOption?

    init(
        modelOverride: AgentModelOption? = nil,
        reasoningOverride: AgentReasoningOption? = nil
    ) {
        self.modelOverride = modelOverride
        self.reasoningOverride = reasoningOverride
    }
}

struct QuickActionLRUState: Codable, Equatable {
    var templateOrder: [String] = []
    var advanced: [String: QuickActionAdvancedMemory] = [:]
    var agentAdvanced: [String: QuickActionAgentMemory] = [:]
    var lastFreePromptTemplateId: String?
    /// Remembered across every palette invocation. Always "terminal" today
    /// (the only `QuickActionRunMode` case), but kept as a free-form string
    /// so older persisted blobs still decode.
    var lastRunMode: String?
    /// Remembered terminal-agent id from the last "terminal" run (claude, codex, ...).
    var lastTerminalAgentId: String?
}

/// UserDefaults-backed store for the Quick Action palette's LRU and per-
/// template advanced-memory state. Single-blob JSON under one key avoids
/// multi-key race conditions and is trivially rewritable.
@MainActor
final class QuickActionLRUStore {
    static let shared = QuickActionLRUStore()

    private static let defaultsKey = "termloop.quickAction.lruState.v1"
    private let defaults: UserDefaults
    private let logger = Logger(subsystem: "com.termloop.fork", category: "quickAction.lru")
    private var state: QuickActionLRUState

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.state = Self.load(from: defaults) ?? QuickActionLRUState()
    }

    // MARK: Load / Save

    private static func load(from defaults: UserDefaults) -> QuickActionLRUState? {
        guard let data = defaults.data(forKey: defaultsKey) else { return nil }
        return try? JSONDecoder().decode(QuickActionLRUState.self, from: data)
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(state) else {
            logger.error("Failed to encode QuickActionLRUState")
            return
        }
        defaults.set(data, forKey: Self.defaultsKey)
    }

    // MARK: Reads

    /// Returns template ids in most-recently-used order, filtered to the
    /// provided set of currently-registered ids. Unknown ids are silently
    /// dropped (a "clean on read" pass) and persisted away on the next
    /// mutation. Registered ids not present in the LRU are returned last,
    /// alphabetically sorted.
    func orderedTemplateIds(registered: [String]) -> [String] {
        let registeredSet = Set(registered)
        let seen = state.templateOrder.filter(registeredSet.contains)
        let seenSet = Set(seen)
        let rest = registered.filter { !seenSet.contains($0) }.sorted()
        return seen + rest
    }

    func advancedMemory(forTemplateId id: String) -> QuickActionAdvancedMemory? {
        state.advanced[id]
    }

    func freePromptAdvancedMemory() -> QuickActionAdvancedMemory? {
        // Defensive: silently discard any persisted memory whose system prompt
        // looks like a customize-with-agent leak. Customize launches now skip
        // persistence (see `persistLRUOnSuccess`), but legacy state from
        // before that fix can still polute restores.
        let mem = state.advanced[quickActionFreePromptSentinel]
        if let body = mem?.systemPrompt, body.contains("Ability Customizer") {
            return nil
        }
        return mem
    }

    func lastFreePromptTemplateId() -> String? {
        state.lastFreePromptTemplateId
    }

    func lastRunMode() -> String? {
        state.lastRunMode
    }

    func lastTerminalAgentId() -> String? {
        state.lastTerminalAgentId
    }

    func agentAdvancedMemory(forAgentId id: String) -> QuickActionAgentMemory? {
        state.agentAdvanced[id]
    }

    // MARK: Mutations

    /// Moves `id` to the front of the LRU. Creates the entry if missing.
    func recordRun(templateId id: String) {
        state.templateOrder.removeAll { $0 == id }
        state.templateOrder.insert(id, at: 0)
        persist()
    }

    func recordFreePromptRun(resolvedTemplateId: String) {
        state.lastFreePromptTemplateId = resolvedTemplateId
        state.templateOrder.removeAll { $0 == resolvedTemplateId }
        state.templateOrder.insert(resolvedTemplateId, at: 0)
        persist()
    }

    func setAdvanced(_ memory: QuickActionAdvancedMemory, forTemplateId id: String) {
        state.advanced[id] = memory
        persist()
    }

    func setFreePromptAdvanced(_ memory: QuickActionAdvancedMemory) {
        state.advanced[quickActionFreePromptSentinel] = memory
        persist()
    }

    func setAgentAdvanced(_ memory: QuickActionAgentMemory, forAgentId id: String) {
        state.agentAdvanced[id] = memory
        persist()
    }

    func setLastRunMode(_ mode: String) {
        guard state.lastRunMode != mode else { return }
        state.lastRunMode = mode
        persist()
    }

    func setLastTerminalAgentId(_ id: String) {
        guard state.lastTerminalAgentId != id else { return }
        state.lastTerminalAgentId = id
        persist()
    }

    func removeEntries(forTemplateIds idsToRemove: Set<String>) {
        guard !idsToRemove.isEmpty else { return }
        let before = state
        state.templateOrder.removeAll { idsToRemove.contains($0) }
        for id in idsToRemove { state.advanced.removeValue(forKey: id) }
        if let last = state.lastFreePromptTemplateId, idsToRemove.contains(last) {
            state.lastFreePromptTemplateId = nil
        }
        if state != before { persist() }
    }

    /// Clears the entire LRU. Surfaced via the "Reset LRU" Settings button.
    func resetAll() {
        state = QuickActionLRUState()
        defaults.removeObject(forKey: Self.defaultsKey)
    }
}

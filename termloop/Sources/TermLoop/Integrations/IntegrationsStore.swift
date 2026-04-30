// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation
import SwiftUI

/// Observable catalog of discovered integrations. Merges results from each
/// `IntegrationDiscovery` implementation by stable id
/// (`<kind>:<name>`), with project-scope items winning over user-scope on
/// collisions.
///
/// Refresh runs all discoveries on a background task and publishes on the
/// main actor. A disk cache at
/// `~/Library/Application Support/TermLoop/integrations/cache.json` is
/// loaded synchronously on init so UI has something to render instantly.
@MainActor
final class IntegrationsStore: ObservableObject {
    static let shared = IntegrationsStore()

    @Published private(set) var items: [IntegrationItem] = []
    @Published private(set) var isRefreshing: Bool = false
    @Published private(set) var lastRefreshedAt: Date? = nil

    /// When true, every successful `refresh()` triggers a bulk
    /// `IntegrationTester.testAll()` for discovered items. Enabled by
    /// default so the tab answers "can my agents use X right now?"
    /// without an extra user action.
    var autoTestOnRefresh: Bool = true

    private var discoveries: [IntegrationDiscovery]
    private var refreshTask: Task<Void, Never>?

    /// URL for the currently "active" project root used by project-scope
    /// discoveries (MCP `.mcp.json`, Claude project settings). Updated via
    /// `setActiveProjectRoot(_:)` on project switch.
    private(set) var activeProjectRoot: URL?

    private init() {
        self.discoveries = [
            TermLoopBuiltInDiscovery(),
            MCPDiscovery(),
            CLIDiscovery(),
            WebhookDiscovery(),
            ClaudeHookDiscovery(),
            CodexHookDiscovery(),
            GeminiHookDiscovery(),
        ]
        loadCacheIfAvailable()
    }

    func setActiveProjectRoot(_ url: URL?) {
        guard url != activeProjectRoot else { return }
        activeProjectRoot = url
        refresh()
    }

    func refresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self else { return }
            await self.performRefresh()
        }
    }

    /// Debounced refresh for view-mount triggers (Setup card, ability
    /// detail). Skips when the last refresh is recent enough so transient
    /// UI churn doesn't restart the discovery + `testAll` pipeline on
    /// every appear.
    func refreshIfStale(maxAge: TimeInterval = 30) {
        if let last = lastRefreshedAt, Date().timeIntervalSince(last) < maxAge {
            return
        }
        refresh()
    }

    private func performRefresh() async {
        isRefreshing = true
        let projectRoot = activeProjectRoot
        let discs = discoveries
        let discovered: [IntegrationItem] = await withTaskGroup(of: [IntegrationItem].self) { group in
            for disc in discs {
                group.addTask {
                    await disc.discover(projectRoot: projectRoot)
                }
            }
            var combined: [IntegrationItem] = []
            for await batch in group {
                combined.append(contentsOf: batch)
            }
            return combined
        }
        let merged = Self.mergeById(items: discovered, previous: items)
        self.items = merged
        self.lastRefreshedAt = Date()
        self.isRefreshing = false
        persistCache()
        if autoTestOnRefresh {
            Task { await IntegrationTester.shared.testAll() }
        }
    }

    func updateItem(id: String, mutate: (inout IntegrationItem) -> Void) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        mutate(&items[idx])
    }

    func item(id: String) -> IntegrationItem? {
        items.first(where: { $0.id == id })
    }

    func items(of kind: IntegrationKind) -> [IntegrationItem] {
        items.filter { $0.kind == kind }
             .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    // MARK: - Merge

    /// Merge newly discovered items with previous snapshot, preserving
    /// last-test metadata and config refs when status is fresh `.idle`.
    static func mergeById(items new: [IntegrationItem],
                          previous old: [IntegrationItem]) -> [IntegrationItem] {
        var byId: [String: IntegrationItem] = [:]
        for item in new {
            byId[item.id] = byId[item.id]?.merged(with: item) ?? item
        }
        // Carry over per-item dynamic state from previous snapshot.
        let oldById = Dictionary(uniqueKeysWithValues: old.map { ($0.id, $0) })
        for (id, prev) in oldById {
            guard var fresh = byId[id] else { continue }
            if fresh.status == .idle {
                fresh.status = prev.status
            }
            if fresh.lastTestedAt == nil { fresh.lastTestedAt = prev.lastTestedAt }
            if fresh.lastTestDurationMs == nil { fresh.lastTestDurationMs = prev.lastTestDurationMs }
            if fresh.capabilities.isEmpty { fresh.capabilities = prev.capabilities }
            if fresh.configRef == nil { fresh.configRef = prev.configRef }
            fresh.attachedToActiveSpawn = prev.attachedToActiveSpawn
            byId[id] = fresh
        }
        return byId.values.sorted { a, b in
            if a.kind.orderIndex != b.kind.orderIndex {
                return a.kind.orderIndex < b.kind.orderIndex
            }
            return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
        }
    }

    // MARK: - Cache

    private struct CacheRecord: Codable {
        let id: String
        let kind: IntegrationKind
        let displayName: String
        let summary: String
        let binaryPath: String?
        let version: String?
        let authSubject: String?
        let capabilities: [String]
    }

    private struct CacheEnvelope: Codable {
        let version: Int
        let records: [CacheRecord]
    }

    private static let cacheVersion = 2

    private var cacheURL: URL {
        IntegrationsPaths.supportDir().appendingPathComponent("cache.json", isDirectory: false)
    }

    private func loadCacheIfAvailable() {
        let url = cacheURL
        guard let data = try? Data(contentsOf: url) else { return }
        guard let envelope = try? JSONDecoder().decode(CacheEnvelope.self, from: data),
              envelope.version == Self.cacheVersion else {
            return
        }
        items = envelope.records.map { rec in
            IntegrationItem(
                id: rec.id,
                kind: rec.kind,
                displayName: rec.displayName,
                summary: rec.summary,
                source: .termLoop,
                status: .idle,
                lastTestedAt: nil,
                lastTestDurationMs: nil,
                capabilities: rec.capabilities,
                configRef: nil,
                attachedToActiveSpawn: false,
                binaryPath: rec.binaryPath,
                version: rec.version,
                authSubject: rec.authSubject
            )
        }
    }

    private func persistCache() {
        let envelope = CacheEnvelope(
            version: Self.cacheVersion,
            records: items.map {
            CacheRecord(
                id: $0.id,
                kind: $0.kind,
                displayName: $0.displayName,
                summary: $0.summary,
                binaryPath: $0.binaryPath,
                version: $0.version,
                authSubject: $0.authSubject,
                capabilities: $0.capabilities
            )
        })
        IntegrationsPaths.ensureSupportDir()
        let url = cacheURL
        guard let data = try? JSONEncoder().encode(envelope) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

struct TermLoopBuiltInDiscovery: IntegrationDiscovery {
    let kind: IntegrationKind = .mcp

    func discover(projectRoot: URL?) async -> [IntegrationItem] {
        [TermLoopBuiltInMCP.item()]
    }
}

/// Protocol implemented by each per-kind discovery module. All methods run
/// off the main actor.
protocol IntegrationDiscovery: Sendable {
    var kind: IntegrationKind { get }
    func discover(projectRoot: URL?) async -> [IntegrationItem]
}

enum IntegrationsPaths {
    static func supportDir() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        return base.appendingPathComponent("TermLoop/integrations", isDirectory: true)
    }

    static func logsDir() -> URL {
        supportDir().appendingPathComponent("logs", isDirectory: true)
    }

    static func configFile() -> URL {
        supportDir().appendingPathComponent("config.json", isDirectory: false)
    }

    static func webhooksFile() -> URL {
        supportDir().appendingPathComponent("webhooks.json", isDirectory: false)
    }

    static func setsFile() -> URL {
        supportDir().appendingPathComponent("sets.json", isDirectory: false)
    }

    static func dismissedFile() -> URL {
        supportDir().appendingPathComponent("dismissed.json", isDirectory: false)
    }

    static func ensureSupportDir() {
        try? FileManager.default.createDirectory(at: supportDir(),
                                                 withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: logsDir(),
                                                 withIntermediateDirectories: true)
    }
}

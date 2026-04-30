// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Darwin
import Foundation
import SwiftUI
import os

/// Observable catalog of the active project's abilities.
///
/// A single shared instance backs the sidebar panel and the injector. The
/// store mirrors the `<projectRoot>/.termloop/abilities/` directory on disk:
/// it reloads whenever the active project changes or a filesystem event
/// fires for that directory. Debounce coalesces rapid editor saves.
@MainActor
final class AbilityStore: ObservableObject {
    static let shared = AbilityStore()

    @Published private(set) var abilities: [Ability] = []
    /// True when `<projectRoot>/.termloop/abilities/` exists. Drives the
    /// setup-vs-populated sidebar states.
    @Published private(set) var isInitialized: Bool = false

    private var activeProjectSub: AnyCancellable?
    private var watchSources: [DispatchSourceFileSystemObject] = []
    private var watchedFDs: [Int32] = []
    private var debounceWork: DispatchWorkItem?
    private var currentProjectFolder: URL?
    private let logger = Logger(subsystem: "ai.termloop", category: "abilities")

    /// Per-ability memory of the last non-`.off` activation mode, so the
    /// sidebar Toggle can restore the user's prior choice instead of always
    /// jumping to `.always`. Captured by `setActivation` before any write of
    /// `.off`, so both the Toggle and the dropdown menu participate.
    private var lastNonOffActivation: [String: AbilityActivation] = [:]
    private let lastNonOffKey = "termloop.abilities.lastNonOffActivation"

    private init() {
        if let raw = UserDefaults.standard.dictionary(forKey: lastNonOffKey) as? [String: String] {
            lastNonOffActivation = raw.compactMapValues { AbilityActivation(rawValue: $0) }
        }
    }

    /// Binds the store to `ProjectStore` and loads the active project's
    /// abilities (if any). Safe to call multiple times.
    func start() {
        if activeProjectSub != nil { return }
        activeProjectSub = ProjectStore.shared.$activeProjectId
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.refreshActiveProject()
            }
        refreshActiveProject()
    }

    // MARK: - Public API

    /// Creates `<projectRoot>/.termloop/abilities/` for the active project.
    /// No-op when the directory already exists.
    func initializeDirectory() {
        guard let folder = currentProjectFolder else { return }
        let dir = folder.appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("abilities", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        reload()
    }

    /// Writes or overwrites an ability file with the given fields. The id
    /// stays locked to the bundle directory name.
    func save(_ ability: Ability) {
        do {
            let legacyFilePathToRemove: URL?
            let abilityToSave: Ability
            if ability.storageKind == .bundle {
                abilityToSave = ability
                legacyFilePathToRemove = nil
            } else {
                guard let dir = abilitiesDirectoryURL() else { return }
                let legacyFilePath = ability.filePath
                abilityToSave = Ability(
                    id: ability.id,
                    name: ability.name,
                    description: ability.description,
                    activation: ability.activation,
                    body: ability.body,
                    tags: ability.tags,
                    items: ability.items,
                    filePath: AbilityBundleStore.instructionFileURL(parentDirectory: dir, slug: ability.id),
                    metadataFilePath: AbilityBundleStore.metadataFileURL(parentDirectory: dir, slug: ability.id),
                    storageKind: .bundle
                )
                legacyFilePathToRemove = legacyFilePath != abilityToSave.filePath ? legacyFilePath : nil
            }
            try AbilityBundleStore.save(abilityToSave)
            if let legacyFilePathToRemove {
                try? FileManager.default.removeItem(at: legacyFilePathToRemove)
            }
        } catch {
            logger.error("abilities save failed: \(error.localizedDescription, privacy: .public)")
        }
        reload()
    }

    /// Rewrites only the `activation` field on an existing file, preserving
    /// the body byte-for-byte.
    func setActivation(id: String, _ mode: AbilityActivation) {
        guard let ability = abilities.first(where: { $0.id == id }) else { return }
        if mode == .off, ability.activation != .off {
            lastNonOffActivation[id] = ability.activation
            persistLastNonOffActivation()
        }
        var updated = ability
        updated.activation = mode
        save(updated)
    }

    /// Sidebar Toggle handler: flips between `.off` and the most recent
    /// non-off mode (falls back to `.listed` when no prior memory exists).
    func toggleActivation(id: String) {
        guard let ability = abilities.first(where: { $0.id == id }) else { return }
        let next: AbilityActivation = (ability.activation == .off)
            ? (lastNonOffActivation[id] ?? .listed)
            : .off
        setActivation(id: id, next)
    }

    private func persistLastNonOffActivation() {
        let raw = lastNonOffActivation.mapValues { $0.rawValue }
        UserDefaults.standard.set(raw, forKey: lastNonOffKey)
    }

    func setMCPToolEnabled(id: String, toolName: String, enabled: Bool) {
        guard let ability = abilities.first(where: { $0.id == id }) else { return }
        var updated = ability
        updated.mcpTools = updated.mcpTools.map { binding in
            binding.name == toolName
                ? AbilityMCPToolBinding(name: binding.name, enabled: enabled)
                : binding
        }
        save(updated)
    }

    func delete(id: String) {
        guard let ability = abilities.first(where: { $0.id == id }) else { return }
        switch ability.storageKind {
        case .bundle:
            try? FileManager.default.removeItem(at: ability.metadataFilePath.deletingLastPathComponent())
        case .legacyMarkdownFile:
            try? FileManager.default.removeItem(at: ability.filePath)
        }
        reload()
    }

    /// Target markdown URL for a new ability bundle's primary instruction file.
    func fileURL(slug: String) -> URL? {
        guard let dir = abilitiesDirectoryURL() else { return nil }
        return AbilityBundleStore.instructionFileURL(parentDirectory: dir, slug: slug)
    }

    func ability(id: String) -> Ability? {
        abilities.first(where: { $0.id == id })
    }

    @discardableResult
    func installStarter(_ starter: AbilityStarter) -> Ability? {
        guard let dir = abilitiesDirectoryURL() else { return nil }
        let destBundleURL = AbilityBundleStore.bundleDirectoryURL(parentDirectory: dir, slug: starter.id)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: destBundleURL)
        do {
            try FileManager.default.copyItem(at: starter.bundleDirectoryURL, to: destBundleURL)
        } catch {
            logger.error("starter install copy failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        // Newly-installed abilities start disabled — user opts in via the
        // sidebar Toggle. Stash the starter's bundled activation in
        // `lastNonOffActivation` so the first toggle-on restores the
        // intended default mode (e.g. `.listed`) instead of the global
        // fallback.
        if starter.activation != .off {
            lastNonOffActivation[starter.id] = starter.activation
            persistLastNonOffActivation()
        }
        if let installed = try? AbilityBundleStore.load(from: destBundleURL),
           installed.activation != .off {
            var updated = installed
            updated.activation = .off
            save(updated)
        } else {
            reload()
        }
        return ability(id: starter.id)
    }

    /// The active project's `<folder>/.termloop/abilities/` URL (even if it
    /// does not yet exist on disk).
    func abilitiesDirectoryURL() -> URL? {
        guard let folder = currentProjectFolder else { return nil }
        return folder.appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("abilities", isDirectory: true)
    }

    // MARK: - Project switching

    private func refreshActiveProject() {
        let folder: URL? = {
            guard let id = ProjectStore.shared.activeProjectId,
                  let project = ProjectStore.shared.project(id: id) else { return nil }
            return URL(fileURLWithPath: project.folderPath, isDirectory: true)
        }()
        currentProjectFolder = folder
        stopWatching()
        reload()
        startWatching()
    }

    // MARK: - Filesystem watcher

    private func startWatching() {
        guard let dir = abilitiesDirectoryURL() else { return }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir),
              isDir.boolValue else { return }
        let childDirectories = ((try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []).filter(\.hasDirectoryPath)
        ([dir] + childDirectories).forEach(startWatchingDirectory)
    }

    private func startWatchingDirectory(_ url: URL) {
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename],
            queue: DispatchQueue.main
        )
        source.setEventHandler { [weak self] in
            self?.scheduleDebouncedReload()
        }
        source.setCancelHandler {
            close(fd)
        }
        watchedFDs.append(fd)
        watchSources.append(source)
        source.resume()
    }

    private func stopWatching() {
        watchSources.forEach { $0.cancel() }
        watchSources.removeAll()
        watchedFDs.removeAll()
        debounceWork?.cancel()
        debounceWork = nil
    }

    private func scheduleDebouncedReload() {
        debounceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.reload()
            // Directory might have just been created/deleted under us; rebind
            // the watcher so we don't lose events.
            self?.rebindWatcherIfNeeded()
        }
        debounceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: work)
    }

    private func rebindWatcherIfNeeded() {
        guard let dir = abilitiesDirectoryURL() else { return }
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir) && isDir.boolValue
        if exists && watchSources.isEmpty {
            startWatching()
        } else if !exists && !watchSources.isEmpty {
            stopWatching()
        } else if exists {
            stopWatching()
            startWatching()
        }
    }

    // MARK: - Load

    private func reload() {
        guard let dir = abilitiesDirectoryURL() else {
            isInitialized = false
            abilities = []
            return
        }
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir) && isDir.boolValue
        isInitialized = exists
        guard exists else {
            abilities = []
            return
        }
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        let loaded: [Ability] = entries
            .compactMap { url -> Ability? in
                if url.hasDirectoryPath {
                    do {
                        return try AbilityBundleStore.load(from: url)
                    } catch {
                        logger.warning("ability parse failed: \(url.lastPathComponent, privacy: .public)")
                        return nil
                    }
                }
                guard url.pathExtension.lowercased() == "md" else { return nil }
                guard let text = try? String(contentsOf: url, encoding: .utf8),
                      let parsed = AbilityFrontmatter.parse(text) else {
                    logger.warning("legacy ability parse failed: \(url.lastPathComponent, privacy: .public)")
                    return nil
                }
                let slug = url.deletingPathExtension().lastPathComponent
                return Ability(
                    id: slug,
                    name: parsed.fields.name,
                    description: parsed.fields.description,
                    activation: parsed.fields.activation,
                    body: parsed.body,
                    tags: [],
                    items: [],
                    filePath: url,
                    metadataFilePath: url,
                    storageKind: .legacyMarkdownFile
                )
            }
        var preferredById: [String: Ability] = [:]
        for ability in loaded {
            if let existing = preferredById[ability.id] {
                switch (existing.storageKind, ability.storageKind) {
                case (.legacyMarkdownFile, .bundle):
                    preferredById[ability.id] = ability
                case (.bundle, .legacyMarkdownFile):
                    continue
                default:
                    preferredById[ability.id] = ability
                }
            } else {
                preferredById[ability.id] = ability
            }
        }
        abilities = preferredById.values.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        // Mirror canonical skills into the project root's native catalogs as
        // soon as the ability set changes — saves the user from clicking a
        // "Sync native files" button. Worktree mirrors stay launch-time only
        // (we don't know which worktrees the user cares about here).
        ProjectSkillMaterializer.materialize(
            projectFolderPath: currentProjectFolder?.path,
            abilities: abilities
        )
    }
}

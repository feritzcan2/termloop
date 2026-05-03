// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import CoreServices
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
    private var skillTreeStream: FSEventStreamRef?
    private var debounceWork: DispatchWorkItem?
    private var skillSyncDebounceWork: DispatchWorkItem?
    private var pendingChangedSkillIds = Set<String>()
    private var currentProjectFolder: URL?
    private let logger = Logger(subsystem: "ai.termloop", category: "abilities")

    /// Per-ability memory of the last non-`.off` activation mode, so the
    /// sidebar Toggle can restore the user's prior choice instead of always
    /// jumping to `.always`. `setActivation` updates it for explicit non-off
    /// choices and preserves the previous mode before writing `.off`, so both
    /// the Toggle and the dropdown menu participate.
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
        stopWatching()
        startWatching()
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
        if mode == .off {
            if ability.activation != .off {
                lastNonOffActivation[id] = ability.activation
                persistLastNonOffActivation()
            }
        } else {
            if lastNonOffActivation[id] != mode {
                lastNonOffActivation[id] = mode
                persistLastNonOffActivation()
            }
        }
        var updated = ability
        updated.activation = mode
        save(updated)
    }

    private func setActivationToWorktree(_ ability: Ability) {
        if lastNonOffActivation[ability.id] != .worktree {
            lastNonOffActivation[ability.id] = .worktree
            persistLastNonOffActivation()
        }
        var updated = ability
        updated.activation = .worktree
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
        startWatchingSkillTree()
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
        stopWatchingSkillTree()
        debounceWork?.cancel()
        debounceWork = nil
        skillSyncDebounceWork?.cancel()
        skillSyncDebounceWork = nil
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
        if exists && (watchSources.isEmpty || skillTreeStream == nil) {
            stopWatching()
            startWatching()
        } else if !exists && !watchSources.isEmpty {
            stopWatching()
            startWatching()
        } else if !exists && skillTreeStream == nil {
            startWatching()
        } else if exists {
            stopWatching()
            startWatching()
        }
    }

    private func startWatchingSkillTree() {
        guard skillTreeStream == nil,
              let folder = currentProjectFolder else { return }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDir),
              isDir.boolValue else { return }

        let callback: FSEventStreamCallback = { _, clientInfo, _, eventPaths, _, _ in
            guard let clientInfo else { return }
            let paths = unsafeBitCast(eventPaths, to: NSArray.self) as? [String] ?? []
            let touchedSkillIds = Set(paths.compactMap(AbilityStore.skillIdFromCanonicalSkillPath))
            let touchedSkills = paths.contains { path in
                path.contains("/.termloop/skills/")
                    || path.hasSuffix("/.termloop/skills")
            }
            let touchedAbilities = paths.contains { path in
                path.contains("/.termloop/abilities/")
                    || path.hasSuffix("/.termloop/abilities")
            }
            guard touchedSkills || touchedAbilities else { return }
            let store = Unmanaged<AbilityStore>
                .fromOpaque(clientInfo)
                .takeUnretainedValue()
            Task { @MainActor in
                if touchedAbilities {
                    store.scheduleDebouncedReload()
                }
                if touchedSkills {
                    store.scheduleDebouncedSkillMaterialize(skillIds: touchedSkillIds)
                }
            }
        }
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        guard let stream = FSEventStreamCreate(
            nil,
            callback,
            &context,
            [folder.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.2,
            FSEventStreamCreateFlags(
                kFSEventStreamCreateFlagFileEvents
                    | kFSEventStreamCreateFlagNoDefer
                    | kFSEventStreamCreateFlagUseCFTypes
            )
        ) else { return }
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
        FSEventStreamStart(stream)
        skillTreeStream = stream
    }

    private func stopWatchingSkillTree() {
        guard let stream = skillTreeStream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        skillTreeStream = nil
    }

    private static func skillIdFromCanonicalSkillPath(_ path: String) -> String? {
        guard let range = path.range(of: "/.termloop/skills/") else { return nil }
        let remainder = path[range.upperBound...]
        guard let skillId = remainder.split(separator: "/", omittingEmptySubsequences: true).first else {
            return nil
        }
        return String(skillId)
    }

    private func scheduleDebouncedSkillMaterialize(skillIds: Set<String> = []) {
        pendingChangedSkillIds.formUnion(skillIds)
        skillSyncDebounceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let changedSkillIds = self.pendingChangedSkillIds
            self.pendingChangedSkillIds.removeAll()
            self.materializeNativeSkillsAfterSkillChange(changedSkillIds: changedSkillIds)
        }
        skillSyncDebounceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
    }

    private func materializeNativeSkillsAfterSkillChange(changedSkillIds: Set<String>) {
        reload()
        guard let projectFolderPath = currentProjectFolder?.path else { return }
        if enableWorktreeAbilitiesForExistingSkills(
            projectFolderPath: projectFolderPath,
            changedSkillIds: changedSkillIds
        ) {
            reload()
        }
        ProjectSkillMaterializer.materialize(
            projectFolderPath: projectFolderPath,
            abilities: abilities
        )
        materializeExistingStarterSkills(
            projectFolderPath: projectFolderPath,
            changedSkillIds: changedSkillIds
        )
    }

    @discardableResult
    private func enableWorktreeAbilitiesForExistingSkills(
        projectFolderPath: String,
        changedSkillIds: Set<String>
    ) -> Bool {
        let projectRoot = URL(fileURLWithPath: projectFolderPath, isDirectory: true)
        let existingSkillIds = existingCanonicalSkillIds(projectRoot: projectRoot)
        let targetSkillIds = changedSkillIds.isEmpty
            ? existingSkillIds
            : existingSkillIds.intersection(changedSkillIds)
        guard !targetSkillIds.isEmpty else { return false }

        var changed = false
        let installedAbilitiesToEnable = abilities.filter { ability in
            ability.activation != .worktree
                && ability.activation != .always
                && ability.requiredSkillIDs.contains { targetSkillIds.contains($0) }
        }
        for ability in installedAbilitiesToEnable {
            setActivationToWorktree(ability)
            changed = true
        }

        if changed {
            reload()
        }

        var installedAbilityIds = Set(abilities.map(\.id))
        for starter in ProjectInstructionStore.loadStarters() where !installedAbilityIds.contains(starter.id) {
            guard let starterAbility = ProjectInstructionStore.loadStarterAbility(starter),
                  starterAbility.requiredSkillIDs.contains(where: { targetSkillIds.contains($0) }),
                  let installed = installStarter(starter) else {
                continue
            }
            setActivation(id: installed.id, .worktree)
            installedAbilityIds.insert(starter.id)
            changed = true
        }

        return changed
    }

    private func materializeExistingStarterSkills(
        projectFolderPath: String,
        changedSkillIds: Set<String>
    ) {
        let projectRoot = URL(fileURLWithPath: projectFolderPath, isDirectory: true)
        let existingSkillIds = existingCanonicalSkillIds(projectRoot: projectRoot)
        let targetSkillIds = changedSkillIds.isEmpty
            ? existingSkillIds
            : existingSkillIds.intersection(changedSkillIds)
        guard !targetSkillIds.isEmpty else { return }
        let disabledInstalledSkillIds = Set(
            abilities
                .filter { $0.activation == .off }
                .flatMap(\.requiredSkillIDs)
        )
        let starterSkillIds = Set(ProjectInstructionStore.loadStarters().flatMap { starter -> [String] in
            guard let starterAbility = ProjectInstructionStore.loadStarterAbility(starter) else {
                return []
            }
            return starterAbility.requiredSkillIDs
        })
        let existingStarterSkillIds = starterSkillIds
            .subtracting(disabledInstalledSkillIds)
            .intersection(targetSkillIds)
            .sorted()
        guard !existingStarterSkillIds.isEmpty else { return }
        ProjectSkillMaterializer.materialize(
            projectFolderPath: projectFolderPath,
            skillIds: existingStarterSkillIds
        )
    }

    private func existingCanonicalSkillIds(projectRoot: URL) -> Set<String> {
        let skillsDir = projectRoot
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("skills", isDirectory: true)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: skillsDir.path, isDirectory: &isDir),
              isDir.boolValue else { return [] }
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: skillsDir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        return Set(entries.compactMap { url in
            guard url.hasDirectoryPath,
                  FileManager.default.fileExists(
                    atPath: canonicalSkillFileURL(projectRoot: projectRoot, skillId: url.lastPathComponent).path
                  ) else { return nil }
            return url.lastPathComponent
        })
    }

    private func canonicalSkillFileURL(projectRoot: URL, skillId: String) -> URL {
        projectRoot
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("skills", isDirectory: true)
            .appendingPathComponent(skillId, isDirectory: true)
            .appendingPathComponent("SKILL.md", isDirectory: false)
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

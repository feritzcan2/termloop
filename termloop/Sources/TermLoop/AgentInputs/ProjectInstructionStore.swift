// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Truth owner for project-level instruction assets used during run input
/// composition: project abilities (`.termloop/abilities/`), bundled
/// creator/refiner prompts (`AbilityPrompts`), bundled default ability
/// templates, and the skills catalog.
///
/// Design rule (from the agreed plan corrections): truth is **disk- /
/// watcher-backed snapshots**, never an in-memory cache. This is the
/// invariant that the original `AbilityInjector` cache-bypass workaround
/// implied; the store encodes it as the design rather than a workaround.
///
/// Skills lifetime: truth lives here, but the popover-scoped `SkillCatalog`
/// view-model retains its existing per-popover refresh ergonomics.
enum ProjectInstructionStore {

    // MARK: - Abilities

    /// Disk-snapshot of the abilities under `<projectFolderPath>/.termloop/abilities/`.
    /// Returns an empty array when the project folder is unknown or the
    /// abilities directory does not exist.
    static func loadAbilities(projectFolderPath: String?) -> [Ability] {
        AbilityInjector.loadAbilities(projectFolderPath: projectFolderPath)
    }

    /// Resolves the ability snapshot + composed system-prompt for a single
    /// run. Bypasses any in-memory ability cache by going straight to disk.
    @MainActor
    static func snapshot(
        projectFolderPath: String?,
        runCwd: String?
    ) -> ProjectInstructionSnapshot {
        let resolvedFolder = AbilityInjector.resolveProjectFolderPath(
            projectFolderPath: projectFolderPath,
            runCwd: runCwd
        )
        let abilities = loadAbilities(projectFolderPath: resolvedFolder)
        let isWorktree: Bool
        if let runCwd {
            isWorktree = AbilityInjector.computeIsWorktree(
                projectFolder: resolvedFolder,
                runCwd: runCwd
            )
        } else {
            isWorktree = false
        }
        var active: [Ability] = []
        var listed: [Ability] = []
        for ability in abilities {
            switch ability.activation {
            case .always:
                active.append(ability)
            case .worktree:
                if isWorktree { active.append(ability) }
            case .listed:
                listed.append(ability)
            case .off:
                continue
            }
        }
        let referencedSkills = resolveReferencedSkills(
            abilities: active + listed,
            projectFolderPath: resolvedFolder
        )
        let composed = composeAbilityBlock(
            activeAbilities: active,
            listedAbilities: listed,
            isWorktree: isWorktree,
            projectFolderPath: resolvedFolder,
            referencedSkills: referencedSkills
        )
        return ProjectInstructionSnapshot(
            activeAbilities: active,
            listedAbilities: listed,
            allAbilities: abilities,
            referencedSkills: referencedSkills,
            composedAppendSystemPrompt: composed,
            isWorktree: isWorktree
        )
    }

    @MainActor
    static func composeAbilityBlock(
        activeAbilities: [Ability],
        listedAbilities: [Ability],
        isWorktree: Bool,
        projectFolderPath: String?,
        referencedSkills: [SkillEntry] = []
    ) -> String? {
        guard !activeAbilities.isEmpty || !listedAbilities.isEmpty else { return nil }

        // `system-reminder.md` is, by design, always-on guidance. Listed
        // abilities still need their reminder injected — otherwise the agent
        // only sees an on-demand bullet and may never read the file that
        // contains a hard rule like "call `set_jira_ticket` after a state
        // change".
        let referencedSkillNames = Set(referencedSkills.map(\.name))
        let canRelyOnProjectNativeSkills = projectFolderPath?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty == false
        let activeReminders: [(Ability, String)] = activeAbilities.compactMap { ability in
            let trimmed = reminderBody(
                for: ability,
                referencedSkillNames: referencedSkillNames,
                canRelyOnProjectNativeSkills: canRelyOnProjectNativeSkills
            )
            return trimmed.isEmpty ? nil : (ability, trimmed)
        }
        let listedReminders: [(Ability, String)] = listedAbilities.compactMap { ability in
            let trimmed = reminderBody(
                for: ability,
                referencedSkillNames: referencedSkillNames,
                canRelyOnProjectNativeSkills: canRelyOnProjectNativeSkills
            )
            return trimmed.isEmpty ? nil : (ability, trimmed)
        }
        // Bullet listing is only useful for abilities whose system-reminder
        // is empty — otherwise the rule is already injected above and the
        // bullet just repeats the description (and the required-skill name
        // the reminder normally already mentions).
        let onDemandOnly: [Ability] = listedAbilities.filter { ability in
            reminderBody(
                for: ability,
                referencedSkillNames: referencedSkillNames,
                canRelyOnProjectNativeSkills: canRelyOnProjectNativeSkills
            ).isEmpty
        }
        // Drop skills that are already materialized into the agent-native
        // catalog (e.g. `<projectRoot>/.claude/skills/<id>/SKILL.md`). Those
        // are picked up by the agent's own skill discovery; re-listing the
        // file path in the prompt is wasted context. Without a project root
        // we can't probe — keep the section to preserve old behavior.
        let unmaterializedSkills: [SkillEntry] = referencedSkills.filter { skill in
            guard let projectFolderPath, !projectFolderPath.isEmpty else { return true }
            let nativeFile = URL(fileURLWithPath: projectFolderPath, isDirectory: true)
                .appendingPathComponent(".claude", isDirectory: true)
                .appendingPathComponent("skills", isDirectory: true)
                .appendingPathComponent(skill.name, isDirectory: true)
                .appendingPathComponent("SKILL.md")
            return !FileManager.default.fileExists(atPath: nativeFile.path)
        }

        var out = ""
        out += "<system-reminder>\n"

        // Compact form: exactly one ability (active OR listed) contributed an
        // always-on rule and there's nothing else to surface — no active
        // ability without a body to list, no on-demand-only bullets, no
        // unmaterialized skill pointers. Drops the "# Project Abilities"
        // preamble and the section heading entirely; the rule itself is the
        // only content worth keeping.
        let allReminders = activeReminders + listedReminders
        let activeWithoutBody = activeAbilities.count - activeReminders.count
        if allReminders.count == 1,
           activeWithoutBody == 0,
           onDemandOnly.isEmpty,
           unmaterializedSkills.isEmpty,
           let (ability, reminder) = allReminders.first {
            out += "## Project rules — \(ability.name)\n\n"
            out += reminder
            out += "\n</system-reminder>"
            return out
        }

        // Standard form: skip the "# Project Abilities" preamble and the
        // "## Active" wrapper. Each active ability renders as a top-level
        // "## Name" with its rule body — that is the rule, no boilerplate
        // needed to frame it. Listed-on-demand reminders sit under their
        // own labeled section below to mark the difference in scope.
        var hasEmittedSection = false
        let separator = { (out: inout String) in
            if hasEmittedSection { out += "\n" }
            hasEmittedSection = true
        }

        for ability in activeAbilities {
            let reminder = reminderBody(
                for: ability,
                referencedSkillNames: referencedSkillNames,
                canRelyOnProjectNativeSkills: canRelyOnProjectNativeSkills
            )
            separator(&out)
            out += "## \(ability.name)\n"
            if !reminder.isEmpty {
                out += "\n"
                out += reminder
                out += "\n"
            }
        }

        if !listedReminders.isEmpty {
            separator(&out)
            out += "## Always-on rules from on-demand abilities\n"
            for (ability, reminder) in listedReminders {
                out += "\n### \(ability.name)\n"
                out += reminder
                out += "\n"
            }
        }

        if !onDemandOnly.isEmpty {
            separator(&out)
            out += "## Available on-demand\n\n"
            for ability in onDemandOnly {
                if ability.requiredSkillIDs.isEmpty {
                    out += "- **\(ability.name)** — \(ability.description)\n"
                } else {
                    let skills = ability.requiredSkillIDs
                        .map { "`\($0)`" }
                        .joined(separator: ", ")
                    out += "- **\(ability.name)** — \(ability.description) Use required skill(s): \(skills).\n"
                }
            }
        }

        if !unmaterializedSkills.isEmpty {
            separator(&out)
            out += "## Required project skills\n\n"
            out += "The following project skill files are required by active/on-demand abilities. Read them before doing the matching work.\n"
            for skill in unmaterializedSkills {
                let description = skill.description?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                out += "- **\(skill.name)**"
                if !description.isEmpty {
                    out += " — \(description)"
                }
                out += " (file: \(skill.fileURL.path))\n"
            }
        }

        out += "</system-reminder>"
        return out
    }

    private static func reminderBody(
        for ability: Ability,
        referencedSkillNames: Set<String>,
        canRelyOnProjectNativeSkills: Bool
    ) -> String {
        let systemReminder = (ability.systemReminderBody ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !systemReminder.isEmpty { return systemReminder }

        let body = ability.body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return "" }

        // Active legacy/simple abilities still need their body injected. For
        // on-demand abilities backed by native skills, the skill file is the
        // preferred context path; only fall back to the body when a declared
        // required skill is not available.
        if ability.activation == .always || ability.activation == .worktree {
            return body
        }
        if !canRelyOnProjectNativeSkills, !ability.requiredSkillIDs.isEmpty {
            return body
        }
        if !ability.requiredSkillIDs.isEmpty,
           ability.requiredSkillIDs.contains(where: { !referencedSkillNames.contains($0) }) {
            return body
        }
        return ""
    }

    @MainActor
    static func composeAbilityBlock(
        abilities: [Ability],
        isWorktree: Bool
    ) -> String? {
        var active: [Ability] = []
        var listed: [Ability] = []
        for ability in abilities {
            switch ability.activation {
            case .always:
                active.append(ability)
            case .worktree:
                if isWorktree { active.append(ability) }
            case .listed:
                listed.append(ability)
            case .off:
                continue
            }
        }
        return composeAbilityBlock(
            activeAbilities: active,
            listedAbilities: listed,
            isWorktree: isWorktree,
            projectFolderPath: nil,
            referencedSkills: []
        )
    }

    @MainActor
    static func resolvedProjectFolderPath(for workspace: Workspace, runCwd: String?) -> String? {
        AbilityInjector.resolvedProjectFolderPath(for: workspace, runCwd: runCwd)
    }

    @MainActor
    static func resolvedProjectFolderPath(forWorkspaceId workspaceId: UUID, runCwd: String?) -> String? {
        AbilityInjector.resolvedProjectFolderPath(forWorkspaceId: workspaceId, runCwd: runCwd)
    }

    static func resolvedProjectFolderPath(projectFolderPath: String?, runCwd: String?) -> String? {
        AbilityInjector.resolveProjectFolderPath(projectFolderPath: projectFolderPath, runCwd: runCwd)
    }

    // MARK: - Bundled prompts

    /// Loads a bundled markdown asset by name from
    /// `Sources/TermLoop/Core/Templates/`. Single disk-read entry for
    /// bundled prompts / default ability templates; every caller should
    /// route through here rather than hitting the Templates directory
    /// directly.
    static func loadBundledMarkdown(named name: String) -> String {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // AgentInputs/
            .deletingLastPathComponent()  // TermLoop/
            .appendingPathComponent("Core", isDirectory: true)
            .appendingPathComponent("Templates", isDirectory: true)
            .appendingPathComponent(name)
        if let text = try? String(contentsOf: sourceURL, encoding: .utf8), !text.isEmpty {
            return text
        }
        if let bundleURL = Bundle.main.url(forResource: name, withExtension: nil),
           let text = try? String(contentsOf: bundleURL, encoding: .utf8),
           !text.isEmpty {
            return text
        }
        return ""
    }

    enum BundledAbilityPrompt {
        case creator

        var body: String {
            switch self {
            case .creator: return AbilityPrompts.creator
            }
        }
    }

    static func builtInPromptBody(_ kind: BundledAbilityPrompt) -> String {
        kind.body
    }

    @MainActor
    static func bundledPrompt(_ kind: BundledAbilityPrompt) -> String {
        AgentPromptStore.body(id: AgentPromptStore.abilityDocumentID(kind), projectFolderPath: ProjectStore.shared.activeProjectId.flatMap { ProjectStore.shared.project(id: $0)?.folderPath })
            ?? builtInPromptBody(kind)
    }

    // MARK: - Starter discovery

    /// Disk-shipped starter bundles under
    /// `Sources/TermLoop/Core/Templates/starters/<slug>/`. Each is a full
    /// ability bundle (`ability.json` + `system-reminder.md` + `instructions.md`)
    /// that the user can copy into their project via the Abilities panel.
    static func loadStarters() -> [AbilityStarter] { startersCache.starters }

    static func loadStarterAbility(_ starter: AbilityStarter) -> Ability? {
        startersCache.abilities[starter.id]
    }

    private static let startersCache: (starters: [AbilityStarter], abilities: [String: Ability]) = {
        // Source-tree path works in dev (`#filePath` resolves to the developer's
        // checkout). In a packaged/distributed app that path doesn't exist —
        // fall back to a `starters/` folder reference under the main bundle's
        // resources. Until that folder reference is added to Xcode's Copy
        // Bundle Resources phase, the bundle fallback returns no entries
        // (silent — the panel just shows zero starters in production).
        let sourceTreeDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // AgentInputs/
            .deletingLastPathComponent()  // TermLoop/
            .appendingPathComponent("Core", isDirectory: true)
            .appendingPathComponent("Templates", isDirectory: true)
            .appendingPathComponent("starters", isDirectory: true)
        let bundleDir = Bundle.main.url(
            forResource: "starters",
            withExtension: nil,
            subdirectory: "TermLoopStarters"
        ) ?? Bundle.main.url(forResource: "starters", withExtension: nil)
        let candidateDirs = [sourceTreeDir, bundleDir].compactMap { $0 }
        let startersDir = candidateDirs.first(where: {
            FileManager.default.fileExists(atPath: $0.path)
        }) ?? sourceTreeDir
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: startersDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        var starters: [AbilityStarter] = []
        var abilities: [String: Ability] = [:]
        for dir in entries where dir.hasDirectoryPath {
            guard let ability = try? AbilityBundleStore.load(from: dir) else { continue }
            starters.append(
                AbilityStarter(
                    id: ability.id,
                    name: ability.name,
                    description: ability.description,
                    activation: ability.activation,
                    tags: ability.tags,
                    bundleDirectoryURL: dir
                )
            )
            abilities[ability.id] = ability
        }
        starters.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        return (starters, abilities)
    }()

    static func resolveReferencedSkills(
        abilities: [Ability],
        projectFolderPath: String?
    ) -> [SkillEntry] {
        // Hotfix: targeted path probe only. Previously this enumerated every
        // directory under `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`
        // (plus their project-side equivalents) and synchronously read every
        // `SKILL.md` to match by frontmatter `name:`. When any of those skill
        // roots lived under iCloud Drive with "Optimize Mac Storage" enabled,
        // the resulting reads forced `apfs_materialize_dataless_file_ext` on
        // hundreds of files on the main actor — ~24 s hangs and watchdog
        // kills on every launch.
        //
        // Downstream we only consume `.name` (see `previewSummary
        // .referencedSkillNames`). So we probe `<root>/skills/<id>/SKILL.md`
        // for each required id (with `_`/`-` variants) — `fileExists` only,
        // no reads — and synthesize a minimal entry. Frontmatter-name lookup
        // for skills whose folder slug differs from their declared name is
        // intentionally dropped from the launch path.
        let skillIds = Array(Set(abilities.flatMap(\.requiredSkillIDs))).sorted()
        guard !skillIds.isEmpty else { return [] }

        let projectRootURL = projectFolderPath.map {
            URL(fileURLWithPath: $0, isDirectory: true)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser

        return skillIds.compactMap { id in
            probeSkill(id: id, projectRoot: projectRootURL)
                ?? probeSkill(id: id, projectRoot: nil, homeRoot: home)
        }
    }

    private static func probeSkill(
        id: String,
        projectRoot: URL? = nil,
        homeRoot: URL? = nil
    ) -> SkillEntry? {
        let candidates: [String] = {
            var seen = Set<String>()
            return [
                id,
                id.replacingOccurrences(of: "_", with: "-"),
                id.replacingOccurrences(of: "-", with: "_")
            ].filter { seen.insert($0).inserted && !$0.isEmpty }
        }()

        let probeRoots: [(URL, SkillSource)]
        if let projectRoot {
            probeRoots = [
                (projectRoot.appendingPathComponent(".claude", isDirectory: true), .project),
                (projectRoot.appendingPathComponent(".agents", isDirectory: true), .project)
            ]
        } else if let homeRoot {
            probeRoots = [
                (homeRoot.appendingPathComponent(".codex", isDirectory: true), .global),
                (homeRoot.appendingPathComponent(".agents", isDirectory: true), .global),
                (homeRoot.appendingPathComponent(".claude", isDirectory: true), .global)
            ]
        } else {
            return nil
        }

        for (root, source) in probeRoots {
            let skillsDir = root.appendingPathComponent("skills", isDirectory: true)
            for slug in candidates {
                let skillFile = skillsDir
                    .appendingPathComponent(slug, isDirectory: true)
                    .appendingPathComponent("SKILL.md")
                guard FileManager.default.fileExists(atPath: skillFile.path) else { continue }
                let entryId = "\(source):\(SkillKind.skill):\(skillFile.standardizedFileURL.path)"
                return SkillEntry(
                    id: entryId,
                    name: id,
                    displayPath: slug,
                    description: nil,
                    body: "",
                    source: source,
                    kind: .skill,
                    fileURL: skillFile
                )
            }
        }
        return nil
    }
}

/// Best-effort adapter from TermLoop's canonical project-skill location to
/// agent-native project skill folders. The canonical source remains
/// `<project>/.termloop/skills/<id>/`; native folders are a launch-time
/// compatibility layer. TermLoop links their files back to the canonical
/// skill when possible, and only overwrites folders it created.
@MainActor
enum ProjectSkillMaterializer {
    private static let managedMarkerName = ".termloop-managed-skill"

    struct SkillLocation: Identifiable, Equatable {
        let id: String
        let label: String
        let fileURL: URL
        let editURL: URL
        let exists: Bool
        let isCanonical: Bool
        let isManagedCopy: Bool
        let isLinkedCopy: Bool
    }

    static func materializeForLaunch(_ plan: AgentInvocationPlan) {
        let projectFolderPath = resolvedProjectFolderPath(for: plan)
        materialize(
            projectFolderPath: projectFolderPath,
            agentCwdPath: plan.runCwd?.path,
            abilities: plan.instructions.activeAbilities + plan.instructions.listedAbilities
        )
    }

    static func materialize(projectFolderPath: String?, agentCwdPath: String? = nil, abilities: [Ability]) {
        let activeAbilities = abilities.filter { $0.activation != .off }
        let skillIds = Array(Set(activeAbilities.flatMap(\.requiredSkillIDs))).sorted()
        let hintsBySkillId = computeSkillHints(skillIds: skillIds, abilities: activeAbilities)
        materialize(
            projectFolderPath: projectFolderPath,
            agentCwdPath: agentCwdPath,
            skillIds: skillIds,
            hintsBySkillId: hintsBySkillId
        )
        // Sweep TermLoop-managed native skill copies that no longer back any
        // active ability — toggling an ability OFF should remove its skill
        // from the agent's catalog, not leave a stale entry behind.
        sweepManagedSkills(
            projectFolderPath: projectFolderPath,
            agentCwdPath: agentCwdPath,
            keepSkillIds: Set(skillIds)
        )
    }

    static func materialize(
        projectFolderPath: String?,
        agentCwdPath: String? = nil,
        skillIds: [String],
        hintsBySkillId: [String: String] = [:]
    ) {
        guard let projectFolderPath,
              !projectFolderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        let projectRoot = URL(fileURLWithPath: projectFolderPath, isDirectory: true)
        let nativeRoots = nativeSkillRoots(projectRoot: projectRoot, agentCwdPath: agentCwdPath)
        let fm = FileManager.default
        for skillId in skillIds {
            guard let safeId = safeSkillId(skillId) else { continue }
            let sourceDirectory = canonicalSkillDirectory(projectRoot: projectRoot, skillId: safeId)
            let sourceFile = sourceDirectory.appendingPathComponent("SKILL.md")
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: sourceDirectory.path, isDirectory: &isDir),
                  isDir.boolValue,
                  fm.fileExists(atPath: sourceFile.path) else {
                continue
            }
            let hintFooter = hintsBySkillId[skillId]
            for nativeRoot in nativeRoots {
                for destination in nativeSkillDestinations(skillRoot: nativeRoot, skillId: safeId) {
                    switch destination.strategy {
                    case .symlink:
                        linkManagedSkillDirectory(from: sourceDirectory, to: destination.directory)
                    case .copy:
                        copyManagedSkillDirectory(
                            from: sourceDirectory,
                            to: destination.directory,
                            skillFileFooter: hintFooter
                        )
                    }
                }
            }
        }
    }

    static func materialize(projectFolderPath: String?, agentCwdPath: String? = nil, skillId: String) {
        materialize(projectFolderPath: projectFolderPath, agentCwdPath: agentCwdPath, skillIds: [skillId])
    }

    /// Builds per-skill hint footers from the active abilities that require
    /// each skill. Each ability contributes one hint per built-in MCP tool it
    /// has opted into — for example, `working-with-jira` opted into
    /// `set_jira_ticket` produces the "Telemetry: as soon as you parse the
    /// key …" line. Returned text is appended to the materialized SKILL.md so
    /// the agent sees it through native skill discovery without the user
    /// having to keep boilerplate in the canonical file.
    private static func computeSkillHints(skillIds: [String], abilities: [Ability]) -> [String: String] {
        let wantedIds = Set(skillIds)
        var hintsBySkill: [String: [String]] = [:]
        for ability in abilities {
            let toolHints = ability.enabledMCPToolNames.compactMap {
                TermLoopBuiltInMCP.systemPromptHint(toolName: $0)
            }
            guard !toolHints.isEmpty else { continue }
            for skillId in ability.requiredSkillIDs where wantedIds.contains(skillId) {
                hintsBySkill[skillId, default: []].append(contentsOf: toolHints)
            }
        }
        var result: [String: String] = [:]
        for (skillId, hints) in hintsBySkill {
            let body = hints.map { "- \($0)" }.joined(separator: "\n")
            result[skillId] = "\n\n## TermLoop telemetry\n\n\(body)\n"
        }
        return result
    }

    static func skillLocations(projectFolderPath: String?, skillId: String) -> [SkillLocation] {
        guard let projectFolderPath,
              !projectFolderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let safeId = safeSkillId(skillId) else {
            return []
        }
        let projectRoot = URL(fileURLWithPath: projectFolderPath, isDirectory: true)
        let canonical = canonicalSkillDirectory(projectRoot: projectRoot, skillId: safeId)
        var locations: [SkillLocation] = [
            skillLocation(
                label: "Project canonical",
                directory: canonical,
                isCanonical: true
            )
        ]

        for destination in nativeSkillDestinations(skillRoot: projectRoot, skillId: safeId) {
            locations.append(skillLocation(label: destination.label, directory: destination.directory, isCanonical: false))
        }
        return locations
    }

    static func adoptSkillToProject(
        projectFolderPath: String?,
        skillId: String,
        sourceSkillFile: URL
    ) throws {
        guard let projectFolderPath,
              !projectFolderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let safeId = safeSkillId(skillId) else {
            throw NSError(
                domain: "ProjectSkillMaterializer",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Missing project folder or invalid skill id."]
            )
        }

        let fm = FileManager.default
        let projectRoot = URL(fileURLWithPath: projectFolderPath, isDirectory: true)
        let destination = canonicalSkillDirectory(projectRoot: projectRoot, skillId: safeId)
        let destinationSkillFile = destination.appendingPathComponent("SKILL.md")
        if fm.fileExists(atPath: destinationSkillFile.path) {
            materialize(projectFolderPath: projectFolderPath, skillIds: [safeId])
            return
        }

        let sourceDirectory = sourceSkillFile.deletingLastPathComponent()
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: sourceDirectory.path, isDirectory: &isDir),
              isDir.boolValue,
              fm.fileExists(atPath: sourceSkillFile.path) else {
            throw NSError(
                domain: "ProjectSkillMaterializer",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Source skill file was not found."]
            )
        }

        if sourceDirectory.standardizedFileURL.path == destination.standardizedFileURL.path {
            materialize(projectFolderPath: projectFolderPath, skillIds: [safeId])
            return
        }

        if fm.fileExists(atPath: destination.path) {
            throw NSError(
                domain: "ProjectSkillMaterializer",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Project skill directory already exists without SKILL.md."]
            )
        }

        try fm.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        do {
            try fm.copyItem(at: sourceDirectory, to: destination)
        } catch {
            try? fm.removeItem(at: destination)
            throw error
        }
        try? fm.removeItem(at: destination.appendingPathComponent(managedMarkerName))
        materialize(projectFolderPath: projectFolderPath, skillIds: [safeId])
    }

    private static func resolvedProjectFolderPath(for plan: AgentInvocationPlan) -> String? {
        if let projectId = plan.projectId,
           let project = ProjectStore.shared.project(id: projectId) {
            return project.folderPath
        }
        return ProjectInstructionStore.resolvedProjectFolderPath(
            projectFolderPath: plan.repoRootPath,
            runCwd: plan.runCwd?.path
        )
    }

    private static func canonicalSkillDirectory(projectRoot: URL, skillId: String) -> URL {
        projectRoot
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("skills", isDirectory: true)
            .appendingPathComponent(skillId, isDirectory: true)
    }

    private enum NativeMaterializationStrategy {
        case symlink
        case copy
    }

    private struct NativeSkillDestination {
        let label: String
        let directory: URL
        let strategy: NativeMaterializationStrategy
    }

    private static func nativeSkillRoots(projectRoot: URL, agentCwdPath: String?) -> [URL] {
        // Always include the owning project root. Optionally add the agent's
        // actual cwd, but only when it is a real directory under the project's
        // worktree convention — otherwise a stray runCwd could materialize
        // `.claude/.codex/.agents` trees in unrelated locations.
        var roots: [URL] = [projectRoot]
        guard let agentCwdPath,
              !agentCwdPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return roots
        }
        let agentCwd = URL(fileURLWithPath: agentCwdPath, isDirectory: true)
            .resolvingSymlinksInPath()
        let projectStd = projectRoot.resolvingSymlinksInPath()
            .standardizedFileURL.path
        let cwdStd = agentCwd.standardizedFileURL.path
        guard projectStd != cwdStd else { return roots }
        guard WorktreeResolver.worktreeRoot(
            containing: cwdStd,
            projectFolder: projectStd
        ) != nil else { return roots }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: cwdStd, isDirectory: &isDir),
              isDir.boolValue else { return roots }
        roots.append(agentCwd)
        return roots
    }

    private static func nativeSkillDestinations(skillRoot: URL, skillId: String) -> [NativeSkillDestination] {
        // All three are real managed copies (not symlinks). Necessary so the
        // materializer can append per-ability tool-hint footers (e.g. the Jira
        // telemetry "call set_jira_ticket as soon as you parse the key" line)
        // to the SKILL.md the agent actually reads. Canonical
        // `.termloop/skills/<id>/SKILL.md` stays untouched as the user-edit
        // surface; copies refresh on every materialize.
        [
            NativeSkillDestination(
                label: "Claude native",
                directory: skillRoot
                    .appendingPathComponent(".claude", isDirectory: true)
                    .appendingPathComponent("skills", isDirectory: true)
                    .appendingPathComponent(skillId, isDirectory: true),
                strategy: .copy
            ),
            NativeSkillDestination(
                label: "Codex native",
                directory: skillRoot
                    .appendingPathComponent(".codex", isDirectory: true)
                    .appendingPathComponent("skills", isDirectory: true)
                    .appendingPathComponent(skillId, isDirectory: true),
                strategy: .copy
            ),
            NativeSkillDestination(
                label: "Agents native",
                directory: skillRoot
                    .appendingPathComponent(".agents", isDirectory: true)
                    .appendingPathComponent("skills", isDirectory: true)
                    .appendingPathComponent(skillId, isDirectory: true),
                strategy: .copy
            )
        ]
    }

    private static func skillLocation(
        label: String,
        directory: URL,
        isCanonical: Bool
    ) -> SkillLocation {
        let skillFile = directory.appendingPathComponent("SKILL.md")
        let marker = directory.appendingPathComponent(managedMarkerName)
        let fm = FileManager.default
        let linked = (try? fm.destinationOfSymbolicLink(atPath: skillFile.path)) != nil
        let resolvedDirectory = directory.resolvingSymlinksInPath()
        let canonicalFile = canonicalSkillDirectory(
            projectRoot: resolvedDirectory
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent(),
            skillId: resolvedDirectory.lastPathComponent
        ).appendingPathComponent("SKILL.md")
        return SkillLocation(
            id: "\(label):\(skillFile.path)",
            label: label,
            fileURL: skillFile,
            editURL: isCanonical || linked ? skillFile.resolvingSymlinksInPath() : canonicalFile,
            exists: fm.fileExists(atPath: skillFile.path),
            isCanonical: isCanonical,
            isManagedCopy: !isCanonical && fm.fileExists(atPath: marker.path),
            isLinkedCopy: !isCanonical && linked
        )
    }

    private static func linkManagedSkillDirectory(from source: URL, to destination: URL) {
        let fm = FileManager.default
        let marker = destination.appendingPathComponent(managedMarkerName)
        if fm.fileExists(atPath: destination.path) {
            guard fm.fileExists(atPath: marker.path) else {
                return
            }
            // Idempotency check: if every existing child symlink already points
            // at the right canonical file, leave the directory alone. Avoids
            // briefly removing an active skill on unrelated ability reloads —
            // external agents reading the catalog won't see a half-built dir.
            if managedSymlinksAlreadyPoint(from: source, to: destination) {
                return
            }
            try? fm.removeItem(at: destination)
        }
        do {
            try fm.createDirectory(at: destination, withIntermediateDirectories: true)
            let sourceChildren = try fm.contentsOfDirectory(
                at: source,
                includingPropertiesForKeys: nil,
                options: []
            )
            for child in sourceChildren where child.lastPathComponent != managedMarkerName {
                let linkedChild = destination.appendingPathComponent(child.lastPathComponent)
                let target = relativePath(fromDirectory: destination, to: child)
                try fm.createSymbolicLink(atPath: linkedChild.path, withDestinationPath: target)
            }
            let markerBody = "Managed by TermLoop. Symlinked to the canonical .termloop skill. Edit the canonical skill instead.\n"
            try markerBody.write(to: marker, atomically: true, encoding: .utf8)
        } catch {
            try? fm.removeItem(at: destination)
            copyManagedSkillDirectory(from: source, to: destination)
        }
    }

    private static func copyManagedSkillDirectory(
        from source: URL,
        to destination: URL,
        skillFileFooter: String? = nil
    ) {
        let fm = FileManager.default
        let marker = destination.appendingPathComponent(managedMarkerName)
        if fm.fileExists(atPath: destination.path) {
            guard fm.fileExists(atPath: marker.path) else {
                return
            }
            // Idempotency check via mtime: skip rewrite if every kept entry is
            // at least as new as the canonical source. Cheap heuristic; misses
            // mid-second edits but avoids constant churn under reload bursts.
            // Footer changes still need a rewrite, but tool-hint text rarely
            // mutates between launches so the heuristic stays useful.
            if managedCopyAlreadyFresh(from: source, destination: destination) {
                return
            }
            try? fm.removeItem(at: destination)
        }
        do {
            try fm.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try fm.copyItem(at: source, to: destination)
            if let skillFileFooter, !skillFileFooter.isEmpty {
                appendFooterToSkillFile(in: destination, footer: skillFileFooter)
            }
            let markerBody = "Managed by TermLoop. Refreshed from the canonical .termloop skill on launch/sync. Edit the canonical skill instead.\n"
            try markerBody.write(to: marker, atomically: true, encoding: .utf8)
        } catch {
            try? fm.removeItem(at: destination)
            // Native skill materialization is an optimization; the prompt still
            // points at the canonical `.termloop/skills` path on failure.
            return
        }
    }

    /// Appends an TermLoop-managed footer to the SKILL.md inside the freshly
    /// copied native catalog. Best-effort: if the file is missing or write
    /// fails, the agent still has the canonical content above. Keeps the
    /// footer out of the canonical file so the user-edit surface stays clean.
    private static func appendFooterToSkillFile(in directory: URL, footer: String) {
        let skillFile = directory.appendingPathComponent("SKILL.md")
        guard let existing = try? String(contentsOf: skillFile, encoding: .utf8) else { return }
        let trimmed = existing.hasSuffix("\n") ? existing : existing + "\n"
        let combined = trimmed + footer
        try? combined.write(to: skillFile, atomically: true, encoding: .utf8)
    }

    private static func managedSymlinksAlreadyPoint(from source: URL, to destination: URL) -> Bool {
        let fm = FileManager.default
        guard let sourceChildren = try? fm.contentsOfDirectory(
            at: source,
            includingPropertiesForKeys: nil,
            options: []
        ) else {
            return false
        }
        for child in sourceChildren where child.lastPathComponent != managedMarkerName {
            let linkedChild = destination.appendingPathComponent(child.lastPathComponent)
            guard let actualTarget = try? fm.destinationOfSymbolicLink(atPath: linkedChild.path) else {
                return false
            }
            let expectedTarget = relativePath(fromDirectory: destination, to: child)
            if actualTarget != expectedTarget { return false }
        }
        return true
    }

    private static func managedCopyAlreadyFresh(from source: URL, destination: URL) -> Bool {
        let fm = FileManager.default
        guard let sourceChildren = try? fm.contentsOfDirectory(
            at: source,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: []
        ) else {
            return false
        }
        for child in sourceChildren where child.lastPathComponent != managedMarkerName {
            let copiedChild = destination.appendingPathComponent(child.lastPathComponent)
            guard fm.fileExists(atPath: copiedChild.path),
                  let sourceMtime = (try? child.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate,
                  let copyMtime = (try? copiedChild.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate,
                  copyMtime >= sourceMtime else {
                return false
            }
        }
        return true
    }

    private static func sweepManagedSkills(
        projectFolderPath: String?,
        agentCwdPath: String?,
        keepSkillIds: Set<String>
    ) {
        guard let projectFolderPath,
              !projectFolderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        let projectRoot = URL(fileURLWithPath: projectFolderPath, isDirectory: true)
        let nativeRoots = nativeSkillRoots(projectRoot: projectRoot, agentCwdPath: agentCwdPath)
        let fm = FileManager.default
        for root in nativeRoots {
            for skillsDir in nativeSkillCatalogDirectories(skillRoot: root) {
                guard let entries = try? fm.contentsOfDirectory(
                    at: skillsDir,
                    includingPropertiesForKeys: nil,
                    options: [.skipsHiddenFiles]
                ) else { continue }
                for entry in entries where entry.hasDirectoryPath {
                    let marker = entry.appendingPathComponent(managedMarkerName)
                    guard fm.fileExists(atPath: marker.path) else { continue }
                    if keepSkillIds.contains(entry.lastPathComponent) { continue }
                    try? fm.removeItem(at: entry)
                }
            }
        }
    }

    private static func nativeSkillCatalogDirectories(skillRoot: URL) -> [URL] {
        [".claude", ".codex", ".agents"].map {
            skillRoot
                .appendingPathComponent($0, isDirectory: true)
                .appendingPathComponent("skills", isDirectory: true)
        }
    }

    private static func relativePath(fromDirectory directory: URL, to target: URL) -> String {
        let fromComponents = directory.resolvingSymlinksInPath().standardizedFileURL.pathComponents
        let toComponents = target.resolvingSymlinksInPath().standardizedFileURL.pathComponents
        var common = 0
        while common < fromComponents.count,
              common < toComponents.count,
              fromComponents[common] == toComponents[common] {
            common += 1
        }
        let upward = Array(repeating: "..", count: fromComponents.count - common)
        let downward = Array(toComponents.dropFirst(common))
        let parts = upward + downward
        return parts.isEmpty ? "." : parts.joined(separator: "/")
    }

    private static func safeSkillId(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.contains("/"),
              !trimmed.contains("\\"),
              trimmed != ".",
              trimmed != "..",
              trimmed.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil else {
            return nil
        }
        return trimmed
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct AgentInstructionPart: Identifiable, Equatable {
    enum Kind: Hashable {
        case firstMessage
        case userSystemPrompt
        case abilityPayloadBlock(abilityId: String, blockId: String, mcpToolName: String?)
        case onDemandAbilityList
        case skillReferenceList
        case worktreeContext
        case reportedContext

        var id: String {
            switch self {
            case .firstMessage:
                return "first-message"
            case .userSystemPrompt:
                return "user-system-prompt"
            case .abilityPayloadBlock(let abilityId, let blockId, _):
                return "ability-payload-block:\(abilityId):\(blockId)"
            case .onDemandAbilityList:
                return "on-demand-ability-list"
            case .skillReferenceList:
                return "skill-reference-list"
            case .worktreeContext:
                return "worktree-context"
            case .reportedContext:
                return "reported-context"
            }
        }

        var generatedOverrideKind: InstructionRunOverrides.GeneratedPartKind? {
            switch self {
            case .abilityPayloadBlock(let abilityId, _, let toolName):
                guard let toolName else { return nil }
                return .toolLinkedPayload(abilityId: abilityId, toolName: toolName)
            case .worktreeContext:
                return .worktreeContext
            case .reportedContext:
                return .reportedContext
            default:
                return nil
            }
        }

        var abilityRunOverrideId: String? {
            switch self {
            case .abilityPayloadBlock(let abilityId, _, _):
                return abilityId
            default:
                return nil
            }
        }
    }

    enum Source: Equatable {
        case file(URL)
        case generated(String)
        case runtime(String)
        case userInput

        var label: String {
            switch self {
            case .file(let url):
                return url.path
            case .generated(let generator):
                return generator
            case .runtime(let store):
                return store
            case .userInput:
                return "Quick Action input"
            }
        }

        var kindLabel: String {
            switch self {
            case .file:
                return "file"
            case .generated:
                return "generated"
            case .runtime:
                return "runtime"
            case .userInput:
                return "user"
            }
        }
    }

    enum Editability: Equatable {
        case openFile(URL)
        case alreadyEditable(String)
        case sourceToggle(String)
        case notEditable(String)

        var actionLabel: String? {
            switch self {
            case .openFile:
                return "Open source"
            case .alreadyEditable:
                return nil
            case .sourceToggle:
                return nil
            case .notEditable:
                return nil
            }
        }

        var detail: String {
            switch self {
            case .openFile:
                return "File-backed"
            case .alreadyEditable(let detail),
                 .sourceToggle(let detail),
                 .notEditable(let detail):
                return detail
            }
        }
    }

    enum Scope: String, Equatable {
        case project
        case workspace
        case run
    }

    let kind: Kind
    let title: String
    let body: String
    let source: Source
    let editability: Editability
    let enabled: Bool
    let disableReason: String?
    let scope: Scope

    var id: String { kind.id }
}

/// Pure selectors / preview helpers that read a composed
/// `AgentInvocationPlan` and project it into UI-friendly slices. No state
/// ownership and no recomposition: if the plan is wrong, queries are wrong
/// — the fix is in the composer, not here.
///
/// Cross-cutting on purpose: queries operate on the plan (single object),
/// not per-store. The plan already aggregates catalog + template +
/// instruction snapshots.
enum AgentInputQueries {
    // MARK: - Instruction parts

    static func instructionParts(from plan: AgentInvocationPlan) -> [AgentInstructionPart] {
        var parts: [AgentInstructionPart] = []

        appendPart(
            to: &parts,
            kind: .firstMessage,
            title: "First message",
            body: plan.resolvedPromptBody,
            source: .userInput,
            editability: .alreadyEditable("Edit in the main composer."),
            scope: .run
        )
        appendPart(
            to: &parts,
            kind: .userSystemPrompt,
            title: "System instructions",
            body: plan.resolvedUserSystemPrompt,
            source: .userInput,
            editability: .alreadyEditable("Edit in Advanced system instructions."),
            scope: .run
        )

        let abilityProjectionProjectFolderPath = plan.repoRootPath
            ?? inferredProjectFolderPath(
                from: plan.instructions.activeAbilities + plan.instructions.listedAbilities
            )
        appendAbilityInstructionParts(
            to: &parts,
            activeAbilities: plan.instructions.activeAbilities,
            listedAbilities: plan.instructions.listedAbilities,
            referencedSkills: plan.instructions.referencedSkills,
            projectFolderPath: abilityProjectionProjectFolderPath,
            disabledGenerated: plan.instructions.disabledGeneratedParts
        )

        let disabledGenerated = plan.instructions.disabledGeneratedParts
        let worktreeContextDisabled = disabledGenerated.contains(.worktreeContext)
        appendPart(
            to: &parts,
            kind: .worktreeContext,
            title: "Worktree context",
            body: plan.worktreeContextBlock,
            source: .generated("WorktreeContextBlock"),
            editability: .sourceToggle("Generated from this run's cwd and branch."),
            scope: .workspace,
            enabled: !worktreeContextDisabled,
            disableReason: worktreeContextDisabled ? "Disabled for this run." : nil
        )
        let reportedContextDisabled = disabledGenerated.contains(.reportedContext)
        appendPart(
            to: &parts,
            kind: .reportedContext,
            title: "Run target context",
            body: plan.reportedContextBlock,
            source: .runtime("RunTargetStore"),
            editability: .sourceToggle("Reported by the running-your-application MCP tools."),
            scope: .workspace,
            enabled: !reportedContextDisabled,
            disableReason: reportedContextDisabled ? "Disabled for this run." : nil
        )

        return parts
    }

    static func contextInstructionParts(from plan: AgentInvocationPlan) -> [AgentInstructionPart] {
        instructionParts(from: plan).filter { part in
            switch part.kind {
            case .firstMessage, .userSystemPrompt:
                return false
            default:
                return true
            }
        }
    }

    static func abilityInstructionParts(
        for ability: Ability,
        projectFolderPath: String?
    ) -> [AgentInstructionPart] {
        var parts: [AgentInstructionPart] = []
        let active: [Ability]
        let listed: [Ability]
        switch ability.activation {
        case .always, .worktree:
            active = [ability]
            listed = []
        case .listed:
            active = []
            listed = [ability]
        case .off:
            active = []
            listed = []
        }
        let referencedSkills = ProjectInstructionStore.resolveReferencedSkills(
            abilities: [ability],
            projectFolderPath: projectFolderPath
        )
        appendAbilityInstructionParts(
            to: &parts,
            activeAbilities: active,
            listedAbilities: listed,
            referencedSkills: referencedSkills,
            projectFolderPath: projectFolderPath,
            disabledGenerated: []
        )
        return parts
    }

    private static func appendAbilityInstructionParts(
        to parts: inout [AgentInstructionPart],
        activeAbilities: [Ability],
        listedAbilities: [Ability],
        referencedSkills: [SkillEntry],
        projectFolderPath: String?,
        disabledGenerated: Set<InstructionRunOverrides.GeneratedPartKind>
    ) {
        let resolvedProjectFolderPath = projectFolderPath
            ?? inferredProjectFolderPath(from: activeAbilities + listedAbilities)
        let listedProjections = listedAbilities.map {
            ($0, payloadProjection(
                for: $0,
                disabledGenerated: disabledGenerated
            ))
        }

        for ability in activeAbilities {
            appendAbilityReminderParts(
                to: &parts,
                ability: ability,
                titlePrefix: "",
                disabledGenerated: disabledGenerated
            )
        }

        let listedWithRules = listedProjections.filter { pair in
            let (ability, projection) = pair
            return !projection.isEmpty
                || hasPayloadBlocks(for: ability)
        }
        for (ability, _) in listedWithRules {
            appendAbilityReminderParts(
                to: &parts,
                ability: ability,
                titlePrefix: "On-demand rule: ",
                disabledGenerated: disabledGenerated
            )
        }

        let onDemandOnly = listedProjections
            .filter { $0.1.isEmpty && !hasPayloadBlocks(for: $0.0) }
            .map { $0.0 }
        appendOnDemandListPart(to: &parts, abilities: onDemandOnly)

        let unmaterializedSkills = ProjectInstructionStore.unmaterializedSkillsForPrompt(
            referencedSkills: referencedSkills,
            projectFolderPath: resolvedProjectFolderPath
        )
        appendSkillReferencePart(to: &parts, skills: unmaterializedSkills)
    }

    private static func inferredProjectFolderPath(from abilities: [Ability]) -> String? {
        for ability in abilities {
            if let projectFolder = inferredProjectFolderPath(from: ability.metadataFilePath) {
                return projectFolder
            }
        }
        return nil
    }

    private static func inferredProjectFolderPath(from fileURL: URL) -> String? {
        let path = fileURL.standardizedFileURL.path
        guard let range = path.range(of: "/.termloop/abilities/") else { return nil }
        let projectFolder = String(path[..<range.lowerBound])
        return projectFolder.isEmpty ? "/" : projectFolder
    }

    private static func appendAbilityReminderParts(
        to parts: inout [AgentInstructionPart],
        ability: Ability,
        titlePrefix: String,
        disabledGenerated: Set<InstructionRunOverrides.GeneratedPartKind>
    ) {
        for block in ability.payloadBlocks where block.enabled && !block.trimmedBody.isEmpty {
            let overrideKind = block.mcpToolName.map {
                InstructionRunOverrides.GeneratedPartKind.toolLinkedPayload(
                    abilityId: ability.id,
                    toolName: $0
                )
            }
            let isDisabled = overrideKind.map { disabledGenerated.contains($0) } ?? false
            appendPart(
                to: &parts,
                kind: .abilityPayloadBlock(
                    abilityId: ability.id,
                    blockId: block.id,
                    mcpToolName: block.mcpToolName
                ),
                title: "\(titlePrefix)\(block.title)",
                body: block.body,
                source: .file(block.fileURL),
                editability: .openFile(block.fileURL),
                scope: .project,
                enabled: !isDisabled,
                disableReason: isDisabled ? "Disabled for this run." : nil
            )
        }
    }

    private static func hasPayloadBlocks(for ability: Ability) -> Bool {
        ability.payloadBlocks.contains { $0.enabled && !$0.trimmedBody.isEmpty }
    }

    private static func appendOnDemandListPart(
        to parts: inout [AgentInstructionPart],
        abilities: [Ability]
    ) {
        guard !abilities.isEmpty else { return }
        let body = abilities.map { ability -> String in
            if ability.requiredSkillIDs.isEmpty {
                return "- **\(ability.name)** — \(ability.description)"
            }
            let skills = ability.requiredSkillIDs
                .map { "`\($0)`" }
                .joined(separator: ", ")
            return "- **\(ability.name)** — \(ability.description) Use required skill(s): \(skills)."
        }.joined(separator: "\n")
        parts.append(
            AgentInstructionPart(
                kind: .onDemandAbilityList,
                title: "Available on-demand abilities",
                body: body,
                source: .generated("ProjectInstructionStore listed abilities"),
                editability: .notEditable("Toggle the ability's activation in the Abilities panel."),
                enabled: true,
                disableReason: nil,
                scope: .project
            )
        )
    }

    private static func appendSkillReferencePart(
        to parts: inout [AgentInstructionPart],
        skills: [SkillEntry]
    ) {
        guard !skills.isEmpty else { return }
        var lines = [
            "The following project skill files are required by active/on-demand abilities. Read them before doing the matching work."
        ]
        lines += skills.map { skill in
            let description = skill.description?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var line = "- **\(skill.name)**"
            if !description.isEmpty {
                line += " — \(description)"
            }
            line += " (file: \(skill.fileURL.path))"
            return line
        }
        parts.append(
            AgentInstructionPart(
                kind: .skillReferenceList,
                title: "Required project skills",
                body: lines.joined(separator: "\n"),
                source: .generated("ProjectInstructionStore skill references"),
                editability: .notEditable("Skill files are opened from the ability detail."),
                enabled: true,
                disableReason: nil,
                scope: .project
            )
        )
    }

    private static func payloadProjection(
        for ability: Ability,
        disabledGenerated: Set<InstructionRunOverrides.GeneratedPartKind>
    ) -> ProjectInstructionStore.AbilityPayloadProjection {
        ProjectInstructionStore.abilityPayloadProjection(
            for: ability,
            disabledGenerated: disabledGenerated
        )
    }

    private static func appendPart(
        to parts: inout [AgentInstructionPart],
        kind: AgentInstructionPart.Kind,
        title: String,
        body: String?,
        source: AgentInstructionPart.Source,
        editability: AgentInstructionPart.Editability,
        scope: AgentInstructionPart.Scope,
        enabled: Bool = true,
        disableReason: String? = nil
    ) {
        let body = body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !body.isEmpty || !enabled else { return }
        parts.append(
            AgentInstructionPart(
                kind: kind,
                title: title,
                body: body,
                source: source,
                editability: editability,
                enabled: enabled,
                disableReason: disableReason,
                scope: scope
            )
        )
    }

    // MARK: - Abilities

    static func injectedAbilityNames(_ plan: AgentInvocationPlan) -> [String] {
        plan.previewSummary.injectedAbilityNames
    }

    static func listedAbilityNames(_ plan: AgentInvocationPlan) -> [String] {
        plan.previewSummary.listedAbilityNames
    }

    static func hasInjectedAbilities(_ plan: AgentInvocationPlan) -> Bool {
        !plan.previewSummary.injectedAbilityNames.isEmpty
    }

    // MARK: - Skills

    static func referencedSkillNames(_ plan: AgentInvocationPlan) -> [String] {
        plan.previewSummary.referencedSkillNames
    }

    // MARK: - Display

    /// Title shown in run rows / chips. Already resolved by the composer
    /// (template name, free-prompt snippet, or agent display name).
    static func displayTitle(_ plan: AgentInvocationPlan) -> String {
        plan.previewSummary.title
    }

    static func promptSnippet(_ plan: AgentInvocationPlan) -> String? {
        plan.previewSummary.snippet
    }

    /// Compact chip-row label for the resolved model. Hidden when the plan
    /// resolves to `.default` (no point cluttering rows with a no-op).
    static func modelBadge(_ plan: AgentInvocationPlan) -> String? {
        guard plan.resolvedModel != .default else { return nil }
        return plan.resolvedModel.displayLabel
    }

    static func permissionBadge(_ plan: AgentInvocationPlan) -> String? {
        switch plan.resolvedPermission {
        case .none: return nil
        case .auto, .bypassPermissions: return "bypass"
        case .ask, .default: return "default"
        case .acceptEdits: return "accept-edits"
        case .dontAsk: return "dont-ask"
        case .plan: return "plan"
        }
    }

    static func reasoningBadge(_ plan: AgentInvocationPlan) -> String? {
        switch plan.resolvedReasoning {
        case .none, .some(.default):
            return nil
        case .some(let effort):
            return effort.rawValue
        }
    }

    // MARK: - Source

    /// Whether this run originated from the quick-action free-prompt row
    /// (used by row renderers to choose snippet-vs-name display).
    static func isFreePrompt(_ plan: AgentInvocationPlan) -> Bool {
        plan.source == .quickActionFreePrompt || plan.reasonTag == "quickAction.freePrompt"
    }

    /// True when the run is part of a bridge helper kickoff or ask-agent
    /// invocation (used to suppress noisy turn-1 chrome).
    static func isBridgeHelperLaunch(_ plan: AgentInvocationPlan) -> Bool {
        switch plan.source {
        case .bridgeKickoff, .askAgent: return true
        default: return false
        }
    }
}

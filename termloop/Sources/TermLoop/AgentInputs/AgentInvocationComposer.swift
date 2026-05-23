// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Single public entry that turns an `AgentInvocationRequest` (caller intent)
/// into an `AgentInvocationPlan` (semantic launch payload). The pipeline is
/// split into internal step helpers so each concern is independently
/// testable, but callers see exactly one method: `compose(_:overrides:)`.
///
/// Transport-agnostic by design. The composer never builds argv, never
/// chooses tempfile vs flag vs prompt-prefix. That belongs to
/// `AgentInvocationTransportAdapter` (Phase 3.5).
@MainActor
enum AgentInvocationComposer {

    enum CompositionError: Error, LocalizedError {
        case templateNotFound(String)
        case agentNotFound(String)
        case noResolvableAgent
        case promptDocumentNotFound(String)
        case promptDocumentKindMismatch(id: String, expected: String, actual: AgentPromptDocument.Kind)
        case variableSubstitutionFailed(Error)

        var errorDescription: String? {
            switch self {
            case .templateNotFound(let id):
                return "Template not found: \(id)"
            case .agentNotFound(let id):
                return "Terminal agent not found: \(id)"
            case .noResolvableAgent:
                return "No terminal agent available."
            case .promptDocumentNotFound(let id):
                return "Prompt document not found: \(id)"
            case .promptDocumentKindMismatch(let id, let expected, let actual):
                return "Prompt document '\(id)' cannot back \(expected) (kind: \(actual.rawValue))."
            case .variableSubstitutionFailed(let err):
                return "Variable substitution failed: \(err.localizedDescription)"
            }
        }
    }

    static func compose(
        _ request: AgentInvocationRequest,
        overrides: InstructionRunOverrides = .none
    ) throws -> AgentInvocationPlan {
        let template = try resolveTemplate(request)
        let agent = try resolveAgent(request, template: template)
        let model = AgentCatalogStore.shared.resolveModel(request.modelOverride ?? template?.model, for: agent.id)
        let reasoning = AgentCatalogStore.shared.resolveReasoning(request.reasoningOverride ?? template?.reasoning, for: agent.id)
        let permission = resolvePermission(request, template: template)
        let projectFolderPath = projectFolderPath(for: request)
        let baseInstructions = ProjectInstructionStore.snapshot(
            projectFolderPath: projectFolderPath,
            runCwd: request.runCwd?.path
        )
        let instructions = instructionSnapshot(
            baseInstructions,
            overrides: overrides,
            projectFolderPath: projectFolderPath
        )
        let prompt = try resolvePromptBody(
            request,
            template: template,
            projectFolderPath: projectFolderPath
        )
        let userSystemPrompt = try buildUserSystemPrompt(
            request: request,
            template: template,
            projectFolderPath: projectFolderPath
        )
        let reportedContextBlock = overrides.disabledGenerated.contains(.reportedContext)
            ? nil
            : RunTargetContextSnapshotBuilder.composeBlock(
                RunTargetContextSnapshotBuilder.build(
                    workspaceId: request.workspaceId,
                    projectId: request.projectId,
                    runCwd: request.runCwd
                )
            )
        let worktreeContextBlock = overrides.disabledGenerated.contains(.worktreeContext)
            ? nil
            : WorktreeContextBlock.compose(
                isWorktree: instructions.isWorktree,
                branchName: request.branchName,
                runCwd: request.runCwd
            )
        let systemInstructions = joinSystemInstructions(
            userSystemPrompt,
            instructions.composedAppendSystemPrompt,
            worktreeContextBlock,
            reportedContextBlock
        )
        let preview = buildPreviewSummary(
            request: request,
            template: template,
            agent: agent,
            resolvedPrompt: prompt,
            instructions: instructions
        )
        return AgentInvocationPlan(
            agentId: agent.id,
            resolvedModel: model,
            resolvedReasoning: reasoning,
            resolvedPermission: permission,
            template: template,
            resolvedPromptBody: prompt,
            resolvedUserSystemPrompt: userSystemPrompt,
            resolvedSystemInstructions: systemInstructions,
            reportedContextBlock: reportedContextBlock,
            worktreeContextBlock: worktreeContextBlock,
            instructions: instructions,
            runCwd: request.runCwd,
            workspaceId: request.workspaceId,
            projectId: request.projectId,
            branchName: request.branchName,
            repoRootPath: request.repoRootPath,
            source: request.source,
            reasonTag: request.reasonTag,
            previewSummary: preview
        )
    }

    private static func instructionSnapshot(
        _ base: ProjectInstructionSnapshot,
        overrides: InstructionRunOverrides,
        projectFolderPath: String?
    ) -> ProjectInstructionSnapshot {
        guard !overrides.isEmpty else { return base }
        let (active, listed) = InstructionRunOverrides.applyToBasePartition(
            active: base.activeAbilities,
            listed: base.listedAbilities,
            overrides: overrides
        )
        let referencedSkills = ProjectInstructionStore.resolveReferencedSkills(
            abilities: active + listed,
            projectFolderPath: projectFolderPath
        )
        let composed: String? = (active.isEmpty && listed.isEmpty)
            ? nil
            : ProjectInstructionStore.composeAbilityBlock(
                activeAbilities: active,
                listedAbilities: listed,
                isWorktree: base.isWorktree,
                projectFolderPath: projectFolderPath,
                referencedSkills: referencedSkills,
                disabledGenerated: overrides.disabledGenerated
            )
        return ProjectInstructionSnapshot(
            activeAbilities: active,
            listedAbilities: listed,
            allAbilities: base.allAbilities,
            referencedSkills: referencedSkills,
            composedAppendSystemPrompt: composed,
            disabledGeneratedParts: overrides.disabledGenerated,
            hasRunOverrides: !overrides.isEmpty,
            isWorktree: base.isWorktree
        )
    }

    // MARK: - Step: template

    private static func resolveTemplate(_ request: AgentInvocationRequest) throws -> AgentTemplate? {
        guard let id = request.templateId else { return nil }
        guard let tpl = AgentTemplateStore.shared.template(id: id) else {
            throw CompositionError.templateNotFound(id)
        }
        return tpl
    }

    // MARK: - Step: agent

    private static func resolveAgent(
        _ request: AgentInvocationRequest,
        template: AgentTemplate?
    ) throws -> TerminalAgent {
        if let id = request.agentId {
            guard let agent = AgentCatalogStore.shared.agent(id: id) else {
                throw CompositionError.agentNotFound(id)
            }
            return agent
        }
        if let id = template?.agentId {
            guard let agent = AgentCatalogStore.shared.agent(id: id) else {
                throw CompositionError.agentNotFound(id)
            }
            return agent
        }
        let defaultId = TermLoopSettings.shared.defaultTerminalAgentId
        if let agent = AgentCatalogStore.shared.agent(id: defaultId) {
            return agent
        }
        if let first = AgentCatalogStore.shared.agents.first {
            return first
        }
        throw CompositionError.noResolvableAgent
    }

    // MARK: - Step: permission

    private static func resolvePermission(
        _ request: AgentInvocationRequest,
        template: AgentTemplate?
    ) -> AgentTemplate.PermissionMode? {
        if let override = request.permissionOverride { return override }
        return template?.permissionMode
    }

    // MARK: - Step: prompt body

    private static func resolvePromptBody(
        _ request: AgentInvocationRequest,
        template: AgentTemplate?,
        projectFolderPath: String?
    ) throws -> String? {
        let overrideDocumentBody = try resolvePromptDocumentBody(
            id: request.promptDocumentIdOverride,
            projectFolderPath: projectFolderPath
        )
        let templateDocumentBody = try resolvePromptDocumentBody(
            id: template?.promptDocumentId,
            projectFolderPath: projectFolderPath
        )
        let raw = request.userPrompt
            ?? overrideDocumentBody
            ?? templateDocumentBody
            ?? template?.body
        guard let raw, !raw.isEmpty else { return nil }
        do {
            return try VariableSubstitution.apply(raw, values: request.variableValues)
        } catch {
            throw CompositionError.variableSubstitutionFailed(error)
        }
    }

    // MARK: - Step: system instructions

    /// User-scoped system prompt override with variable substitution applied.
    /// Excludes the ability block and the TermLoop reporting prefix; the
    /// injector adds the prefix at delivery time, so including it here
    /// would double-prefix on Runner paths that re-feed the joined result.
    private static func buildUserSystemPrompt(
        request: AgentInvocationRequest,
        template: AgentTemplate?,
        projectFolderPath: String?
    ) throws -> String? {
        let overrideSystemDocumentBody = try resolveSystemPromptDocumentBody(
            id: request.systemPromptDocumentIdOverride,
            projectFolderPath: projectFolderPath
        )
        let templateSystemDocumentBody = try resolveSystemPromptDocumentBody(
            id: template?.systemPromptDocumentId,
            projectFolderPath: projectFolderPath
        )
        let raw = request.systemPromptOverride
            ?? overrideSystemDocumentBody
            ?? templateSystemDocumentBody
        guard let override = raw,
              !override.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        do {
            let substituted = try VariableSubstitution.apply(
                override,
                values: request.variableValues
            )
            return substituted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : substituted
        } catch {
            throw CompositionError.variableSubstitutionFailed(error)
        }
    }

    private static func resolvePromptDocumentBody(
        id: String?,
        projectFolderPath: String?
    ) throws -> String? {
        guard let id = normalizedDocumentId(id) else { return nil }
        let document = try requirePromptDocument(id: id, projectFolderPath: projectFolderPath)
        guard document.kind.canBackPromptBody else {
            throw CompositionError.promptDocumentKindMismatch(
                id: id,
                expected: "a prompt body",
                actual: document.kind
            )
        }
        return document.body
    }

    private static func resolveSystemPromptDocumentBody(
        id: String?,
        projectFolderPath: String?
    ) throws -> String? {
        guard let id = normalizedDocumentId(id) else { return nil }
        let document = try requirePromptDocument(id: id, projectFolderPath: projectFolderPath)
        guard document.kind.canBackSystemPrompt else {
            throw CompositionError.promptDocumentKindMismatch(
                id: id,
                expected: "system instructions",
                actual: document.kind
            )
        }
        return document.body
    }

    private static func requirePromptDocument(
        id: String,
        projectFolderPath: String?
    ) throws -> AgentPromptDocument {
        guard let document = AgentPromptStore.lookup(id: id, projectFolderPath: projectFolderPath) else {
            throw CompositionError.promptDocumentNotFound(id)
        }
        return document
    }

    private static func normalizedDocumentId(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Joins user override + ability block for consumers that want the full
    /// system prompt in one string (restore / worktree / socket preview).
    /// Fresh launches read `resolvedUserSystemPrompt` instead.
    static func joinSystemInstructions(_ parts: String?...) -> String? {
        let nonEmpty = parts.compactMap {
            $0?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? $0 : nil
        }
        guard !nonEmpty.isEmpty else { return nil }
        return nonEmpty.joined(separator: "\n\n")
    }

    // MARK: - Step: preview summary

    private static func buildPreviewSummary(
        request: AgentInvocationRequest,
        template: AgentTemplate?,
        agent: TerminalAgent,
        resolvedPrompt: String?,
        instructions: ProjectInstructionSnapshot
    ) -> AgentInvocationPlan.PreviewSummary {
        let title: String
        if request.source == .quickActionFreePrompt || request.reasonTag == "quickAction.freePrompt" {
            title = freePromptSnippet(resolvedPrompt) ?? defaultFreePromptTitle
        } else if let template {
            title = template.name
        } else {
            title = agent.displayName
        }
        let bodySnippet = resolvedPrompt.flatMap { snippet($0, max: 120) }
        return AgentInvocationPlan.PreviewSummary(
            title: title,
            snippet: bodySnippet,
            injectedAbilityNames: instructions.activeAbilities.map(\.name),
            listedAbilityNames: instructions.listedAbilities.map(\.name),
            referencedSkillNames: instructions.referencedSkills.map(\.name)
        )
    }

    private static func freePromptSnippet(_ prompt: String?) -> String? {
        guard let prompt else { return nil }
        let collapsed = prompt
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespaces)
        guard !collapsed.isEmpty else { return nil }
        return snippet(collapsed, max: 48)
    }

    private static func snippet(_ text: String, max: Int) -> String {
        let oneLine = text
            .split(whereSeparator: \.isNewline)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        if oneLine.count <= max { return oneLine }
        let head = oneLine.prefix(max - 1)
        return head + "…"
    }

    private static var defaultFreePromptTitle: String {
        String(
            localized: "quickAction.freePrompt.name",
            defaultValue: "Free prompt",
            table: "TermLoop"
        )
    }

    // MARK: - Helpers

    private static func projectFolderPath(for request: AgentInvocationRequest) -> String? {
        if let workspaceId = request.workspaceId {
            return ProjectInstructionStore.resolvedProjectFolderPath(
                forWorkspaceId: workspaceId,
                runCwd: request.runCwd?.path
            )
        }
        if let projectId = request.projectId,
           let project = ProjectStore.shared.project(id: projectId) {
            return project.folderPath
        }
        return ProjectInstructionStore.resolvedProjectFolderPath(
            projectFolderPath: nil,
            runCwd: request.runCwd?.path
        )
    }
}

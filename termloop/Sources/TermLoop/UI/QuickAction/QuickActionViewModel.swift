// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import Foundation
import SwiftUI

/// Legacy row kind — still used by the dropdown list rendering.
enum QuickActionRowKind {
    case template(AgentTemplate)
    case freePrompt(resolvedTemplateId: String?)

    var rowId: String {
        switch self {
        case .template(let t): return "tpl::\(t.id)"
        case .freePrompt: return "free-prompt"
        }
    }

    var displayName: String {
        switch self {
        case .template(let t): return t.name
        case .freePrompt(let tid):
            return tid ?? String(
                localized: "quickAction.freePrompt.name",
                defaultValue: "Free prompt",
                table: "TermLoop"
            )
        }
    }
}

extension QuickActionRowKind: Equatable {
    static func == (lhs: QuickActionRowKind, rhs: QuickActionRowKind) -> Bool {
        lhs.rowId == rhs.rowId
    }
}

extension QuickActionRowKind: Hashable {
    func hash(into hasher: inout Hasher) {
        hasher.combine(rowId)
    }
}

/// What the composer is currently composing.
enum QuickActionCompositionSource: Equatable {
    case freePrompt(resolvedTemplateId: String?)
    case template(id: String)
}

enum QuickActionSurface: String, Identifiable {
    case run
    case worktree
    var id: String { rawValue }
}

struct QuickActionInputStatus: Equatable {
    enum Kind: Equatable {
        case inlineText
        case selectedDocument(title: String)
        case templateDocument(title: String)
        case templateBody
        case none
    }

    let kind: Kind
    let shortLabel: String
    let detail: String
    let iconName: String

    var hasValue: Bool {
        switch kind {
        case .none:
            return false
        case .inlineText, .selectedDocument, .templateDocument, .templateBody:
            return true
        }
    }
}

struct QuickActionResolvedVariable: Identifiable, Equatable {
    let name: String
    let value: String
    var id: String { name }
}

enum QuickActionWorktreeIntent: Equatable {
    case createWorkspace
    case migrateConversationIfPossible
}

/// How a quick-action run should be dispatched.
enum QuickActionRunMode: String, CaseIterable, Identifiable {
    case terminal
    var id: String { rawValue }
}

@MainActor
protocol QuickActionLauncher: AnyObject {
    func launchTerminal(
        agent: TerminalAgent,
        title: String?,
        cwd: String?,
        worktreeExpectation: TermLoopWorktreeExpectation?,
        initialPrompt: String,
        projectId: UUID?,
        placementOverride: NewWorkspacePlacement?,
        permission: AgentTemplate.PermissionMode?,
        systemPrompt: String?,
        model: AgentModelOption?,
        reasoning: AgentReasoningOption?,
        launchProvidedFullContext: Bool
    ) throws -> Workspace
}

@MainActor
final class DefaultQuickActionLauncher: QuickActionLauncher {
    func launchTerminal(
        agent: TerminalAgent,
        title: String?,
        cwd: String?,
        worktreeExpectation: TermLoopWorktreeExpectation?,
        initialPrompt: String,
        projectId: UUID?,
        placementOverride: NewWorkspacePlacement?,
        permission: AgentTemplate.PermissionMode?,
        systemPrompt: String?,
        model: AgentModelOption?,
        reasoning: AgentReasoningOption?,
        launchProvidedFullContext: Bool
    ) throws -> Workspace {
        guard let tabManager = AppDelegate.shared?.tabManager else {
            throw QuickActionError.noTemplate
        }
        return try TerminalAgentLifecycle.createFreshWorkspace(
            tabManager: tabManager,
            agent: agent,
            title: title,
            cwd: cwd,
            worktreeExpectation: worktreeExpectation,
            initialPrompt: initialPrompt,
            projectId: projectId,
            placementOverride: placementOverride,
            permission: permission,
            systemPrompt: systemPrompt,
            model: model,
            reasoning: reasoning,
            launchProvidedFullContext: launchProvidedFullContext
        )
    }
}

@MainActor
final class QuickActionViewModel: ObservableObject {
    static func freePromptSnippet(from prompt: String, maxLength: Int = 60) -> String? {
        let collapsed = prompt
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !collapsed.isEmpty else { return nil }
        return String(collapsed.prefix(maxLength))
    }

    // MARK: Composer state

    @Published var activeSurface: QuickActionSurface = .run
    @Published var promptText: String = ""
    @Published var composition: QuickActionCompositionSource = .freePrompt(resolvedTemplateId: nil)
    @Published var isDropdownOpen: Bool = false

    // MARK: Target + advanced state

    @Published var targetWorkspaceId: UUID?
    @Published var isAdvancedOpen: Bool = false
    @Published var advancedPermission: AgentTemplate.PermissionMode = .bypassPermissions
    @Published var advancedVariableValues: [String: String] = [:]
    @Published var errorMessage: String?
    @Published var advancedRunMode: QuickActionRunMode = .terminal
    @Published var advancedTerminalAgentId: String = "claude"
    @Published var advancedModel: AgentModelOption = .default
    @Published var advancedReasoning: AgentReasoningOption = .default
    @Published var advancedSystemPrompt: String = ""
    @Published var selectedPromptDocumentId: String?
    @Published var selectedSystemPromptDocumentId: String?
    @Published var advancedTitle: String = ""
    @Published var worktreeBranchName: String = ""

    @Published private(set) var didRestoreFromMemory: Bool = false
    @Published private(set) var worktreeIntent: QuickActionWorktreeIntent = .createWorkspace
    private(set) var isSubmitting: Bool = false

    @Published var preview = QuickActionPreviewViewModel()

    private struct RunCwdCacheKey: Equatable {
        let targetWorkspaceId: UUID?
        let prefillProjectId: UUID?
        let activeProjectId: UUID?
    }
    private var cachedRunCwdForPreview: (key: RunCwdCacheKey, cwd: String?)?

    private struct LaunchPrefillContext {
        let projectId: UUID
        let terminalAgentId: String?
        let placementOverride: NewWorkspacePlacement?
        let suggestedBranchName: String?
    }

    private let templateStore: AgentTemplateStore
    private let promptStore: AgentPromptStore
    private let lru: QuickActionLRUStore
    private let launcher: QuickActionLauncher
    private var cancellables: Set<AnyCancellable> = []
    private var presentedLaunchSource: AgentInvocationSource?
    private var presentedReasonTag: String?
    private var launchPrefillContext: LaunchPrefillContext?
    private var onLaunchedWorkspace: ((Workspace) -> Void)?

    init(
        templateStore: AgentTemplateStore? = nil,
        promptStore: AgentPromptStore? = nil,
        lru: QuickActionLRUStore? = nil,
        launcher: QuickActionLauncher? = nil
    ) {
        self.templateStore = templateStore ?? AgentTemplateStore.shared
        self.promptStore = promptStore ?? AgentPromptStore.shared
        self.lru = lru ?? .shared
        self.launcher = launcher ?? DefaultQuickActionLauncher()

        self.templateStore.$templates
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        self.promptStore.$documents
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.objectWillChange.send()
                self?.refreshPreview()
            }
            .store(in: &cancellables)
        AbilityStore.shared.$abilities
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.refreshPreview()
            }
            .store(in: &cancellables)

        $targetWorkspaceId
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        $composition
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        $promptText
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        $advancedPermission
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)

        $advancedTerminalAgentId
            .removeDuplicates()
            .sink { [weak self] _ in
                self?.restoreAgentScopedSelectionsForCurrentAgent()
                self?.refreshPreview()
            }
            .store(in: &cancellables)
        $advancedModel
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        $advancedReasoning
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        $advancedSystemPrompt
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        $advancedVariableValues
            .removeDuplicates(by: ==)
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        $worktreeBranchName
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        $selectedPromptDocumentId
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        $selectedSystemPromptDocumentId
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)

        // Override toggles (mute / force-include) recompose the preview
        // plan — the plan's ability block reflects overrides via the
        // composer's `previewPlan(_:overrides:)` seam, so renderedSystemPrompt
        // stays byte-identical to what launch would emit for the same layer.
        // `removeDuplicates` + `dropFirst` breaks the echo loop that
        // `setPlan`'s stale-filter pass could otherwise trigger.
        preview.$mutedIds
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
        preview.$forceIncludedIds
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] _ in self?.refreshPreview() }
            .store(in: &cancellables)
    }

    // MARK: Lifecycle

    func onPresent(
        defaultTargetWorkspaceId: UUID?,
        worktreeIntent: QuickActionWorktreeIntent = .createWorkspace
    ) {
        activeSurface = .run
        promptText = ""
        isAdvancedOpen = false
        isDropdownOpen = false
        errorMessage = nil
        advancedVariableValues = [:]
        targetWorkspaceId = defaultTargetWorkspaceId
        self.worktreeIntent = worktreeIntent
        composition = .freePrompt(resolvedTemplateId: resolvedFreePromptTemplateId())
        syncDocumentSelectionsToComposition()

        let mem = lru.freePromptAdvancedMemory()
        advancedRunMode = QuickActionRunMode(rawValue: lru.lastRunMode() ?? "") ?? .terminal
        advancedTerminalAgentId = lru.lastTerminalAgentId() ?? "claude"
        applyAdvancedMemory(mem)
        advancedTitle = ""
        worktreeBranchName = ""
        didRestoreFromMemory = mem != nil || lru.lastRunMode() != nil
        isSubmitting = false
        presentedLaunchSource = nil
        presentedReasonTag = nil
        launchPrefillContext = nil
        onLaunchedWorkspace = nil
        syncDocumentSelectionsToComposition()

        preview.clearPerRunMutes()
        refreshPreview()
    }

    func onDismiss() {
        activeSurface = .run
        promptText = ""
        isAdvancedOpen = false
        isDropdownOpen = false
        errorMessage = nil
        advancedVariableValues = [:]
        advancedTitle = ""
        worktreeBranchName = ""
        advancedReasoning = .default
        isSubmitting = false
        worktreeIntent = .createWorkspace
        presentedLaunchSource = nil
        presentedReasonTag = nil
        launchPrefillContext = nil
        onLaunchedWorkspace = nil
        selectedPromptDocumentId = nil
        selectedSystemPromptDocumentId = nil
    }

    func applyPrefill(_ prefill: QuickActionPresentationRequest) {
        activeSurface = prefill.initialSurface
        targetWorkspaceId = prefill.targetWorkspaceId
        worktreeIntent = prefill.worktreeIntent

        if let composition = prefill.composition {
            self.composition = composition
        }
        syncDocumentSelectionsToComposition()
        if let promptText = prefill.promptText {
            self.promptText = promptText
        }
        if let advancedSystemPrompt = prefill.advancedSystemPrompt {
            self.advancedSystemPrompt = advancedSystemPrompt
        }
        if let advancedTitle = prefill.advancedTitle {
            self.advancedTitle = advancedTitle
        }
        worktreeBranchName = prefill.suggestedBranchName ?? ""
        if let advancedTerminalAgentId = prefill.advancedTerminalAgentId {
            self.advancedTerminalAgentId = advancedTerminalAgentId
        }
        if let advancedPermission = prefill.advancedPermission {
            self.advancedPermission = advancedPermission
        }
        if let advancedModel = prefill.advancedModel {
            self.advancedModel = advancedModel
        }
        if let advancedReasoning = prefill.advancedReasoning {
            self.advancedReasoning = advancedReasoning
        }
        if let variableValues = prefill.variableValues {
            self.advancedVariableValues = variableValues
        }
        if let promptDocumentId = prefill.promptDocumentId {
            self.selectedPromptDocumentId = promptDocumentId
        }
        if let systemPromptDocumentId = prefill.systemPromptDocumentId {
            self.selectedSystemPromptDocumentId = systemPromptDocumentId
        }

        presentedLaunchSource = prefill.launchSource
        presentedReasonTag = prefill.reasonTag
        onLaunchedWorkspace = prefill.onLaunchedWorkspace

        if let projectId = prefill.projectId {
            launchPrefillContext = LaunchPrefillContext(
                projectId: projectId,
                terminalAgentId: prefill.advancedTerminalAgentId,
                placementOverride: prefill.placementOverride,
                suggestedBranchName: prefill.suggestedBranchName
            )
        } else {
            launchPrefillContext = nil
        }

        if prefill.openAdvanced {
            isAdvancedOpen = true
        }

        normalizeAdvancedSelectionsForCurrentAgent()
        refreshPreview()
    }

    // MARK: Template rows (used only by dropdown now)

    var orderedTemplates: [AgentTemplate] {
        let all = templateStore.templates
        let byId: [String: AgentTemplate] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
        let order = lru.orderedTemplateIds(registered: all.map(\.id))
        return order.compactMap { byId[$0] }
    }

    // MARK: Composition transitions

    func openTemplateDropdown() { isDropdownOpen = true }
    func closeTemplateDropdown() { isDropdownOpen = false }

    func selectTemplate(id: String) {
        guard let tpl = templateStore.template(id: id) else { return }
        composition = .template(id: tpl.id)
        isDropdownOpen = false
        applyAdvancedMemory(lru.advancedMemory(forTemplateId: tpl.id))
        syncDocumentSelectionsToComposition()
        refreshPreview()
    }

    func returnToFreePrompt() {
        composition = .freePrompt(resolvedTemplateId: resolvedFreePromptTemplateId())
        isDropdownOpen = false
        applyAdvancedMemory(lru.freePromptAdvancedMemory())
        syncDocumentSelectionsToComposition()
        refreshPreview()
    }

    func toggleAdvanced() {
        isAdvancedOpen ? closeAdvanced() : openAdvanced()
    }
    func openAdvanced() { isAdvancedOpen = true }
    func closeAdvanced() { isAdvancedOpen = false }

    private func effectiveLaunchSource() -> AgentInvocationSource {
        if let presentedLaunchSource {
            return presentedLaunchSource
        }
        switch composition {
        case .template:
            return .quickAction
        case .freePrompt:
            return .quickActionFreePrompt
        }
    }

    var launchSource: AgentInvocationSource {
        effectiveLaunchSource()
    }

    var forkSourceWorkspace: Workspace? {
        guard launchSource.isForkLike,
              let targetWorkspaceId else { return nil }
        return AppDelegate.shared?.workspaceFor(tabId: targetWorkspaceId)
    }

    var forkSourceWorkspaceTitle: String? {
        guard let workspace = forkSourceWorkspace else { return nil }
        let customTitle = workspace.customTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return customTitle.isEmpty ? workspace.title : customTitle
    }

    private var resolvedLaunchProjectId: UUID? {
        if let wsId = targetWorkspaceId {
            let metadataProjectId = WorkspaceMetadataStore.shared
                .metadata(forWorkspaceId: wsId)
                .projectId
            if let metadataProjectId,
               ProjectStore.shared.project(id: metadataProjectId) != nil {
                return metadataProjectId
            }
        }
        return launchPrefillContext?.projectId ?? ProjectStore.shared.activeProjectId
    }

    // MARK: Launch

    @discardableResult
    func submit() -> Bool {
        guard !isSubmitting else { return false }
        errorMessage = nil
        isSubmitting = true
        var didLaunch = false
        defer {
            if !didLaunch {
                isSubmitting = false
            }
        }
        do {
            let request = try buildRequest()
            try launchTerminal(request: request)
            persistLRUOnSuccess()
            didLaunch = true
            return true
        } catch let QuickActionError.variablesRequired(missing) {
            openAdvanced()
            for name in missing where advancedVariableValues[name] == nil {
                advancedVariableValues[name] = ""
            }
            errorMessage = QuickActionError.variablesRequired(missing).localizedDescription
            return false
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func buildRequest() throws -> AgentInvocationRequest {
        let effectivePermission = advancedPermission
        let effectiveModel = advancedModel
        let effectiveReasoning = advancedReasoning
        let source = effectiveLaunchSource()
        let reasonTag = presentedReasonTag
        let effectiveSystemPrompt: String? = {
            let trimmed = advancedSystemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : advancedSystemPrompt
        }()
        let agentId = advancedTerminalAgentId
        let promptDocumentIdOverride = promptDocumentOverrideForCurrentSelection()
        let systemPromptDocumentIdOverride = systemPromptDocumentOverrideForCurrentSelection()

        switch composition {
        case .template(let id):
            guard let tpl = templateStore.template(id: id) else {
                throw QuickActionError.noTemplate
            }
            let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard promptInputStatus.hasValue else {
                throw QuickActionError.promptRequired
            }
            let projectId = resolvedLaunchProjectId
            return try QuickActionRunResolver.resolve(
                template: tpl,
                targetWorkspaceId: targetWorkspaceId,
                agentId: agentId,
                promptOverride: trimmed.isEmpty ? nil : promptText,
                promptDocumentIdOverride: promptDocumentIdOverride,
                permissionOverride: effectivePermission,
                variableOverrides: advancedVariableValues,
                source: source,
                modelOverride: effectiveModel,
                reasoningOverride: effectiveReasoning,
                systemPromptOverride: effectiveSystemPrompt,
                systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
                reasonTag: reasonTag,
                projectId: projectId
            )
        case .freePrompt(let resolvedId):
            guard let id = resolvedId, let tpl = templateStore.template(id: id) else {
                throw QuickActionError.noTemplate
            }
            let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
            // Free-prompt mode allows silent launch: empty composer + no doc +
            // empty template body launches the agent without a synthetic
            // first turn. The `.template(id:)` path still requires a prompt.
            if targetWorkspaceId == nil {
                guard let projectId = resolvedLaunchProjectId,
                      let project = ProjectStore.shared.project(id: projectId) else {
                    throw QuickActionError.noCurrentProject
                }
                let expanded = (project.folderPath as NSString).expandingTildeInPath
                let rootURL = URL(fileURLWithPath: expanded)
                let context = QuickActionRunResolver.ResolvedContext(
                    workspaceId: nil,
                    projectId: projectId,
                    workspaceCwd: rootURL,
                    branchName: nil,
                    repoRootPath: rootURL.path
                )
                return try QuickActionRunResolver.resolve(
                    template: tpl,
                    context: context,
                    agentId: agentId,
                    promptOverride: trimmed.isEmpty ? nil : promptText,
                    promptDocumentIdOverride: promptDocumentIdOverride,
                    permissionOverride: effectivePermission,
                    variableOverrides: advancedVariableValues,
                    source: source,
                    modelOverride: effectiveModel,
                    reasoningOverride: effectiveReasoning,
                    systemPromptOverride: effectiveSystemPrompt,
                    systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
                    reasonTag: reasonTag
                )
            }
            let projectId = resolvedLaunchProjectId
            return try QuickActionRunResolver.resolve(
                template: tpl,
                targetWorkspaceId: targetWorkspaceId,
                agentId: agentId,
                promptOverride: trimmed.isEmpty ? nil : promptText,
                promptDocumentIdOverride: promptDocumentIdOverride,
                permissionOverride: effectivePermission,
                variableOverrides: advancedVariableValues,
                source: source,
                modelOverride: effectiveModel,
                reasoningOverride: effectiveReasoning,
                systemPromptOverride: effectiveSystemPrompt,
                systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
                reasonTag: reasonTag,
                projectId: projectId
            )
        }
    }

    private struct NewWorktreeContext {
        let projectId: UUID
        let terminalAgentId: String?
    }

    func newWorktreeRequest() throws -> NewWorkspaceWithWorktreeRequest {
        if worktreeIntent == .migrateConversationIfPossible {
            guard let wsId = targetWorkspaceId else {
                throw QuickActionError.workspaceScopeRequiresTarget
            }
            guard let workspace = AppDelegate.shared?.workspaceFor(tabId: wsId) else {
                throw QuickActionError.workspaceNotFound(wsId)
            }
            guard let request = ConversationWorktreeMigrationResolver.request(for: workspace) else {
                throw QuickActionError.worktreeMigrationUnavailable
            }
            return request
        }

        let context = try newWorktreeContext()
        return NewWorkspaceWithWorktreeRequest(
            projectId: context.projectId,
            terminalAgentId: context.terminalAgentId,
            initialPrompt: resolvedWorktreeInitialPrompt(),
            systemPrompt: resolvedWorktreeSystemPrompt(),
            templateId: activeTemplate?.id,
            promptDocumentIdOverride: promptDocumentOverrideForCurrentSelection(),
            systemPromptDocumentIdOverride: systemPromptDocumentOverrideForCurrentSelection(),
            permissionOverride: advancedPermission,
            modelOverride: advancedModel,
            reasoningOverride: advancedReasoning,
            variableValues: advancedVariableValues,
            launchSource: .manualWorkspaceCreate,
            reasonTag: presentedReasonTag,
            suggestedBranchName: resolvedSuggestedWorktreeBranchName()
        )
    }

    private func newWorktreeContext() throws -> NewWorktreeContext {
        let selectedAgentId = resolvedSelectedTerminalAgentId()

        if let launchPrefillContext {
            return NewWorktreeContext(
                projectId: launchPrefillContext.projectId,
                terminalAgentId: selectedAgentId
            )
        }

        if let wsId = targetWorkspaceId,
           let workspace = AppDelegate.shared?.workspaceFor(tabId: wsId) {
            let meta = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: wsId)
            if let projectId = meta.projectId ?? workspace.projectId {
                return NewWorktreeContext(
                    projectId: projectId,
                    terminalAgentId: selectedAgentId
                )
            }
        }

        guard let projectId = ProjectStore.shared.activeProjectId else {
            throw QuickActionError.noCurrentProject
        }
        return NewWorktreeContext(
            projectId: projectId,
            terminalAgentId: selectedAgentId
        )
    }

    private func resolvedWorktreeInitialPrompt() -> String? {
        let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : promptText
    }

    private func resolvedSuggestedWorktreeBranchName() -> String? {
        let trimmed = worktreeBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? launchPrefillContext?.suggestedBranchName : worktreeBranchName
    }

    private func resolvedWorktreeSystemPrompt() -> String? {
        {
            let trimmed = advancedSystemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : advancedSystemPrompt
        }()
    }

    private func resolvedDefaultTerminalAgentId() -> String? {
        let defaultId = TermLoopSettings.shared.defaultTerminalAgentId
        return AgentCatalogStore.shared.agent(id: defaultId)?.id
            ?? AgentCatalogStore.shared.agents.first?.id
    }

    private func resolvedSelectedTerminalAgentId() -> String? {
        if AgentCatalogStore.shared.agent(id: advancedTerminalAgentId) != nil {
            return advancedTerminalAgentId
        }
        return resolvedDefaultTerminalAgentId()
    }

    private func launchTerminal(request: AgentInvocationRequest) throws {
        let plan: AgentInvocationPlan
        do {
            plan = try AgentInvocationComposer.compose(request)
        } catch {
            throw QuickActionError.noTemplate
        }
        guard let agent = AgentCatalogStore.shared.agent(id: plan.agentId) else {
            throw QuickActionError.noTemplate
        }
        let cwdPath = plan.runCwd?.path
        let title = terminalWorkspaceTitle(for: plan, agent: agent)
        if plan.source.usesSourceWorkspaceLaunch,
           let sourceWorkspaceId = plan.workspaceId {
            guard let sourceWorkspace = AppDelegate.shared?.workspaceFor(tabId: sourceWorkspaceId),
                  let tabManager = AppDelegate.shared?.tabManager else {
                throw QuickActionError.workspaceNotFound(sourceWorkspaceId)
            }
            let workspace = try TerminalAgentLifecycle.forkWorkspace(
                tabManager: tabManager,
                from: sourceWorkspace,
                plan: plan,
                title: title
            )
            onLaunchedWorkspace?(workspace)
            return
        }
        let worktreeExpectation: TermLoopWorktreeExpectation? = {
            guard let branch = plan.branchName,
                  let cwdPath,
                  !branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            return TermLoopWorktreeExpectation(path: cwdPath, branch: branch)
        }()
        ProjectSkillMaterializer.materializeForLaunch(plan)
        let workspace = try launcher.launchTerminal(
            agent: agent,
            title: title,
            cwd: cwdPath,
            worktreeExpectation: worktreeExpectation,
            initialPrompt: plan.resolvedPromptBody ?? "",
            projectId: plan.projectId,
            placementOverride: launchPrefillContext?.placementOverride,
            permission: plan.resolvedPermission,
            // Pass the full resolved system instructions (abilities +
            // user prompt + reported context block), not just the raw
            // user prompt. The injector wraps everything with the
            // reporting instruction and hands it to Claude as
            // `--append-system-prompt` / Codex as
            // `model_instructions_file`. Without this, wrapper scripts
            // had to re-fetch the workspace context via socket on
            // every spawn and Claude's wrapper bailed out entirely
            // when it saw the runner's `--append-system-prompt`.
            systemPrompt: plan.launchSystemInstructions,
            model: plan.resolvedModel,
            reasoning: plan.resolvedReasoning,
            // Only set the wrapper-skip env signal when the runner
            // really did inline a joined payload (abilities + reported
            // context). Falling back to user-only must leave the
            // wrapper free to fetch via socket.
            launchProvidedFullContext: plan.launchProvidedFullContext
        )
        onLaunchedWorkspace?(workspace)
    }

    private func persistLRUOnSuccess() {
        // Customize-with-agent launches are directed one-shot tasks, not user
        // authoring. Persisting them pollutes the free-prompt restore so a
        // later shift-shift would resurrect the customizer system prompt and
        // ability refs. Skip persistence entirely for these sources.
        switch effectiveLaunchSource() {
        case .abilityRefiner, .abilityCreator:
            return
        default:
            break
        }
        lru.setLastRunMode(advancedRunMode.rawValue)
        lru.setLastTerminalAgentId(advancedTerminalAgentId)
        PermissionModePersistence.setLastUsedMode(
            advancedPermission,
            forAgentId: advancedTerminalAgentId
        )
        lru.setAgentAdvanced(
            QuickActionAgentMemory(
                modelOverride: advancedModel == .default ? nil : advancedModel,
                reasoningOverride: advancedReasoning == .default ? nil : advancedReasoning
            ),
            forAgentId: advancedTerminalAgentId
        )
        let mem = QuickActionAdvancedMemory(
            permissionMode: advancedPermission.rawValue,
            variableValues: advancedVariableValues,
            modelOverride: advancedModel == .default ? nil : advancedModel,
            reasoningOverride: advancedReasoning == .default
                ? nil
                : advancedReasoning,
            systemPrompt: advancedSystemPrompt.isEmpty ? nil : advancedSystemPrompt
        )
        switch composition {
        case .template(let id):
            lru.recordRun(templateId: id)
            lru.setAdvanced(mem, forTemplateId: id)
        case .freePrompt(let resolvedId):
            if let id = resolvedId {
                lru.recordFreePromptRun(resolvedTemplateId: id)
            }
            lru.setFreePromptAdvanced(mem)
        }
    }

    func recordSuccessfulWorktreeCreate() {
        persistLRUOnSuccess()
    }

    func terminalWorkspaceTitle(
        for plan: AgentInvocationPlan,
        agent: TerminalAgent
    ) -> String {
        let trimmedCustom = advancedTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseTitle: String
        if !trimmedCustom.isEmpty {
            baseTitle = trimmedCustom
        } else if plan.source == .quickActionFreePrompt || plan.reasonTag == "quickAction.freePrompt" {
            baseTitle = Self.freePromptSnippet(
                from: plan.resolvedPromptBody ?? "",
                maxLength: 48
            ) ?? String(
                localized: "quickAction.freePrompt.name",
                defaultValue: "Free prompt",
                table: "TermLoop"
            )
        } else {
            baseTitle = plan.template?.name ?? String(
                localized: "quickAction.freePrompt.name",
                defaultValue: "Free prompt",
                table: "TermLoop"
            )
        }
        // Defensive: when the inherited customTitle already ends with the
        // agent suffix (legacy "+ agent" flow stomped customTitle on every
        // click, leading to "name (Claude Code) (Claude Code) ..."), don't
        // append it again. Strip any number of trailing duplicates first.
        let agentSuffix = " (\(agent.displayName))"
        var trimmed = baseTitle
        while trimmed.hasSuffix(agentSuffix) {
            trimmed = String(trimmed.dropLast(agentSuffix.count))
        }
        return trimmed + agentSuffix
    }

    private func resolvedFreePromptTemplateId() -> String? {
        let all = templateStore.templates
        let byId: [String: AgentTemplate] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
        if byId[QuickActionSettings.freePromptTemplateId] != nil {
            return QuickActionSettings.freePromptTemplateId
        }
        if let last = lru.lastFreePromptTemplateId(), byId[last] != nil {
            return last
        }
        if let settingsDefault = QuickActionSettings.defaultAgentTemplateId(), byId[settingsDefault] != nil {
            return settingsDefault
        }
        return all.map(\.id).sorted().first
    }

    private func resolvedModelSelection(
        _ stored: AgentModelOption?,
        forAgentId agentId: String
    ) -> AgentModelOption {
        AgentCatalogStore.shared.resolveModel(stored, for: agentId)
    }

    private func applyAdvancedMemory(_ memory: QuickActionAdvancedMemory?) {
        if let templateAgentId = activeTemplate?.agentId,
           AgentCatalogStore.shared.agent(id: templateAgentId) != nil {
            advancedTerminalAgentId = templateAgentId
        }
        advancedPermission =
            PermissionModePersistence.lastUsedMode(forAgentId: advancedTerminalAgentId)
            ?? permissionMode(from: memory?.permissionMode)
            ?? .bypassPermissions
        advancedVariableValues = memory?.variableValues ?? [:]
        let agentMemory = lru.agentAdvancedMemory(forAgentId: advancedTerminalAgentId)
        advancedModel = resolvedModelSelection(
            agentMemory?.modelOverride
                ?? memory?.modelOverride
                ?? activeTemplate?.model,
            forAgentId: advancedTerminalAgentId
        )
        advancedReasoning = reasoningFromLRU(
            agentMemory?.reasoningOverride
                ?? memory?.reasoningOverride
                ?? activeTemplate?.reasoning,
            forAgentId: advancedTerminalAgentId
        )
        advancedSystemPrompt = memory?.systemPrompt ?? ""
    }

    private func reasoningFromLRU(
        _ stored: AgentReasoningOption?,
        forAgentId agentId: String
    ) -> AgentReasoningOption {
        AgentCatalogStore.shared.resolveReasoning(stored, for: agentId) ?? .default
    }

    private func permissionMode(from rawValue: String?) -> AgentTemplate.PermissionMode? {
        guard let rv = rawValue else { return nil }
        return AgentTemplate.PermissionMode(rawValue: rv)
    }

    var activeTemplate: AgentTemplate? {
        switch composition {
        case .template(let id):
            return templateStore.template(id: id)
        case .freePrompt(let resolvedId):
            return resolvedId.flatMap { templateStore.template(id: $0) }
        }
    }

    var availablePromptDocuments: [AgentPromptDocument] {
        promptStore.documents.filter { $0.kind.canBackPromptBody }
    }

    var availableSystemPromptDocuments: [AgentPromptDocument] {
        promptStore.documents.filter { $0.kind.canBackSystemPrompt }
    }

    var selectedPromptDocumentTitle: String {
        if let id = normalizedDocumentId(selectedPromptDocumentId),
           let document = promptStore.documents.first(where: { $0.id == id }) {
            return document.title
        }
        return String(
            localized: "quickAction.advanced.promptDocument.none",
            defaultValue: "None",
            table: "TermLoop"
        )
    }

    var selectedSystemPromptDocumentTitle: String {
        if let id = normalizedDocumentId(selectedSystemPromptDocumentId),
           let document = promptStore.documents.first(where: { $0.id == id }) {
            return document.title
        }
        return String(
            localized: "quickAction.advanced.systemDocument.none",
            defaultValue: "None",
            table: "TermLoop"
        )
    }

    var freePromptBackingTemplateName: String? {
        guard case .freePrompt(let resolvedId) = composition,
              let resolvedId else { return nil }
        return templateStore.template(id: resolvedId)?.name ?? resolvedId
    }

    var freePromptUsesDedicatedTemplate: Bool {
        guard case .freePrompt(let resolvedId) = composition else { return false }
        return resolvedId == QuickActionSettings.freePromptTemplateId
    }

    var promptInputStatus: QuickActionInputStatus {
        let trimmedPrompt = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedPrompt.isEmpty {
            return QuickActionInputStatus(
                kind: .inlineText,
                shortLabel: "typed message",
                detail: "First message will come from the composer text.",
                iconName: "character.cursor.ibeam"
            )
        }

        if let selectedId = normalizedDocumentId(selectedPromptDocumentId),
           let document = promptStore.documents.first(where: { $0.id == selectedId }) {
            let isTemplateDefault = selectedId == normalizedDocumentId(activeTemplate?.promptDocumentId)
            return QuickActionInputStatus(
                kind: isTemplateDefault
                    ? .templateDocument(title: document.title)
                    : .selectedDocument(title: document.title),
                shortLabel: isTemplateDefault ? "template message doc" : "message doc",
                detail: isTemplateDefault
                    ? "First message will come from the template message document “\(document.title)”."
                    : "First message will come from the selected message document “\(document.title)”.",
                iconName: "doc.text"
            )
        }

        if let template = activeTemplate,
           !template.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return QuickActionInputStatus(
                kind: .templateBody,
                shortLabel: "template default prompt",
                detail: "First message will come from the template default prompt.",
                iconName: "text.alignleft"
            )
        }

        return QuickActionInputStatus(
            kind: .none,
            shortLabel: "none",
            detail: "No first message source is currently selected.",
            iconName: "text.badge.xmark"
        )
    }

    var systemInputStatus: QuickActionInputStatus {
        let trimmedSystem = advancedSystemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedSystem.isEmpty {
            return QuickActionInputStatus(
                kind: .inlineText,
                shortLabel: "typed instructions",
                detail: "System instructions will come from the Advanced system instructions field.",
                iconName: "slider.horizontal.3"
            )
        }

        if let selectedId = normalizedDocumentId(selectedSystemPromptDocumentId),
           let document = promptStore.documents.first(where: { $0.id == selectedId }) {
            let isTemplateDefault = selectedId == normalizedDocumentId(activeTemplate?.systemPromptDocumentId)
            return QuickActionInputStatus(
                kind: isTemplateDefault
                    ? .templateDocument(title: document.title)
                    : .selectedDocument(title: document.title),
                shortLabel: isTemplateDefault ? "template instructions doc" : "instructions doc",
                detail: isTemplateDefault
                    ? "System instructions will come from the template instructions document “\(document.title)”."
                    : "System instructions will come from the selected instructions document “\(document.title)”.",
                iconName: "gearshape.2"
            )
        }

        return QuickActionInputStatus(
            kind: .none,
            shortLabel: "none",
            detail: "No direct system instructions are currently selected.",
            iconName: "gearshape.2.fill"
        )
    }

    var templateDefaultsSummaryText: String {
        guard let template = activeTemplate else {
            return String(
                localized: "quickAction.template.summary.none",
                defaultValue: "template",
                table: "TermLoop"
            )
        }

        var parts: [String] = []
        if normalizedDocumentId(template.promptDocumentId) != nil {
            parts.append("message doc")
        } else if !template.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append("default message")
        }
        if normalizedDocumentId(template.systemPromptDocumentId) != nil {
            parts.append("instructions doc")
        }

        return parts.isEmpty ? "template" : parts.joined(separator: " + ")
    }

    var resolvedTemplateVariablesForPreview: [QuickActionResolvedVariable] {
        guard let template = activeTemplate else { return [] }
        guard let values = try? QuickActionRunResolver.resolvedVariableValues(
            for: template,
            targetWorkspaceId: targetWorkspaceId,
            projectId: resolvedLaunchProjectId,
            variableOverrides: advancedVariableValues
        ) else {
            return []
        }
        return template.variables
            .sorted()
            .compactMap { name in
                guard let value = values[name] else { return nil }
                return QuickActionResolvedVariable(name: name, value: value)
            }
    }

    var activeTemplateSourcePathForPreview: String? {
        activeTemplate?.sourceURL.path
    }

    var activeTemplateOriginLabel: String {
        guard let template = activeTemplate else { return "template" }
        switch template.source {
        case .builtin:
            return "builtin"
        case .user:
            return "user override"
        case .project:
            return "project override"
        }
    }

    var activeTemplatePromptSourceLabel: String {
        switch promptInputStatus.kind {
        case .inlineText:
            return "Typed message"
        case .selectedDocument(let title):
            return "Message document · \(title)"
        case .templateDocument(let title):
            return "Template message document · \(title)"
        case .templateBody:
            return "Template default prompt"
        case .none:
            return "None"
        }
    }

    var composerPromptHint: String? {
        switch promptInputStatus.kind {
        case .inlineText, .none:
            return nil
        case .selectedDocument(let title):
            return "Leave the composer empty to use message doc “\(title)”."
        case .templateDocument(let title):
            return "Leave the composer empty to use template message doc “\(title)”."
        case .templateBody:
            return "Leave the composer empty to use the template default prompt."
        }
    }

    var effectivePromptPreviewText: String? {
        guard promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let prompt = preview.plan?.resolvedPromptBody?.trimmingCharacters(in: .whitespacesAndNewlines),
              !prompt.isEmpty else {
            return nil
        }
        return prompt
    }

    var effectivePromptPreviewLabel: String? {
        guard effectivePromptPreviewText != nil else { return nil }
        return promptInputStatus.shortLabel
    }

    var shouldShowRunCompositionSummary: Bool {
        let supportsSummary = activeSurface == .run
            || (activeSurface == .worktree && worktreeIntent == .createWorkspace)
        return supportsSummary && (promptInputStatus.hasValue || systemInputStatus.hasValue)
    }

    var canSubmitCurrentPrompt: Bool {
        if case .freePrompt = composition { return true }
        return promptInputStatus.hasValue
    }

    // MARK: Preview

    private func resolvedWorktreePreviewContext() -> QuickActionRunResolver.ResolvedContext? {
        guard activeSurface == .worktree,
              worktreeIntent == .createWorkspace else {
            return nil
        }
        let branch = worktreeBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty,
              let projectId = resolvedLaunchProjectId,
              let project = ProjectStore.shared.project(id: projectId) else {
            return nil
        }
        let projectPath = (project.folderPath as NSString).expandingTildeInPath
        guard let worktreePath = WorktreeResolver.path(
            projectFolder: projectPath,
            branch: branch
        ) else {
            return nil
        }
        return QuickActionRunResolver.ResolvedContext(
            workspaceId: nil,
            projectId: projectId,
            workspaceCwd: URL(fileURLWithPath: worktreePath),
            branchName: branch,
            repoRootPath: projectPath
        )
    }

    func refreshPreview() {
        guard let agent = AgentCatalogStore.shared.agent(id: advancedTerminalAgentId)
            ?? AgentCatalogStore.shared.agents.first else {
            preview.setPlan(nil)
            return
        }
        let source = effectiveLaunchSource()
        let request: AgentInvocationRequest?
        let trimmedPrompt = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveSystemPrompt: String? = {
            let trimmed = advancedSystemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : advancedSystemPrompt
        }()
        let promptDocumentIdOverride = promptDocumentOverrideForCurrentSelection()
        let systemPromptDocumentIdOverride = systemPromptDocumentOverrideForCurrentSelection()
        let worktreePreviewContext = resolvedWorktreePreviewContext()

        switch composition {
        case .template(let id):
            guard let tpl = templateStore.template(id: id) else {
                preview.setPlan(nil)
                return
            }
            if let worktreePreviewContext {
                request = try? QuickActionRunResolver.resolve(
                    template: tpl,
                    context: worktreePreviewContext,
                    agentId: agent.id,
                    promptOverride: trimmedPrompt.isEmpty ? nil : promptText,
                    promptDocumentIdOverride: promptDocumentIdOverride,
                    permissionOverride: advancedPermission,
                    variableOverrides: advancedVariableValues,
                    source: source,
                    modelOverride: advancedModel,
                    reasoningOverride: advancedReasoning,
                    systemPromptOverride: effectiveSystemPrompt,
                    systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
                    reasonTag: presentedReasonTag
                )
            } else {
                request = try? QuickActionRunResolver.resolvePreview(
                    template: tpl,
                    targetWorkspaceId: targetWorkspaceId,
                    agentId: agent.id,
                    promptOverride: trimmedPrompt.isEmpty ? nil : promptText,
                    promptDocumentIdOverride: promptDocumentIdOverride,
                    permissionOverride: advancedPermission,
                    variableOverrides: advancedVariableValues,
                    source: source,
                    modelOverride: advancedModel,
                    reasoningOverride: advancedReasoning,
                    systemPromptOverride: effectiveSystemPrompt,
                    systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
                    reasonTag: presentedReasonTag,
                    projectId: resolvedLaunchProjectId
                )
            }
        case .freePrompt(let resolvedId):
            guard let id = resolvedId,
                  let tpl = templateStore.template(id: id) else {
                preview.setPlan(nil)
                return
            }
            if let worktreePreviewContext {
                request = try? QuickActionRunResolver.resolve(
                    template: tpl,
                    context: worktreePreviewContext,
                    agentId: agent.id,
                    promptOverride: trimmedPrompt.isEmpty ? nil : promptText,
                    promptDocumentIdOverride: promptDocumentIdOverride,
                    permissionOverride: advancedPermission,
                    variableOverrides: advancedVariableValues,
                    source: source,
                    modelOverride: advancedModel,
                    reasoningOverride: advancedReasoning,
                    systemPromptOverride: effectiveSystemPrompt,
                    systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
                    reasonTag: presentedReasonTag
                )
            } else if targetWorkspaceId == nil {
                if let projectId = resolvedLaunchProjectId,
                   let project = ProjectStore.shared.project(id: projectId) {
                    let expanded = (project.folderPath as NSString).expandingTildeInPath
                    let rootURL = URL(fileURLWithPath: expanded)
                    let context = QuickActionRunResolver.ResolvedContext(
                        workspaceId: nil,
                        projectId: projectId,
                        workspaceCwd: rootURL,
                        branchName: nil,
                        repoRootPath: rootURL.path
                    )
                    request = try? QuickActionRunResolver.resolve(
                        template: tpl,
                        context: context,
                        agentId: agent.id,
                        promptOverride: trimmedPrompt.isEmpty ? nil : promptText,
                        promptDocumentIdOverride: promptDocumentIdOverride,
                        permissionOverride: advancedPermission,
                        variableOverrides: advancedVariableValues,
                        source: source,
                        modelOverride: advancedModel,
                        reasoningOverride: advancedReasoning,
                        systemPromptOverride: effectiveSystemPrompt,
                        systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
                        reasonTag: presentedReasonTag
                    )
                } else {
                    request = nil
                }
            } else {
                request = try? QuickActionRunResolver.resolvePreview(
                    template: tpl,
                    targetWorkspaceId: targetWorkspaceId,
                    agentId: agent.id,
                    promptOverride: trimmedPrompt.isEmpty ? nil : promptText,
                    promptDocumentIdOverride: promptDocumentIdOverride,
                    permissionOverride: advancedPermission,
                    variableOverrides: advancedVariableValues,
                    source: source,
                    modelOverride: advancedModel,
                    reasoningOverride: advancedReasoning,
                    systemPromptOverride: effectiveSystemPrompt,
                    systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
                    reasonTag: presentedReasonTag,
                    projectId: resolvedLaunchProjectId
                )
            }
        }
        guard let request else {
            preview.setPlan(nil)
            return
        }
        let plan = try? AgentInvocationComposer.previewPlan(
            request,
            overrides: preview.currentOverrides
        )
        preview.setPlan(plan)
    }

    private func normalizeAdvancedSelectionsForCurrentAgent() {
        advancedModel = AgentCatalogStore.shared
            .resolveModel(advancedModel, for: advancedTerminalAgentId)
        advancedReasoning = AgentCatalogStore.shared
            .resolveReasoning(advancedReasoning, for: advancedTerminalAgentId) ?? .default
    }

    private func syncDocumentSelectionsToComposition() {
        selectedPromptDocumentId = activeTemplate?.promptDocumentId
        selectedSystemPromptDocumentId = activeTemplate?.systemPromptDocumentId
    }

    private func promptDocumentOverrideForCurrentSelection() -> String? {
        let selected = normalizedDocumentId(selectedPromptDocumentId)
        let templateDefault = normalizedDocumentId(activeTemplate?.promptDocumentId)
        return selected == templateDefault ? nil : selected
    }

    private func systemPromptDocumentOverrideForCurrentSelection() -> String? {
        let selected = normalizedDocumentId(selectedSystemPromptDocumentId)
        let templateDefault = normalizedDocumentId(activeTemplate?.systemPromptDocumentId)
        return selected == templateDefault ? nil : selected
    }

    private func normalizedDocumentId(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func resetPromptDocumentSelectionToTemplateDefault() {
        selectedPromptDocumentId = activeTemplate?.promptDocumentId
    }

    func resetSystemPromptDocumentSelectionToTemplateDefault() {
        selectedSystemPromptDocumentId = activeTemplate?.systemPromptDocumentId
    }

    private func currentAdvancedMemory() -> QuickActionAdvancedMemory? {
        switch composition {
        case .template(let id):
            return lru.advancedMemory(forTemplateId: id)
        case .freePrompt:
            return lru.freePromptAdvancedMemory()
        }
    }

    private func restoreAgentScopedSelectionsForCurrentAgent() {
        let agentId = advancedTerminalAgentId
        advancedPermission =
            PermissionModePersistence.lastUsedMode(forAgentId: agentId)
            ?? advancedPermission
        let templateMemory = currentAdvancedMemory()
        let agentMemory = lru.agentAdvancedMemory(forAgentId: agentId)
        advancedModel = resolvedModelSelection(
            agentMemory?.modelOverride
                ?? templateMemory?.modelOverride
                ?? activeTemplate?.model,
            forAgentId: agentId
        )
        advancedReasoning = reasoningFromLRU(
            agentMemory?.reasoningOverride
                ?? templateMemory?.reasoningOverride
                ?? activeTemplate?.reasoning,
            forAgentId: agentId
        )
        normalizeAdvancedSelectionsForCurrentAgent()
    }

    func resolvedRunCwdForPreview() -> String? {
        if let worktreeContext = resolvedWorktreePreviewContext() {
            return worktreeContext.workspaceCwd?.path
        }
        let key = RunCwdCacheKey(
            targetWorkspaceId: targetWorkspaceId,
            prefillProjectId: launchPrefillContext?.projectId,
            activeProjectId: ProjectStore.shared.activeProjectId
        )
        if let cache = cachedRunCwdForPreview, cache.key == key {
            return cache.cwd
        }
        let resolved: String? = {
            if let wsId = targetWorkspaceId,
               let ws = AppDelegate.shared?.workspaceFor(tabId: wsId) {
                if let cwd = ws.termLoopPresentationCwd() {
                    return cwd
                }
            }
            if let projectId = launchPrefillContext?.projectId,
               let project = ProjectStore.shared.project(id: projectId) {
                return project.folderPath
            }
            return ProjectStore.shared.activeProject?.folderPath
        }()
        cachedRunCwdForPreview = (key, resolved)
        return resolved
    }

    func resolvedProjectFolderForPreview() -> String? {
        if activeSurface == .worktree,
           worktreeIntent == .createWorkspace,
           let projectId = resolvedLaunchProjectId,
           let project = ProjectStore.shared.project(id: projectId) {
            return project.folderPath
        }
        if let wsId = targetWorkspaceId {
            return ProjectInstructionStore.resolvedProjectFolderPath(
                forWorkspaceId: wsId,
                runCwd: resolvedRunCwdForPreview()
            )
        }
        return ProjectStore.shared.activeProject?.folderPath
    }

    func resolvedBranchForPreview() -> String? {
        if activeSurface == .worktree, worktreeIntent == .createWorkspace {
            let branch = worktreeBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
            return branch.isEmpty ? nil : branch
        }
        guard let wsId = targetWorkspaceId,
              let ws = AppDelegate.shared?.workspaceFor(tabId: wsId) else { return nil }
        return WorkspaceMetadataStore.shared.branch(for: ws)
    }

    func transportResolutionForPreview() -> AgentInvocationTransportAdapter.Resolution? {
        guard let plan = preview.plan else { return nil }
        // `resolvedSystemInstructions` mirrors the joined fresh-launch payload
        // the wrapper script + runner deliver across two `--append-system-prompt`
        // flags. Use it here so preview matches what Claude sees (invariant 5).
        return try? AgentInvocationTransportAdapter.resolve(
            agentId: plan.agentId,
            initialPrompt: plan.resolvedPromptBody,
            systemInstructions: plan.resolvedSystemInstructions
        )
    }

    /// Reconstructs the shell command the palette would run for the Raw
    /// tab, using the same transport adapter + model/permission argv that
    /// `TerminalAgentRunner.prepareLaunch` consumes. The system-instruction
    /// text mirrors the joined fresh-launch payload (user override + ability
    /// block + reported context) so what's shown matches what Claude actually
    /// receives across both `--append-system-prompt` flags.
    func fullCommandForPreview() -> String {
        guard let plan = preview.plan,
              let agent = AgentCatalogStore.shared.agent(id: plan.agentId) else {
            return ""
        }
        let cwd = resolvedRunCwdForPreview()
        let transport = transportResolutionForPreview()
        var args = TerminalAgentRunner.launchArgv(
            for: agent,
            permission: plan.resolvedPermission,
            model: plan.resolvedModel,
            reasoning: plan.resolvedReasoning
        )
        if let transport {
            args.append(contentsOf: transport.extraArgv)
            let combinedPrompt = (transport.promptPrefix ?? "") + (transport.initialPrompt ?? "")
            let trimmed = combinedPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                if combinedPrompt.count <= 6000 {
                    args.append(combinedPrompt)
                } else {
                    args.append(
                        "The user's opening message is the exact contents of a generated temp file. Treat those contents as the user's first turn verbatim and respond directly."
                    )
                }
            }
        }
        return TermLoopShell.composeCommand(
            executable: agent.executableName,
            args: args,
            env: [:],
            cwd: cwd
        )
    }

    func disableAbilityPermanently(_ ability: Ability) {
        let alert = NSAlert()
        alert.messageText = String(
            localized: "quickAction.disablePermanently.title",
            defaultValue: "Disable ability “\(ability.name)”?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "quickAction.disablePermanently.bundleBody",
            defaultValue: "This sets activation to off in \(ability.metadataFilePath.lastPathComponent).",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "common.disable",
            defaultValue: "Disable",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        var updated = ability
        updated.activation = .off
        AbilityStore.shared.save(updated)
        refreshPreview()
    }

}

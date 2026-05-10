// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI
import AppKit
import Bonsplit
import Foundation

/// Create-workspace dialog that lets the user pick the terminal agent. Not
/// currently wired to the File > New Workspace menu in Phase A; callers that
/// need an agent-aware create flow (CLI, socket, Phase C polish) can present
/// this sheet directly.
@MainActor
struct NewWorkspaceSheet: View {
    @ObservedObject private var registry = TerminalAgentRegistry.shared
    @State private var worktreePath: String = ""
    @State private var selectedAgentId: String
    @State private var nameOverride: String = ""
    let project: Project?
    let onCreate: (_ worktreePath: String, _ agentId: String, _ name: String?) -> Void
    let onCancel: () -> Void

    init(
        project: Project?,
        onCreate: @escaping (_ worktreePath: String, _ agentId: String, _ name: String?) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.project = project
        self.onCreate = onCreate
        self.onCancel = onCancel
        _selectedAgentId = State(initialValue:
            project?.defaultTerminalAgentId
            ?? TermLoopSettings.shared.defaultTerminalAgentId)
    }

    var resolvedDefaultName: String {
        let base = (worktreePath as NSString).lastPathComponent
        if base.isEmpty { return selectedAgentId }
        return "\(base) (\(selectedAgentId))"
    }

    private var trimmedNameOverride: String {
        nameOverride.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(String(localized: "newWorkspaceSheet.title",
                        defaultValue: "New Workspace", table: "TermLoop"))
                .font(.title2)

            GroupBox(String(localized: "newWorkspaceSheet.worktree",
                            defaultValue: "Worktree", table: "TermLoop")) {
                HStack {
                    TextField(
                        String(localized: "newWorkspaceSheet.worktreePlaceholder",
                               defaultValue: "/path/to/worktree", table: "TermLoop"),
                        text: $worktreePath
                    )
                    Button(String(localized: "newWorkspaceSheet.chooseWorktree",
                                  defaultValue: "Choose…", table: "TermLoop")) {
                        let panel = NSOpenPanel()
                        panel.canChooseDirectories = true
                        panel.canChooseFiles = false
                        if panel.runModal() == .OK, let url = panel.url {
                            worktreePath = url.path
                        }
                    }
                }
            }

            GroupBox(String(localized: "newWorkspaceSheet.agent",
                            defaultValue: "Agent", table: "TermLoop")) {
                Picker("", selection: $selectedAgentId) {
                    ForEach(registry.agents, id: \.id) { a in
                        Label(a.displayName, systemImage: a.icon).tag(a.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
            }

            GroupBox(String(localized: "newWorkspaceSheet.name",
                            defaultValue: "Name", table: "TermLoop")) {
                TextField(resolvedDefaultName, text: $nameOverride)
            }

            HStack {
                Spacer()
                Button(String(localized: "newWorkspaceSheet.cancel",
                              defaultValue: "Cancel", table: "TermLoop")) {
                    onCancel()
                }
                Button(String(localized: "newWorkspaceSheet.create",
                              defaultValue: "Create", table: "TermLoop")) {
                    onCreate(worktreePath, selectedAgentId, trimmedNameOverride)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(worktreePath.isEmpty || trimmedNameOverride.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 480)
    }
}

@MainActor
struct NewWorkspaceWithWorktreeRequest: Identifiable, Equatable {
    let id = UUID()
    let projectId: UUID
    let terminalAgentId: String?
    let sourceWorkspaceId: UUID?
    let migrationSessionReference: WorkspaceSessionReference?
    let initialPrompt: String?
    let systemPrompt: String?
    let templateId: String?
    let promptDocumentIdOverride: String?
    let systemPromptDocumentIdOverride: String?
    let permissionOverride: AgentTemplate.PermissionMode?
    let modelOverride: AgentModelOption?
    let reasoningOverride: AgentReasoningOption?
    let variableValues: [String: String]
    let runOverrides: InstructionRunOverrides
    let launchSource: AgentInvocationSource?
    let reasonTag: String?
    let suggestedBranchName: String?
    let assignedTicket: WorkspaceMetadataStore.AssignedTicket?

    init(
        projectId: UUID,
        terminalAgentId: String?,
        sourceWorkspaceId: UUID? = nil,
        migrationSessionReference: WorkspaceSessionReference? = nil,
        initialPrompt: String? = nil,
        systemPrompt: String? = nil,
        templateId: String? = nil,
        promptDocumentIdOverride: String? = nil,
        systemPromptDocumentIdOverride: String? = nil,
        permissionOverride: AgentTemplate.PermissionMode? = nil,
        modelOverride: AgentModelOption? = nil,
        reasoningOverride: AgentReasoningOption? = nil,
        variableValues: [String: String] = [:],
        runOverrides: InstructionRunOverrides = .none,
        launchSource: AgentInvocationSource? = nil,
        reasonTag: String? = nil,
        suggestedBranchName: String? = nil,
        assignedTicket: WorkspaceMetadataStore.AssignedTicket? = nil
    ) {
        self.projectId = projectId
        self.terminalAgentId = terminalAgentId
        self.sourceWorkspaceId = sourceWorkspaceId
        self.migrationSessionReference = migrationSessionReference
        self.initialPrompt = initialPrompt
        self.systemPrompt = systemPrompt
        self.templateId = templateId
        self.promptDocumentIdOverride = promptDocumentIdOverride
        self.systemPromptDocumentIdOverride = systemPromptDocumentIdOverride
        self.permissionOverride = permissionOverride
        self.modelOverride = modelOverride
        self.reasoningOverride = reasoningOverride
        self.variableValues = variableValues
        self.runOverrides = runOverrides
        self.launchSource = launchSource
        self.reasonTag = reasonTag
        self.suggestedBranchName = suggestedBranchName
        self.assignedTicket = assignedTicket
    }

    var isConversationMigration: Bool {
        sourceWorkspaceId != nil
    }
}

@MainActor
final class NewWorkspaceWithWorktreeCoordinator: ObservableObject {
    static let shared = NewWorkspaceWithWorktreeCoordinator()

    @Published var request: NewWorkspaceWithWorktreeRequest?

    private init() {}

    func present(projectId: UUID, terminalAgentId: String?) {
        present(NewWorkspaceWithWorktreeRequest(
            projectId: projectId,
            terminalAgentId: terminalAgentId
        ))
    }

    func present(_ request: NewWorkspaceWithWorktreeRequest) {
        if request.isConversationMigration {
            self.request = request
            return
        }
        self.request = nil
        QuickActionController.shared.present(
            prefill: QuickActionPresentationRequest(
                initialSurface: .worktree,
                targetWorkspaceId: nil,
                worktreeIntent: .createWorkspace,
                promptText: request.initialPrompt,
                promptDocumentId: request.promptDocumentIdOverride,
                advancedSystemPrompt: request.systemPrompt,
                systemPromptDocumentId: request.systemPromptDocumentIdOverride,
                advancedTerminalAgentId: request.terminalAgentId,
                advancedPermission: request.permissionOverride,
                advancedModel: request.modelOverride,
                advancedReasoning: request.reasoningOverride,
                variableValues: request.variableValues,
                launchSource: request.launchSource,
                reasonTag: request.reasonTag,
                projectId: request.projectId,
                suggestedBranchName: request.suggestedBranchName
            )
        )
    }

    func dismiss() {
        request = nil
    }
}

enum NewWorkspaceWithWorktreeError: Error, LocalizedError {
    case missingProject
    case missingTabManager
    case missingSourceWorkspace
    case invalidBranch
    case pathResolutionFailed
    case branchMatchesMainCheckout(String)
    case dirtySourceCheckout
    case pathOccupiedByOtherWorktree(path: String, branch: String?)
    case orphanQuarantineFailed(path: String, underlying: String)

    var errorDescription: String? {
        switch self {
        case .missingProject:
            return String(
                localized: "workspace.create.error.missingProject",
                defaultValue: "Project context is no longer available.",
                table: "TermLoop"
            )
        case .missingTabManager:
            return String(
                localized: "workspace.create.error.missingTabManager",
                defaultValue: "Workspace could not be created right now.",
                table: "TermLoop"
            )
        case .missingSourceWorkspace:
            return String(
                localized: "workspace.create.error.missingSourceWorkspace",
                defaultValue: "The selected conversation is no longer available.",
                table: "TermLoop"
            )
        case .invalidBranch:
            return String(
                localized: "workspace.worktree.error.invalidBranch",
                defaultValue: "Branch name cannot be empty.",
                table: "TermLoop"
            )
        case .pathResolutionFailed:
            return String(
                localized: "workspace.worktree.error.pathResolution",
                defaultValue: "Worktree path could not be resolved.",
                table: "TermLoop"
            )
        case .branchMatchesMainCheckout(let branch):
            let format = String(
                localized: "workspace.worktree.error.mainBranchConflict",
                defaultValue: "“%@” is already the main checkout branch. Choose a different branch.",
                table: "TermLoop"
            )
            return String.localizedStringWithFormat(format, branch)
        case .dirtySourceCheckout:
            return String(
                localized: "workspace.worktree.error.dirtySource",
                defaultValue: "The project checkout has uncommitted changes. Commit, stash, or clean them before creating a worktree.",
                table: "TermLoop"
            )
        case .pathOccupiedByOtherWorktree(let path, let branch):
            let format = String(
                localized: "workspace.worktree.error.pathOccupied",
                defaultValue: "“%@” is already used by a worktree on “%@”. Remove or rename that worktree before reusing this path.",
                table: "TermLoop"
            )
            return String.localizedStringWithFormat(format, path, branch ?? "detached HEAD")
        case .orphanQuarantineFailed(let path, let underlying):
            let format = String(
                localized: "workspace.worktree.error.orphanQuarantine",
                defaultValue: "Could not move the existing directory “%@” aside to reuse the worktree (%@). Move it manually and retry.",
                table: "TermLoop"
            )
            return String.localizedStringWithFormat(format, path, underlying)
        }
    }
}

@MainActor
struct NewWorkspaceWithWorktreeSheet: View {
    let request: NewWorkspaceWithWorktreeRequest
    weak var tabManager: TabManager?

    var body: some View {
        NewWorkspaceWithWorktreeForm(
            request: request,
            tabManager: tabManager,
            showsTitle: true,
            showsCancelButton: true,
            onCancel: { NewWorkspaceWithWorktreeCoordinator.shared.dismiss() },
            onSuccess: { NewWorkspaceWithWorktreeCoordinator.shared.dismiss() }
        )
        .frame(width: 560)
    }
}

@MainActor
struct NewWorkspaceWithWorktreeForm: View {
    struct Creation {
        let workspace: Workspace
        let branch: String
        let worktreePath: String
        let createdWorktree: Bool
    }

    let request: NewWorkspaceWithWorktreeRequest
    weak var tabManager: TabManager?
    private let externalBranchName: Binding<String>?
    var showsTitle: Bool = true
    var showsCancelButton: Bool = true
    var showsPromptEditors: Bool = true
    var showsAgentPickerControl: Bool = true
    var activatesWorkspaceOnSuccess: Bool = true
    var contentPadding: CGFloat = 20
    var externalSubmitToken: Int = 0
    var onWorkspaceCreated: (Creation) throws -> Void = { _ in }
    var onCancel: () -> Void = {}
    var onSuccess: () -> Void = {}

    @ObservedObject private var registry = TerminalAgentRegistry.shared
    @State private var branchName: String = ""
    @State private var selectedAgentId: String
    @State private var selectedBaseRef: String = "HEAD"
    @State private var availableBaseRefs: [String] = ["HEAD"]
    @State private var isLoadingBaseRefs = false
    @State private var isCreating = false
    @State private var sourceCheckoutIsDirty = false
    @State private var allowDirtySourceCheckout = false
    @State private var errorMessage: String?
    @State private var initialPromptText: String
    @State private var systemPromptText: String

    init(
        request: NewWorkspaceWithWorktreeRequest,
        tabManager: TabManager?,
        branchName: Binding<String>? = nil,
        showsTitle: Bool = true,
        showsCancelButton: Bool = true,
        showsPromptEditors: Bool = true,
        showsAgentPickerControl: Bool = true,
        activatesWorkspaceOnSuccess: Bool = true,
        contentPadding: CGFloat = 20,
        externalSubmitToken: Int = 0,
        onWorkspaceCreated: @escaping (Creation) throws -> Void = { _ in },
        onCancel: @escaping () -> Void = {},
        onSuccess: @escaping () -> Void = {}
    ) {
        self.request = request
        self.tabManager = tabManager
        self.externalBranchName = branchName
        self.showsTitle = showsTitle
        self.showsCancelButton = showsCancelButton
        self.showsPromptEditors = showsPromptEditors
        self.showsAgentPickerControl = showsAgentPickerControl
        self.activatesWorkspaceOnSuccess = activatesWorkspaceOnSuccess
        self.contentPadding = contentPadding
        self.externalSubmitToken = externalSubmitToken
        self.onWorkspaceCreated = onWorkspaceCreated
        self.onCancel = onCancel
        self.onSuccess = onSuccess
        _branchName = State(initialValue: branchName?.wrappedValue ?? request.suggestedBranchName ?? "")
        _selectedAgentId = State(initialValue: Self.initialSelectedAgentId(for: request))
        _initialPromptText = State(initialValue: request.initialPrompt ?? "")
        _systemPromptText = State(initialValue: request.systemPrompt ?? "")
    }

    private var project: Project? {
        ProjectStore.shared.project(id: request.projectId)
    }

    private var showsAgentPicker: Bool {
        showsAgentPickerControl
            && !request.isConversationMigration
            && request.terminalAgentId != nil
            && !registry.agents.isEmpty
    }

    // Migration flows are restoring a conversation — their prompts are
    // replay state, not authored text. Callers can also hide prompt
    // editors when prompt authoring already happens in a parent surface.
    private var effectiveShowsPromptEditors: Bool {
        showsPromptEditors && !request.isConversationMigration
    }

    private var selectedAgent: TerminalAgent? {
        if let found = registry.agent(id: selectedAgentId) {
            return found
        }
        if let global = registry.agent(id: TermLoopSettings.shared.defaultTerminalAgentId) {
            return global
        }
        return registry.agents.first
    }

    private var branchNameBinding: Binding<String> {
        externalBranchName ?? $branchName
    }

    private var trimmedBranchName: String {
        branchNameBinding.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var titleText: String {
        if request.isConversationMigration {
            return String(
                localized: "workspace.worktree.sheet.migrateTitle",
                defaultValue: "Move Conversation to Worktree",
                table: "TermLoop"
            )
        }
        return String(
            localized: "workspace.worktree.sheet.title",
            defaultValue: "New Workspace with Worktree",
            table: "TermLoop"
        )
    }

    private var createButtonText: String {
        if request.isConversationMigration {
            return String(
                localized: "workspace.worktree.sheet.move",
                defaultValue: "Move",
                table: "TermLoop"
            )
        }
        return String(
            localized: "newWorkspaceSheet.create",
            defaultValue: "Create",
            table: "TermLoop"
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if showsTitle {
                Text(titleText)
                .font(.title2)
            }

            GroupBox(String(
                localized: "workspace.worktree.sheet.branch",
                defaultValue: "Branch",
                table: "TermLoop"
            )) {
                TextField(
                    String(
                        localized: "workspace.worktree.sheet.branchPlaceholder",
                        defaultValue: "feature/your-branch",
                        table: "TermLoop"
                    ),
                    text: branchNameBinding
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            GroupBox(String(
                localized: "workspace.worktree.sheet.baseRef",
                defaultValue: "Base Ref",
                table: "TermLoop"
            )) {
                Picker("", selection: $selectedBaseRef) {
                    ForEach(availableBaseRefs, id: \.self) { ref in
                        Text(ref).tag(ref)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()

                if isLoadingBaseRefs {
                    Text(String(
                        localized: "workspace.worktree.sheet.loadingRefs",
                        defaultValue: "Loading branches…",
                        table: "TermLoop"
                    ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if showsAgentPicker, let agent = selectedAgent {
                GroupBox(String(
                    localized: "newWorkspaceSheet.agent",
                    defaultValue: "Agent",
                    table: "TermLoop"
                )) {
                    Picker("", selection: $selectedAgentId) {
                        ForEach(registry.agents, id: \.id) { candidate in
                            Label(candidate.displayName, systemImage: candidate.icon)
                                .tag(candidate.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .help(agent.displayName)
                }
            }

            if effectiveShowsPromptEditors {
                GroupBox(String(
                    localized: "workspace.worktree.sheet.initialPrompt",
                    defaultValue: "Initial Prompt",
                    table: "TermLoop"
                )) {
                    PromptTextEditor(text: $initialPromptText, minHeight: 72, maxHeight: 160)
                }
                GroupBox(String(
                    localized: "workspace.worktree.sheet.systemPrompt",
                    defaultValue: "System Prompt",
                    table: "TermLoop"
                )) {
                    PromptTextEditor(text: $systemPromptText, minHeight: 72, maxHeight: 160)
                }
            }

            if sourceCheckoutIsDirty {
                VStack(alignment: .leading, spacing: 8) {
                    Toggle(
                        String(
                            localized: "workspace.worktree.sheet.allowDirtyToggle",
                            defaultValue: "Create from HEAD only and leave local changes in the current checkout",
                            table: "TermLoop"
                        ),
                        isOn: $allowDirtySourceCheckout
                    )

                    Text(String(
                        localized: "workspace.worktree.sheet.allowDirtyHelp",
                        defaultValue: "Uncommitted changes do not move into the new worktree. This can include modified files, untracked files, or a changed submodule pointer in the parent repo.",
                        table: "TermLoop"
                    ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let errorMessage, !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                if showsCancelButton {
                    Button(String(
                        localized: "newWorkspaceSheet.cancel",
                        defaultValue: "Cancel",
                        table: "TermLoop"
                    )) {
                        onCancel()
                    }
                    .disabled(isCreating)
                }

                Button(createButtonText) {
                    createWorkspace()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(trimmedBranchName.isEmpty || isCreating)
            }
        }
        .padding(contentPadding)
        .task(id: request.projectId) {
            loadBaseRefs()
            refreshDirtyState()
        }
        .onChange(of: externalSubmitToken) { _, newValue in
            guard newValue > 0 else { return }
            createWorkspace()
        }
    }

    private func loadBaseRefs() {
        guard let project else { return }
        isLoadingBaseRefs = true
        let projectFolder = project.folderPath
        DispatchQueue.global(qos: .userInitiated).async {
            let refs: [String]
            let selected: String
            do {
                let branches = try GitWorktreeService().branches(in: projectFolder)
                let sorted = branches.sorted { lhs, rhs in
                    if lhs.isCurrent != rhs.isCurrent {
                        return lhs.isCurrent && !rhs.isCurrent
                    }
                    return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
                }
                refs = sorted.map(\.name)
                selected = sorted.first(where: \.isCurrent)?.name ?? refs.first ?? "HEAD"
            } catch {
                refs = ["HEAD"]
                selected = "HEAD"
            }

            DispatchQueue.main.async {
                availableBaseRefs = refs.isEmpty ? ["HEAD"] : refs
                selectedBaseRef = availableBaseRefs.contains(selected)
                    ? selected
                    : (availableBaseRefs.first ?? "HEAD")
                isLoadingBaseRefs = false
            }
        }
    }

    private func refreshDirtyState() {
        guard let project else { return }
        let projectFolder = project.folderPath
        DispatchQueue.global(qos: .utility).async {
            let isDirty: Bool
            do {
                isDirty = !(try GitWorktreeService().isClean(worktreePath: projectFolder))
            } catch {
                isDirty = false
            }
            DispatchQueue.main.async {
                sourceCheckoutIsDirty = isDirty
                if !isDirty {
                    allowDirtySourceCheckout = false
                }
            }
        }
    }

    private func createWorkspace() {
        guard !isCreating else { return }
        guard let project else {
            errorMessage = NewWorkspaceWithWorktreeError.missingProject.errorDescription
            return
        }

        errorMessage = nil
        isCreating = true

        let branch = trimmedBranchName
        let selectedBaseRef = self.selectedBaseRef
        let request = self.request
        let projectFolder = project.folderPath
        let allowDirtySourceCheckout = self.allowDirtySourceCheckout
        let selectedAgentId = showsAgentPicker
            ? self.selectedAgentId.trimmingCharacters(in: .whitespacesAndNewlines)
            : request.terminalAgentId
        let resolvedInitialPrompt: String = {
            guard effectiveShowsPromptEditors else { return request.initialPrompt ?? "" }
            return initialPromptText
        }()
        let resolvedSystemPrompt: String? = {
            guard effectiveShowsPromptEditors else { return request.systemPrompt }
            let trimmed = systemPromptText.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : systemPromptText
        }()

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let prepared = try Self.prepareWorktree(
                    projectFolder: projectFolder,
                    branch: branch,
                    baseRef: selectedBaseRef,
                    allowDirtySourceCheckout: allowDirtySourceCheckout
                )

                DispatchQueue.main.async {
                    guard let tabManager = self.tabManager else {
                        if prepared.createdWorktree {
                            DispatchQueue.global(qos: .utility).async {
                                try? GitWorktreeService().remove(
                                    folder: projectFolder,
                                    path: prepared.path
                                )
                            }
                        }
                        self.errorMessage = NewWorkspaceWithWorktreeError
                            .missingTabManager
                            .errorDescription
                        self.isCreating = false
                        return
                    }

                    do {
                        if let sourceWorkspaceId = request.sourceWorkspaceId {
                            guard let sourceWorkspace = tabManager.tabs.first(where: {
                                $0.id == sourceWorkspaceId
                            }) else {
                                throw NewWorkspaceWithWorktreeError.missingSourceWorkspace
                            }
                            _ = try WorktreeCoordinator.shared.migrateWorkspaceToPreparedWorktree(
                                workspace: sourceWorkspace,
                                branch: branch,
                                path: prepared.path,
                                baselineHead: prepared.baselineHead,
                                sessionReference: request.migrationSessionReference
                            )
                        } else {
                            let workspace: Workspace
                            if let agentId = selectedAgentId,
                               let agent = TerminalAgentRegistry.shared.agent(id: agentId) {
                                if let plan = try self.resolvePlanForPreparedWorktree(
                                    request: request,
                                    prepared: prepared,
                                    branch: branch,
                                    selectedAgentId: agentId,
                                    authoredPrompt: resolvedInitialPrompt,
                                    authoredSystemPrompt: resolvedSystemPrompt
                                ) {
                                    workspace = try TerminalAgentLifecycle.createFreshWorkspace(
                                        tabManager: tabManager,
                                        plan: plan,
                                        title: branch,
                                        worktreeExpectation: TermLoopWorktreeExpectation(
                                            path: prepared.path,
                                            branch: branch
                                        ),
                                        baselineHead: prepared.baselineHead
                                    )
                                } else {
                                    workspace = try TerminalAgentLifecycle.createFreshWorkspace(
                                        tabManager: tabManager,
                                        agent: agent,
                                        title: branch,
                                        cwd: prepared.path,
                                        worktreeExpectation: TermLoopWorktreeExpectation(
                                            path: prepared.path,
                                            branch: branch
                                        ),
                                        baselineHead: prepared.baselineHead,
                                        initialPrompt: resolvedInitialPrompt,
                                        projectId: request.projectId,
                                        permission: nil,
                                        systemPrompt: resolvedSystemPrompt
                                    )
                                }
                            } else {
                                workspace = tabManager.addWorkspace(
                                    title: branch,
                                    workingDirectory: prepared.path,
                                    select: activatesWorkspaceOnSuccess,
                                    autoWelcomeIfNeeded: activatesWorkspaceOnSuccess,
                                    projectId: request.projectId,
                                    terminalAgentId: selectedAgentId
                                )
                                if selectedAgentId == nil {
                                    WorkspaceMetadataStore.shared.setTerminalAgentId(nil, for: workspace.id)
                                }
                            }
                            // The agent path writes branch + baselineHead inside
                            // Lifecycle.createFreshWorkspace; the non-agent addWorkspace
                            // fallback still needs explicit writes.
                            let resolvedAgent = selectedAgentId.flatMap {
                                TerminalAgentRegistry.shared.agent(id: $0)
                            }
                            if resolvedAgent == nil {
                                WorkspaceMetadataStore.shared.setBranch(
                                    branch,
                                    worktreePath: prepared.path,
                                    for: workspace
                                )
                                WorkspaceMetadataStore.shared.setWorktreeBaselineHead(
                                    prepared.baselineHead,
                                    forWorkspaceId: workspace.id
                                )
                            }
                            do {
                                try self.onWorkspaceCreated(Creation(
                                    workspace: workspace,
                                    branch: branch,
                                    worktreePath: prepared.path,
                                    createdWorktree: prepared.createdWorktree
                                ))
                            } catch {
                                tabManager.closeWorkspace(workspace)
                                _ = WorkspaceMetadataStore.shared.removeMetadataForId(workspace.id)
                                if prepared.createdWorktree {
                                    DispatchQueue.global(qos: .utility).async {
                                        try? GitWorktreeService().remove(
                                            folder: projectFolder,
                                            path: prepared.path
                                        )
                                    }
                                }
                                self.errorMessage = (error as? LocalizedError)?.errorDescription
                                    ?? error.localizedDescription
                                self.isCreating = false
                                return
                            }
                            persistAssignedTicket(for: workspace, worktreePath: prepared.path)
                            if activatesWorkspaceOnSuccess {
                                WorktreeAgentsPanelState.reveal(branch: branch)
                                MainAreaActivation.activateWorkspaceTerminal(workspace.id, on: tabManager)
                            }
                            AppDelegate.shared?.saveSessionSnapshot(
                                includeScrollback: false,
                                forceSync: true
                            )

                            if prepared.createdWorktree
                                || SubmoduleInitService.hasUninitializedSubmodules(
                                    worktreePath: prepared.path
                                ) {
                                SubmoduleInitService.startInBackground(
                                    worktreePath: prepared.path,
                                    displayLabel: branch,
                                    branch: branch,
                                    workspaceId: workspace.id
                                )
                            }
                        }

                        self.isCreating = false
                        self.onSuccess()
                    } catch {
                        if prepared.createdWorktree {
                            DispatchQueue.global(qos: .utility).async {
                                try? GitWorktreeService().remove(
                                    folder: projectFolder,
                                    path: prepared.path
                                )
                            }
                        }
                        self.errorMessage = (error as? LocalizedError)?.errorDescription
                            ?? error.localizedDescription
                        self.isCreating = false
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.errorMessage = (error as? LocalizedError)?.errorDescription
                        ?? error.localizedDescription
                    self.isCreating = false
                }
            }
        }
    }

    private func persistAssignedTicket(for workspace: Workspace, worktreePath: String) {
        let metadata = WorkspaceMetadataStore.shared
        metadata.setAssignedTicket(request.assignedTicket, for: workspace)

        guard let ticket = request.assignedTicket,
              ticket.providerName.caseInsensitiveCompare("Jira") == .orderedSame else {
            return
        }
        let binding = AgentReportedStateStore.AgentReportedBinding(
            abilityId: TermLoopBuiltInMCP.jiraAbilityId,
            bindingId: JiraTicketBindingPrompt.bindingId,
            label: ticket.key,
            status: nonEmpty(ticket.status),
            url: nonEmpty(ticket.url),
            reportedAt: Date()
        )
        _ = metadata.setReportedBinding(
            binding,
            abilityId: TermLoopBuiltInMCP.jiraAbilityId,
            bindingId: JiraTicketBindingPrompt.bindingId,
            forWorkspaceId: workspace.id,
            fallbackPath: worktreePath
        )
    }

    private func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func resolvePlanForPreparedWorktree(
        request: NewWorkspaceWithWorktreeRequest,
        prepared: PreparedWorktree,
        branch: String,
        selectedAgentId: String,
        authoredPrompt: String,
        authoredSystemPrompt: String?
    ) throws -> AgentInvocationPlan? {
        let preparedURL = URL(fileURLWithPath: prepared.path, isDirectory: true)
        let projectFolderPath = ProjectStore.shared.project(id: request.projectId)?.folderPath
        let repoRootPath = projectFolderPath ?? prepared.path
        let trimmedPrompt = authoredPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSystem = authoredSystemPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        let invocation: AgentInvocationRequest
        if let templateId = request.templateId {
            guard let template = AgentTemplateStore.shared.template(id: templateId) else {
                throw QuickActionError.noTemplate
            }
            let context = QuickActionRunResolver.ResolvedContext(
                workspaceId: nil,
                projectId: request.projectId,
                workspaceCwd: preparedURL,
                branchName: branch,
                repoRootPath: repoRootPath
            )
            invocation = try QuickActionRunResolver.resolve(
                template: template,
                context: context,
                agentId: selectedAgentId,
                promptOverride: trimmedPrompt.isEmpty ? nil : authoredPrompt,
                promptDocumentIdOverride: request.promptDocumentIdOverride,
                permissionOverride: request.permissionOverride,
                variableOverrides: request.variableValues,
                source: request.launchSource ?? .manualWorkspaceCreate,
                modelOverride: request.modelOverride,
                reasoningOverride: request.reasoningOverride,
                systemPromptOverride: trimmedSystem.isEmpty ? nil : authoredSystemPrompt,
                systemPromptDocumentIdOverride: request.systemPromptDocumentIdOverride,
                reasonTag: request.reasonTag
            )
        } else {
            invocation = AgentInvocationRequest(
                agentId: selectedAgentId,
                userPrompt: trimmedPrompt.isEmpty ? nil : authoredPrompt,
                workspaceId: nil,
                projectId: request.projectId,
                runCwd: preparedURL,
                branchName: branch,
                repoRootPath: repoRootPath,
                promptDocumentIdOverride: request.promptDocumentIdOverride,
                systemPromptOverride: trimmedSystem.isEmpty ? nil : authoredSystemPrompt,
                systemPromptDocumentIdOverride: request.systemPromptDocumentIdOverride,
                permissionOverride: request.permissionOverride,
                modelOverride: request.modelOverride,
                reasoningOverride: request.reasoningOverride,
                variableValues: request.variableValues,
                source: request.launchSource ?? .manualWorkspaceCreate,
                reasonTag: request.reasonTag
            )
        }
        return try AgentInvocationComposer.compose(
            invocation,
            overrides: request.runOverrides
        )
    }

    private struct PreparedWorktree {
        let path: String
        let baselineHead: String?
        let createdWorktree: Bool
    }

    nonisolated private static func prepareWorktree(
        projectFolder: String,
        branch: String,
        baseRef: String,
        allowDirtySourceCheckout: Bool
    ) throws -> PreparedWorktree {
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBranch.isEmpty else {
            throw NewWorkspaceWithWorktreeError.invalidBranch
        }
        guard let resolvedPath = WorktreeResolver.path(
            projectFolder: projectFolder,
            branch: trimmedBranch
        ) else {
            throw NewWorkspaceWithWorktreeError.pathResolutionFailed
        }

        let service = GitWorktreeService()
        var worktrees = try service.list(in: projectFolder)

        if let main = worktrees.first(where: { $0.isMain }),
           main.branch == trimmedBranch {
            throw NewWorkspaceWithWorktreeError
                .branchMatchesMainCheckout(trimmedBranch)
        }

        let normalizedResolvedPath = URL(fileURLWithPath: resolvedPath).standardizedFileURL.path

        enum PathMatch {
            case safeReuse(GitWorktreeService.ListEntry)
            case collision(GitWorktreeService.ListEntry)
            case none
        }

        // Branch match: identical-ref entries are always safe to reuse.
        // Path match: only reuse when it's clearly the same logical state —
        // explicit branch equality, or detached HEAD already at this branch's
        // tip. Anything else at the deterministic path is a real collision
        // that we surface instead of silently handing the user a worktree on
        // the wrong commit.
        func classify(_ entries: [GitWorktreeService.ListEntry]) -> PathMatch {
            if let byBranch = entries.first(where: { $0.branch == trimmedBranch }) {
                return .safeReuse(byBranch)
            }
            guard let byPath = entries.first(where: {
                URL(fileURLWithPath: $0.path).standardizedFileURL.path
                    == normalizedResolvedPath
            }) else {
                return .none
            }
            if byPath.branch == trimmedBranch {
                return .safeReuse(byPath)
            }
            if byPath.branch == nil,
               let tip = service.branchTipRevision(folder: projectFolder, branch: trimmedBranch),
               tip == byPath.head {
                return .safeReuse(byPath)
            }
            return .collision(byPath)
        }

        func prepared(from entry: GitWorktreeService.ListEntry) -> PreparedWorktree {
            PreparedWorktree(
                path: entry.path,
                baselineHead: try? service.headRevision(worktreePath: entry.path),
                createdWorktree: false
            )
        }

        switch classify(worktrees) {
        case .safeReuse(let entry):
            return prepared(from: entry)
        case .collision(let entry):
            throw NewWorkspaceWithWorktreeError
                .pathOccupiedByOtherWorktree(path: entry.path, branch: entry.branch)
        case .none:
            break
        }

        // The directory may exist on disk without a matching `git worktree
        // list` entry — half-cleaned removal, crashed prior creation, or a
        // sibling tool registered/unregistered it. Try recovery in this
        // order: repair (re-attach worktrees with intact `.git` linkers
        // first, since `prune` can wipe the metadata `repair` would consult)
        // → list → match → prune (drop stale registrations) → list → match.
        var quarantinedFromPath: String? = nil
        if FileManager.default.fileExists(atPath: resolvedPath) {
            do {
                try service.repair(folder: projectFolder, paths: [resolvedPath])
                worktrees = try service.list(in: projectFolder)
                switch classify(worktrees) {
                case .safeReuse(let entry):
                    return prepared(from: entry)
                case .collision(let entry):
                    throw NewWorkspaceWithWorktreeError
                        .pathOccupiedByOtherWorktree(path: entry.path, branch: entry.branch)
                case .none:
                    break
                }
            } catch let error as NewWorkspaceWithWorktreeError {
                throw error
            } catch {
                // Repair couldn't help. Carry on; prune may still recover
                // a stale registration.
            }

            do {
                try service.prune(folder: projectFolder)
                worktrees = try service.list(in: projectFolder)
                switch classify(worktrees) {
                case .safeReuse(let entry):
                    return prepared(from: entry)
                case .collision(let entry):
                    throw NewWorkspaceWithWorktreeError
                        .pathOccupiedByOtherWorktree(path: entry.path, branch: entry.branch)
                case .none:
                    break
                }
            } catch let error as NewWorkspaceWithWorktreeError {
                throw error
            } catch {
                // Prune failed for a non-collision reason (transient git
                // issue, permissions). Don't proceed to a destructive step
                // when we can't even read git's state cleanly — surface a
                // clear collision-style error so the user can intervene.
                throw NewWorkspaceWithWorktreeError
                    .pathOccupiedByOtherWorktree(path: resolvedPath, branch: nil)
            }

            // Path on disk, no matching entry, repair/prune couldn't recover.
            // Move it aside (with a timestamp) instead of deleting it: the
            // user keeps full access to whatever was there, and we can roll
            // back on `git worktree add` failure. Do NOT swallow the move
            // failure — falling through silently would let the destructive
            // intent run while masking real errors (permissions, etc).
            let quarantinePath = "\(resolvedPath).orphaned-\(Int(Date().timeIntervalSince1970))"
            do {
                try FileManager.default.moveItem(atPath: resolvedPath, toPath: quarantinePath)
                quarantinedFromPath = quarantinePath
            } catch {
                throw NewWorkspaceWithWorktreeError
                    .orphanQuarantineFailed(
                        path: resolvedPath,
                        underlying: error.localizedDescription
                    )
            }
        }

        if !allowDirtySourceCheckout {
            guard try service.isClean(worktreePath: projectFolder) else {
                throw NewWorkspaceWithWorktreeError.dirtySourceCheckout
            }
        }

        let branchExists = try service.branches(in: projectFolder)
            .contains(where: { $0.name == trimmedBranch })

        do {
            if branchExists {
                try service.add(
                    folder: projectFolder,
                    path: resolvedPath,
                    branch: trimmedBranch
                )
            } else {
                try service.addCreatingBranch(
                    folder: projectFolder,
                    path: resolvedPath,
                    branch: trimmedBranch,
                    baseRef: baseRef.isEmpty ? "HEAD" : baseRef
                )
            }
        } catch {
            // Add failed after we quarantined an existing on-disk directory:
            // restore it so the user's data ends up back where they expected
            // and they can investigate. We only roll back when the target
            // path is still free — if `git worktree add` partially created
            // something at the resolved path, leave both copies and surface
            // the original error rather than overwriting partial state.
            if let quarantined = quarantinedFromPath,
               !FileManager.default.fileExists(atPath: resolvedPath) {
                try? FileManager.default.moveItem(
                    atPath: quarantined,
                    toPath: resolvedPath
                )
            }
            throw error
        }

        return PreparedWorktree(
            path: resolvedPath,
            baselineHead: try? service.headRevision(worktreePath: resolvedPath),
            createdWorktree: true
        )
    }

    private static func initialSelectedAgentId(for request: NewWorkspaceWithWorktreeRequest) -> String {
        if let explicit = request.terminalAgentId,
           TerminalAgentRegistry.shared.agent(id: explicit) != nil {
            return explicit
        }
        if let global = TerminalAgentRegistry.shared
            .agent(id: TermLoopSettings.shared.defaultTerminalAgentId)?.id {
            return global
        }
        return TerminalAgentRegistry.shared.agents.first?.id ?? request.terminalAgentId ?? ""
    }
}

@MainActor
struct SidebarWorkspaceAddMenu: View {
    let projectId: UUID
    let prepare: () -> Void

    @ObservedObject private var registry = TerminalAgentRegistry.shared
    @AppStorage("termloop.defaultTerminalAgentId") private var defaultAgentId: String = "claude"

    private var resolvedDefaultAgent: TerminalAgent? {
        registry.agent(id: defaultAgentId) ?? registry.agents.first
    }

    private var addDefaultWithWorktreeTitle: String {
        let format = String(
            localized: "sidebar.addMenu.createDefaultWithWorktree.format",
            defaultValue: "Add %@ with Worktree",
            table: "TermLoop"
        )
        return String.localizedStringWithFormat(
            format,
            resolvedDefaultAgent?.displayName ?? defaultAgentId
        )
    }

    private func addAgentLabel(for agent: TerminalAgent) -> String {
        let format = String(
            localized: "sidebar.addMenu.addAgent.format",
            defaultValue: "Add %@",
            table: "TermLoop"
        )
        return String.localizedStringWithFormat(format, agent.displayName)
    }

    private func fastCreate(
        agent: TerminalAgent,
        mode: AgentTemplate.PermissionMode
    ) {
        guard let tabManager = AppDelegate.shared?.tabManager else { return }
        prepare()
        do {
            try SidebarInlineCreateCoordinator.shared.fastCreateWorkspace(
                agent: agent,
                mode: mode,
                projectId: projectId,
                tabManager: tabManager
            )
        } catch {
            #if DEBUG
            dlog("sidebar.addAgent fast-create failed for \(agent.id): \(error). Falling back to inline rename.")
            #endif
            SidebarInlineCreateCoordinator.shared.beginWorkspace(
                projectId: projectId,
                terminalAgentId: agent.id
            )
        }
    }

    @ViewBuilder
    private func agentMenu(for agent: TerminalAgent) -> some View {
        let modes = PermissionModeCatalog.surfaceableModes(forAgentId: agent.id)
        let label = Label(addAgentLabel(for: agent), systemImage: agent.icon)
        if modes.isEmpty {
            Button {
                fastCreate(agent: agent, mode: .bypassPermissions)
            } label: { label }
        } else {
            let lastMode = PermissionModePersistence.lastUsedMode(forAgentId: agent.id)
                ?? modes[0].mode
            Menu {
                ForEach(modes) { option in
                    Button {
                        fastCreate(agent: agent, mode: option.mode)
                    } label: {
                        Text(option.title)
                    }
                }
            } label: { label }
            primaryAction: {
                fastCreate(agent: agent, mode: lastMode)
            }
        }
    }

    var body: some View {
        ForEach(registry.agents, id: \.id) { agent in
            agentMenu(for: agent)
        }

        Divider()

        Button(addDefaultWithWorktreeTitle) {
            prepare()
            NewWorkspaceWithWorktreeCoordinator.shared.present(
                projectId: projectId,
                terminalAgentId: resolvedDefaultAgent?.id
            )
        }

        Divider()

        Menu(String(
            localized: "sidebar.addMenu.defaultAgent",
            defaultValue: "Default Agent",
            table: "TermLoop"
        )) {
            ForEach(registry.agents, id: \.id) { agent in
                Button {
                    defaultAgentId = agent.id
                } label: {
                    Label(
                        agent.displayName,
                        systemImage: agent.id == defaultAgentId ? "checkmark" : agent.icon
                    )
                }
            }
        }
    }
}

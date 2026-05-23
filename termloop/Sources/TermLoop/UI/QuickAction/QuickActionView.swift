// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct QuickActionView: View {
    @ObservedObject var viewModel: QuickActionViewModel
    var onDismiss: () -> Void
    var onWorktreeCreated: () -> Void

    @State private var composerFocused: Bool = true
    @State private var worktreeSubmitToken: Int = 0

    var body: some View {
        ZStack(alignment: .topLeading) {
            mainStack
            if viewModel.isDropdownOpen {
                dropdownOverlay
                    .transition(.opacity)
                    .zIndex(5)
            }
        }
        .frame(width: QuickActionPanel.canonicalWidth)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.regularMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
        )
        .background(alignment: .topLeading) {
            Button("", action: handleEscape)
                .keyboardShortcut(.cancelAction)
                .labelsHidden()
                .frame(width: 0, height: 0)
                .opacity(0)
                .allowsHitTesting(false)
        }
        .animation(.easeInOut(duration: 0.12), value: viewModel.isDropdownOpen)
        .animation(.easeInOut(duration: 0.12), value: viewModel.isAdvancedOpen)
    }

    private var mainStack: some View {
        VStack(alignment: .leading, spacing: 0) {
            QuickActionTopBar(
                viewModel: viewModel,
                onTapTemplatePicker: { viewModel.openTemplateDropdown() }
            )
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            surfacePicker
                .padding(.horizontal, 12)
                .padding(.vertical, 8)

            Divider()

            Group {
                switch viewModel.activeSurface {
                case .run:
                    runSurface
                case .worktree:
                    worktreeSurface
                }
            }
        }
    }

    private var surfacePicker: some View {
        Picker("", selection: $viewModel.activeSurface) {
            Text(String(
                localized: "quickAction.surface.run",
                defaultValue: "Run",
                table: "TermLoop"
            ))
            .tag(QuickActionSurface.run)
            Text(String(
                localized: "quickAction.surface.worktree",
                defaultValue: "Worktree",
                table: "TermLoop"
            ))
            .tag(QuickActionSurface.worktree)
        }
        .pickerStyle(.segmented)
    }

    private var runSurface: some View {
        VStack(alignment: .leading, spacing: 0) {
            titleField
                .padding(.horizontal, 12)
                .padding(.top, 6)

            runComposerSection
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

            if viewModel.shouldShowRunCompositionSummary {
                runCompositionSummary
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            }

            Divider()

            toolbarStrip
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

            Divider()
            previewBar

            if let err = viewModel.errorMessage {
                Text(err)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal, 14)
                    .padding(.top, 4)
                    .padding(.bottom, 2)
            }

            if viewModel.isAdvancedOpen {
                Divider()
                QuickActionAdvancedTabs(viewModel: viewModel)
            }

            Divider()
            footer
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private var worktreeSurface: some View {
        switch viewModel.worktreeIntent {
        case .createWorkspace:
            worktreeCreateSurface
        case .migrateConversationIfPossible:
            worktreeMigrationSurface
        }
    }

    private var worktreeCreateSurface: some View {
        VStack(alignment: .leading, spacing: 0) {
            titleField
                .padding(.horizontal, 12)
                .padding(.top, 6)

            worktreeComposerSection
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

            if viewModel.shouldShowRunCompositionSummary {
                runCompositionSummary
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            }

            Divider()

            toolbarStrip
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

            Divider()
            previewBar

            if viewModel.isAdvancedOpen {
                Divider()
                QuickActionAdvancedTabs(
                    viewModel: viewModel,
                    settingsPrimaryAction: submitWorktreeFromComposer,
                    settingsPrimaryLabel: String(
                        localized: "quickAction.advanced.createWorktree",
                        defaultValue: "Create worktree",
                        table: "TermLoop"
                    ),
                    settingsPrimaryIcon: "arrow.triangle.branch"
                )
            }

            Divider()
            worktreeCreateForm
                .padding(.horizontal, 12)
                .padding(.vertical, 10)

            Divider()
            worktreeFooter
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
        }
    }

    private var worktreeMigrationSurface: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch worktreeRequestState {
            case .success(let request):
                NewWorkspaceWithWorktreeForm(
                    request: request,
                    tabManager: AppDelegate.shared?.tabManager,
                    showsTitle: false,
                    showsCancelButton: false,
                    showsPromptEditors: false,
                    externalSubmitToken: worktreeSubmitToken,
                    onCancel: {},
                    onSuccess: onWorktreeCreated
                )
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            case .failure(let error):
                Text(error.localizedDescription)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 14)
            }

            Divider()
            worktreeFooter
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private var worktreeCreateForm: some View {
        switch worktreeRequestState {
        case .success(let request):
            NewWorkspaceWithWorktreeForm(
                request: request,
                tabManager: AppDelegate.shared?.tabManager,
                branchName: $viewModel.worktreeBranchName,
                showsTitle: false,
                showsCancelButton: false,
                showsPromptEditors: false,
                showsAgentPickerControl: false,
                contentPadding: 0,
                externalSubmitToken: worktreeSubmitToken,
                onCancel: {},
                onSuccess: handleWorktreeCreated
            )
        case .failure(let error):
            Text(error.localizedDescription)
                .font(.caption)
                .foregroundColor(.red)
                .padding(.horizontal, 2)
                .padding(.vertical, 4)
        }
    }

    private var worktreeRequestState: Result<NewWorkspaceWithWorktreeRequest, Error> {
        Result { try viewModel.newWorktreeRequest() }
    }

    private var previewBar: some View {
        QuickActionPreviewBar(
            preview: viewModel.preview,
            hasTarget: viewModel.runTarget != .detached
                || viewModel.sourceSessionId != nil
                || ProjectStore.shared.activeProjectId != nil,
            onOpenAdvancedPreview: { viewModel.openAdvanced() },
            onEditAbility: { ability in
                do {
                    let sourceURL = try ProjectSkillWriter.ensureCanonicalSkill(
                        for: ability,
                        projectFolderPath: viewModel.resolvedProjectFolderForPreview()
                    )
                    ProjectSkillMaterializer.materialize(
                        projectFolderPath: viewModel.resolvedProjectFolderForPreview(),
                        skillIds: ability.requiredSkillIDs.isEmpty
                            ? [ProjectSkillWriter.primarySkillId(for: ability)]
                            : ability.requiredSkillIDs
                    )
                    MarkdownDocumentStore.shared.open(
                        fileURL: sourceURL,
                        folderName: String(localized: "abilities.section.title",
                                           defaultValue: "SKILLS",
                                           table: "TermLoop"),
                        displayTitle: ability.name,
                        mode: .edit
                    )
                } catch {
                    let sourceURL = ability.payloadBlocks.first?.fileURL ?? ability.metadataFilePath
                    MarkdownDocumentStore.shared.open(
                        fileURL: sourceURL,
                        folderName: String(localized: "abilities.section.title",
                                           defaultValue: "SKILLS",
                                           table: "TermLoop"),
                        displayTitle: ability.name
                    )
                }
            },
            onRevealAbility: { ability in
                let sourceURL = ability.payloadBlocks.first?.fileURL ?? ability.metadataFilePath
                NSWorkspace.shared.activateFileViewerSelecting([sourceURL])
            },
            onDisablePermanently: { ability in
                viewModel.disableAbilityPermanently(ability)
            }
        )
    }

    private var runComposerSection: some View {
        composerSection(
            onSubmit: submitFromComposer,
            onCommandReturn: handleCommandReturn,
            onToggleAdvanced: { viewModel.toggleAdvanced() }
        )
    }

    private var worktreeComposerSection: some View {
        composerSection(
            onSubmit: submitWorktreeFromComposer,
            onCommandReturn: handleWorktreeCommandReturn,
            onToggleAdvanced: { viewModel.toggleAdvanced() }
        )
    }

    private func composerSection(
        onSubmit: (() -> Void)?,
        onCommandReturn: (() -> Void)?,
        onToggleAdvanced: (() -> Void)?
    ) -> some View {
        QuickActionComposer(
            text: $viewModel.promptText,
            placeholder: composerPlaceholder,
            effectivePreviewText: viewModel.effectivePromptPreviewText,
            effectivePreviewLabel: viewModel.effectivePromptPreviewLabel,
            isFocused: $composerFocused,
            onSubmit: onSubmit,
            onCommandReturn: onCommandReturn,
            onOpenTemplateDropdown: { viewModel.openTemplateDropdown() },
            onToggleAdvanced: onToggleAdvanced,
            onEscape: handleEscape,
            onNavigateUp: {},
            onNavigateDown: {},
            autocompleteContextProvider: { [weak viewModel] in
                Self.autocompleteContext(for: viewModel)
            }
        )
        .frame(height: composerHeight)
    }

    @MainActor
    private static func autocompleteContext(
        for viewModel: QuickActionViewModel?
    ) -> QuickActionAutocompleteContext {
        let targetId = viewModel?.targetWorkspaceId
        let projectId: UUID? = {
            if viewModel?.launchSource.usesSourceWorkspaceLaunch == true,
               let targetId,
               let pid = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: targetId).projectId {
                return pid
            }
            if let projectId = viewModel?.runTarget.projectId {
                return projectId
            }
            if let targetId,
               let pid = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: targetId).projectId {
                return pid
            }
            return ProjectStore.shared.activeProjectId
        }()
        let workspacePath: String? = {
            let homePath = FileManager.default.homeDirectoryForCurrentUser.path
            if viewModel?.launchSource.usesSourceWorkspaceLaunch == true,
               let targetId,
               let ws = AppDelegate.shared?.workspaceFor(tabId: targetId),
               let cwd = ws.termLoopPresentationCwd(),
               cwd != homePath {
                return cwd
            }
            if let path = viewModel?.resolvedRunCwdForPreview() {
                return path
            }
            if let targetId,
               let ws = AppDelegate.shared?.workspaceFor(tabId: targetId) {
                if let cwd = ws.termLoopPresentationCwd(), cwd != homePath {
                    return cwd
                }
            }
            if let projectId,
               let proj = ProjectStore.shared.projects.first(where: { $0.id == projectId }) {
                return (proj.folderPath as NSString).expandingTildeInPath
            }
            if let active = ProjectStore.shared.activeProject {
                return (active.folderPath as NSString).expandingTildeInPath
            }
            return nil
        }()
        return QuickActionAutocompleteContext(
            projectId: projectId,
            targetWorkspaceId: targetId,
            targetWorkspacePath: workspacePath
        )
    }

    private var composerHeight: CGFloat {
        let sourceText = viewModel.promptText.isEmpty
            ? (viewModel.effectivePromptPreviewText ?? "")
            : viewModel.promptText
        let lines = max(1, sourceText.split(separator: "\n", omittingEmptySubsequences: false).count)
        return min(max(88, CGFloat(lines) * 22 + 28), 160)
    }

    private var composerPlaceholder: String {
        switch (viewModel.activeSurface, viewModel.composition) {
        case (.worktree, .freePrompt):
            return String(
                localized: "quickAction.composer.placeholder.worktree.freePrompt",
                defaultValue: "Optional initial prompt for the new worktree agent",
                table: "TermLoop"
            )
        case (.worktree, .template(let id)):
            let name = AgentTemplateStore.shared.template(id: id)?.name ?? id
            if let hint = viewModel.composerPromptHint {
                return "Optional extra instructions for \(name) after the worktree opens. \(hint)"
            }
            return String(
                localized: "quickAction.composer.placeholder.worktree.template",
                defaultValue: "Describe what \(name) should do after the worktree opens, then press ↵ to create.",
                table: "TermLoop"
            )
        case (.run, .freePrompt):
            if viewModel.launchSource.isForkLike {
                return String(
                    localized: "quickAction.composer.placeholder.fork.freePrompt",
                    defaultValue: "Tell the forked agent what to read and continue from this conversation.",
                    table: "TermLoop"
                )
            }
            return String(
                localized: "quickAction.composer.placeholder.freePrompt",
                defaultValue: "What would you like to run?",
                table: "TermLoop"
            )
        case (.run, .template(let id)):
            let name = AgentTemplateStore.shared.template(id: id)?.name ?? id
            if let hint = viewModel.composerPromptHint {
                return "Optional extra instructions for \(name). \(hint)"
            }
            return String(
                localized: "quickAction.composer.placeholder.template",
                defaultValue: "Describe what \(name) should do, then press ↵ to run.",
                table: "TermLoop"
            )
        }
    }

    // MARK: Title field

    private var titleField: some View {
        TextField(
            String(
                localized: "quickAction.title.placeholder",
                defaultValue: "Title",
                table: "TermLoop"
            ),
            text: $viewModel.advancedTitle
        )
        .textFieldStyle(.plain)
        .font(.system(size: 11))
        .foregroundColor(.primary.opacity(0.75))
        .padding(.horizontal, 2)
    }

    // MARK: Toolbar pills

    private var runCompositionSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            if case .template = viewModel.composition,
               let template = viewModel.activeTemplate {
                templateIdentityChip(name: template.name, defaults: viewModel.templateDefaultsSummaryText)
            }
            HStack(spacing: 6) {
                compositionChip(
                    title: "Prompt",
                    status: viewModel.promptInputStatus,
                    tint: Color.accentColor
                )
                compositionChip(
                    title: "System",
                    status: viewModel.systemInputStatus,
                    tint: Color.blue
                )
            }
            if !viewModel.canSubmitCurrentPrompt {
                Text("Add prompt text or choose a prompt source before running.")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
        }
    }

    private func templateIdentityChip(name: String, defaults: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "command")
                .font(.system(size: 10, weight: .semibold))
            Text("TEMPLATE")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .tracking(0.6)
            Text(name)
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
            if !defaults.isEmpty {
                Text("· \(defaults)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .foregroundColor(Color(red: 0.73, green: 0.55, blue: 1.0))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule(style: .continuous)
                .fill(Color(red: 0.73, green: 0.55, blue: 1.0).opacity(0.12))
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(Color(red: 0.73, green: 0.55, blue: 1.0).opacity(0.35), lineWidth: 1)
        )
        .help("Selected template: \(name)")
    }

    private func compositionChip(
        title: String,
        status: QuickActionInputStatus,
        tint: Color
    ) -> some View {
        HStack(spacing: 5) {
            Image(systemName: status.iconName)
                .font(.system(size: 10, weight: .semibold))
            Text(title.uppercased())
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .tracking(0.6)
            Text(status.shortLabel)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
        }
        .foregroundColor(status.hasValue ? tint : .secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule(style: .continuous)
                .fill(status.hasValue ? tint.opacity(0.12) : Color.white.opacity(0.04))
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(status.hasValue ? tint.opacity(0.35) : Color.white.opacity(0.09), lineWidth: 1)
        )
        .help(status.detail)
    }

    private var toolbarStrip: some View {
        let modelOptions = currentModelOptions
        let reasoningOptions = currentReasoningOptions
        return HStack(spacing: 6) {
            agentPill
            permissionPill
            modelPill(options: modelOptions)
            if !reasoningOptions.isEmpty {
                reasoningPill(options: reasoningOptions)
            }
            if case .template = viewModel.composition {
                Spacer(minLength: 4)
                Button {
                    viewModel.returnToFreePrompt()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 10))
                        Text(String(
                            localized: "quickAction.toolbar.backToFreePrompt",
                            defaultValue: "back to free prompt",
                            table: "TermLoop"
                        ))
                        .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
            } else {
                Spacer(minLength: 4)
                if viewModel.didRestoreFromMemory {
                    Text(String(
                        localized: "quickAction.toolbar.restoredFromLast",
                        defaultValue: "restored from last run",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                }
            }
        }
    }

    private func pillLabel(field: String, value: String, tint: Color) -> some View {
        HStack(spacing: 5) {
            Text(field.uppercased())
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .tracking(0.6)
                .foregroundColor(Color.secondary.opacity(0.8))
            Text(value)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundColor(tint)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 3)
        .background(
            Capsule(style: .continuous)
                .fill(Color.white.opacity(0.04))
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(Color.white.opacity(0.09), lineWidth: 1)
        )
        .contentShape(Capsule())
    }

    private var agentPill: some View {
        Menu {
            ForEach(AgentCatalogStore.shared.agents, id: \.id) { agent in
                Button(agent.displayName) {
                    viewModel.advancedTerminalAgentId = agent.id
                }
            }
        } label: {
            pillLabel(field: "agent", value: agentPillLabel, tint: Color(red: 0.73, green: 0.55, blue: 1.0))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var permissionPill: some View {
        Menu {
            ForEach([AgentTemplate.PermissionMode.default, .acceptEdits, .plan, .bypassPermissions], id: \.self) { p in
                Button(p.rawValue) { viewModel.advancedPermission = p }
            }
        } label: {
            pillLabel(field: "perm", value: permissionPillLabel, tint: permissionTint)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private func modelPill(options: [AgentModelOption]) -> some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button(option.rawValue) {
                    viewModel.advancedModel = option
                }
            }
        } label: {
            pillLabel(field: "model", value: currentModelLabel, tint: Color.secondary)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private func reasoningPill(options: [AgentReasoningOption]) -> some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button(option.rawValue) {
                    viewModel.advancedReasoning = option
                }
            }
        } label: {
            pillLabel(field: "reason", value: currentReasoningLabel, tint: Color.secondary)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var agentPillLabel: String {
        AgentCatalogStore.shared.agent(id: viewModel.advancedTerminalAgentId)?.id
            ?? viewModel.advancedTerminalAgentId
    }

    private var currentModelOptions: [AgentModelOption] {
        AgentCatalogStore.shared.orderedModelOptions(for: viewModel.advancedTerminalAgentId)
    }

    private var currentReasoningOptions: [AgentReasoningOption] {
        AgentCatalogStore.shared.orderedReasoningOptions(for: viewModel.advancedTerminalAgentId)
    }

    private var currentModelLabel: String {
        viewModel.advancedModel.displayLabel
    }

    private var currentReasoningLabel: String {
        viewModel.advancedReasoning.rawValue
    }

    private var permissionPillLabel: String {
        switch viewModel.advancedPermission {
        case .default: return "default"
        case .acceptEdits: return "acceptEdits"
        case .bypassPermissions, .auto: return "bypass"
        case .plan: return "plan"
        case .dontAsk: return "dontAsk"
        case .ask: return "ask"
        }
    }
    private var permissionTint: Color {
        switch viewModel.advancedPermission {
        case .bypassPermissions, .auto: return Color(red: 1.0, green: 0.63, blue: 0.41)
        case .acceptEdits: return Color(red: 1.0, green: 0.69, blue: 0.29)
        case .plan: return Color(red: 0.43, green: 0.66, blue: 1.0)
        case .default, .ask, .dontAsk: return Color.secondary
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 8) {
            Text(String(
                localized: "quickAction.footer.brand",
                defaultValue: "termloop",
                table: "TermLoop"
            ))
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.secondary)
            Spacer()
            footerHint("↵", String(localized: "quickAction.footer.hint.run", defaultValue: "run", table: "TermLoop"))
            footerHint("⌘K", String(localized: "quickAction.footer.hint.template", defaultValue: "template", table: "TermLoop"))
            footerHint("⌘↵", String(localized: "quickAction.footer.hint.advanced", defaultValue: "advanced", table: "TermLoop"))
            footerHint("esc", String(localized: "quickAction.footer.hint.dismiss", defaultValue: "dismiss", table: "TermLoop"))
        }
    }

    private var worktreeFooter: some View {
        HStack(spacing: 8) {
            Text(String(
                localized: "quickAction.footer.brand",
                defaultValue: "termloop",
                table: "TermLoop"
            ))
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.secondary)
            Spacer()
            if viewModel.worktreeIntent == .createWorkspace {
                footerHint("⌘K", String(localized: "quickAction.footer.hint.template", defaultValue: "template", table: "TermLoop"))
                footerHint("⌘↵", String(localized: "quickAction.footer.hint.advanced", defaultValue: "advanced", table: "TermLoop"))
                footerHint("↵", String(
                    localized: "quickAction.footer.hint.create",
                    defaultValue: "create",
                    table: "TermLoop"
                ))
            } else {
                footerHint("↵", String(
                    localized: "quickAction.footer.hint.move",
                    defaultValue: "move",
                    table: "TermLoop"
                ))
            }
            footerHint("esc", String(localized: "quickAction.footer.hint.dismiss", defaultValue: "dismiss", table: "TermLoop"))
        }
    }

    private func footerHint(_ key: String, _ label: String) -> some View {
        HStack(spacing: 3) {
            Text(key)
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Color.secondary.opacity(0.12))
                )
                .foregroundColor(.secondary)
            Text(label)
                .font(.system(size: 10))
                .foregroundColor(.secondary)
        }
    }

    // MARK: Dropdown overlay

    private var dropdownOverlay: some View {
        VStack {
            Color.black.opacity(0.001)
                .frame(height: 52)
                .onTapGesture { viewModel.closeTemplateDropdown() }
            QuickActionTemplateDropdown(
                viewModel: viewModel,
                onSelectFreePrompt: {
                    viewModel.returnToFreePrompt()
                },
                onSelectTemplate: { id in
                    viewModel.selectTemplate(id: id)
                },
                onClose: { viewModel.closeTemplateDropdown() }
            )
            .padding(.horizontal, 14)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private func submitFromComposer() {
        if viewModel.isDropdownOpen { return }
        let ok = viewModel.submit()
        if ok { onDismiss() }
    }

    private func submitWorktreeFromComposer() {
        if viewModel.isDropdownOpen { return }
        worktreeSubmitToken &+= 1
    }

    private func handleWorktreeCommandReturn() {
        if viewModel.isAdvancedOpen {
            submitWorktreeFromComposer()
        } else {
            viewModel.openAdvanced()
        }
    }

    private func handleWorktreeCreated() {
        viewModel.recordSuccessfulWorktreeCreate()
        onWorktreeCreated()
    }

    private func handleCommandReturn() {
        if viewModel.isAdvancedOpen {
            let ok = viewModel.submit()
            if ok { onDismiss() }
        } else {
            viewModel.openAdvanced()
        }
    }

    private func handleEscape() {
        if viewModel.isDropdownOpen {
            viewModel.closeTemplateDropdown()
        } else if viewModel.isAdvancedOpen {
            viewModel.closeAdvanced()
        } else if viewModel.activeSurface == .worktree {
            onDismiss()
        } else if !viewModel.promptText.isEmpty || viewModel.errorMessage != nil {
            viewModel.promptText = ""
            viewModel.errorMessage = nil
        } else {
            onDismiss()
        }
    }

}

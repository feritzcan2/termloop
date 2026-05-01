// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Sidebar section for project-local abilities. Sits above
/// `ActiveAgentsPanel` in `TermLoopSidebar.Root`. Mirrors the visual
/// vocabulary of the rest of the sidebar (hairline rule, caps header,
/// monospace rows).
@MainActor
struct AbilitiesPanel: View {
    @ObservedObject private var store = AbilityStore.shared
    @ObservedObject private var projectStore = ProjectStore.shared
    @ObservedObject private var detailState = AbilityDetailUIState.shared
    @EnvironmentObject private var tabManager: TabManager

    @State private var deleteConfirmationId: String? = nil
    @State private var errorMessage: String? = nil
    @State private var newSheetVisible: Bool = false

    /// Narrow subscription to `WorkspaceMetadataStore.$agentSessionVersion`
    /// so this panel re-evaluates when an agent session starts or clears.
    /// Observing the full `objectWillChange` is the anti-pattern —
    /// telemetry churn would rebuild this subtree on every Claude turn.
    @State private var agentSessionTick: Int = 0
    @State private var projectScopeTick: Int = 0

    /// Persisted collapsed state — click the header to toggle.
    @AppStorage("termloop.abilities.collapsed.v2") private var abilitiesCollapsed: Bool = true

    private var hasActiveProject: Bool {
        projectStore.activeProjectId != nil
    }

    private struct AbilityCatalogItem: Identifiable {
        let id: String
        let ability: Ability?
        let starter: AbilityStarter?

        var title: String { abilityPreview?.name ?? starter?.name ?? id }
        var summary: String { abilityPreview?.description ?? starter?.description ?? "" }
        var itemSummary: [String] {
            abilityPreview?.itemSummaryFragments ?? []
        }
        var itemSections: [AbilityCatalogSection] {
            abilityPreview?.catalogSections ?? []
        }
        var isInstalled: Bool { ability != nil }
        var installOrResetLabel: String? {
            guard starter != nil else { return nil }
            return isInstalled ? "Reset" : "Install"
        }

        private var abilityPreview: Ability? {
            if let ability { return ability }
            guard let starter else { return nil }
            return ProjectInstructionStore.loadStarterAbility(starter)
        }
    }

    private var catalogItems: [AbilityCatalogItem] {
        _ = agentSessionTick
        _ = projectScopeTick
        var startersBySlug = Dictionary(uniqueKeysWithValues: ProjectInstructionStore.loadStarters().map {
            ($0.id, $0)
        })
        var items = store.abilities.map { ability in
            AbilityCatalogItem(
                id: ability.id,
                ability: ability,
                starter: startersBySlug.removeValue(forKey: ability.id)
            )
        }
        items.append(contentsOf: startersBySlug.values.map { starter in
            AbilityCatalogItem(id: starter.id, ability: nil, starter: starter)
        })
        return items.sorted { lhs, rhs in
            if lhs.isInstalled != rhs.isInstalled {
                return lhs.isInstalled && !rhs.isInstalled
            }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            TermLoopSidebarRule()

            header
                .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                .padding(.top, 6)
                .padding(.bottom, abilitiesCollapsed ? 6 : 2)

            if !abilitiesCollapsed {
                if !hasActiveProject {
                    Text(String(
                        localized: "abilities.panel.selectProjectAbilities",
                        defaultValue: "Select a project to manage abilities.",
                        table: "TermLoop"
                    ))
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dimmer)
                        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                        .padding(.bottom, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ResizableSidebarPanelContainer(
                        storageKey: AgentSidebarPanelLayoutState.abilitiesHeightKey,
                        mediumHeight: 220,
                        minHeight: 72
                    ) {
                        VStack(alignment: .leading, spacing: 6) {
                            if store.abilities.isEmpty {
                                starterHint
                            }
                            abilityList
                        }
                        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                        .padding(.top, 2)
                        .padding(.bottom, 6)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .onAppear { store.start() }
        .onReceive(WorkspaceMetadataStore.shared.$agentSessionVersion) { newValue in
            agentSessionTick = newValue
        }
        .onReceive(WorkspaceMetadataStore.shared.$projectScopeVersion) { newValue in
            projectScopeTick = newValue
        }
        .onReceive(detailState.$customizeRequestTick.dropFirst()) { _ in
            handleCustomizeRequest()
        }
        .alert(
            headerTitle,
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            ),
            presenting: errorMessage
        ) { _ in
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: { message in
            Text(message)
        }
        .sheet(isPresented: $newSheetVisible) {
            AbilityNewSheet { name, description in
                createNewAbility(name: name, description: description)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: abilitiesCollapsed ? "chevron.right" : "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .frame(width: 10)
            Text(TermLoopSidebarTheme.caps(headerTitle))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(Color.primary)
            if !store.isInitialized {
                Text("(setup)")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dimmer)
            }
            Spacer()
            Text(verbatim: "\(catalogItems.count)")
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .monospacedDigit()
            AgentSidebarPanelSizeCycleButton(
                storageKey: AgentSidebarPanelLayoutState.abilitiesHeightKey,
                mediumHeight: 220
            )
            Button(action: { presentNewAbilitySheet() }) {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(hasActiveProject
                                     ? TermLoopSidebarTheme.accent
                                     : TermLoopSidebarTheme.dimmer)
            }
            .buttonStyle(.plain)
            .disabled(!hasActiveProject)
            .help("Create a new ability bundle")
        }
        .contentShape(Rectangle())
        .onTapGesture { abilitiesCollapsed.toggle() }
    }

    private var headerTitle: String {
        String(
            localized: "sidebar.workSubTab.abilities",
            defaultValue: "Abilities",
            table: "TermLoop"
        )
    }

    // MARK: - States

    private var starterHint: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(String(
                localized: "abilities.panel.starterHintAbilities",
                defaultValue: "Start from a built-in ability or create a custom one.",
                table: "TermLoop"
            ))
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
        }
    }

    private var abilityList: some View {
        VStack(spacing: 6) {
            ForEach(catalogItems) { item in
                let assignedWorkspaceId = assignedAbilityWorkspaceId(for: item.id)
                AbilityCatalogRow(
                    title: item.title,
                    summary: item.summary,
                    itemSummary: item.itemSummary,
                    itemSections: item.itemSections,
                    activation: item.ability?.activation
                        ?? (item.starter != nil ? .off : nil),
                    showsStarterBadge: item.ability == nil && item.starter != nil,
                    assignedAgentTitle: assignedAgentTitle(for: assignedWorkspaceId),
                    primaryActionLabel: assignedWorkspaceId == nil
                        ? (item.ability == nil ? "Create with agent" : "Discuss")
                        : "Open agent",
                    onPrimaryAction: { openOrStartAbilityAgent(for: item) },
                    onSelect: { selectAbilityDetail(for: item) },
                    isSelected: detailState.selectedAbilityId == item.id,
                    onOpenEditor: item.ability.map { ability in
                        { openInMarkdownEditor(ability) }
                    },
                    onInstallOrReset: item.starter.map { starter in
                        item.isInstalled
                            ? { resetStarter(starter) }
                            : { installStarter(starter) }
                    },
                    installOrResetLabel: item.installOrResetLabel,
                    onDelete: item.ability.flatMap { ability in
                        item.starter == nil ? { deleteConfirmationId = ability.id } : nil
                    },
                    onSetActivation: item.ability.map { ability in
                        { mode in
                            store.setActivation(id: ability.id, mode)
                        }
                    },
                    onToggleActivation: {
                        if let ability = item.ability {
                            return { store.toggleActivation(id: ability.id) }
                        }
                        if let starter = item.starter {
                            // Starter row: one tap installs and immediately
                            // enables at the bundle's intended mode (skips
                            // the install-as-off default since the user has
                            // explicitly opted in).
                            return { installAndEnableStarter(starter) }
                        }
                        return nil
                    }()
                )
                .confirmationDialog(
                    "Delete \(item.title)?",
                    isPresented: Binding(
                        get: { deleteConfirmationId == item.id },
                        set: { if !$0 { deleteConfirmationId = nil } }
                    ),
                    titleVisibility: .visible
                ) {
                    Button("Delete", role: .destructive) {
                        store.delete(id: item.id)
                        deleteConfirmationId = nil
                    }
                    Button("Cancel", role: .cancel) {
                        deleteConfirmationId = nil
                    }
                }
            }
        }
    }

    // MARK: - Actions

    private func selectAbilityDetail(for item: AbilityCatalogItem) {
        if let ability = item.ability {
            detailState.show(ability.id)
            return
        }
        if let starter = item.starter {
            if !store.isInitialized {
                store.initializeDirectory()
            }
            guard let ability = store.installStarter(starter) else {
                errorMessage = "Could not install the starter ability."
                return
            }
            detailState.show(ability.id)
            return
        }
    }

    private func openInMarkdownEditor(_ ability: Ability) {
        MarkdownDocumentStore.shared.open(
            fileURL: ability.filePath,
            folderName: String(localized: "abilities.section.title",
                               defaultValue: "ABILITIES", table: "TermLoop"),
            displayTitle: ability.name
        )
    }

    private func assignedAbilityWorkspaceId(for abilityId: String) -> UUID? {
        let matches = TermLoopSidebar.projectScopedTabs(allTabs: tabManager.tabs).compactMap { workspace -> (UUID, Date)? in
            guard let session = WorkspaceMetadataStore.shared.abilitySession(forWorkspaceId: workspace.id) else {
                return nil
            }
            switch session.kind {
            case .abilityDiscussion(let assignedId), .abilityRefiner(let assignedId):
                guard assignedId == abilityId else { return nil }
                return (workspace.id, session.spawnedAt)
            case .abilityCreator:
                return nil
            }
        }
        return matches.max(by: { $0.1 < $1.1 })?.0
    }

    private func assignedAgentTitle(for workspaceId: UUID?) -> String? {
        guard let workspaceId,
              let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
            return nil
        }
        let custom = workspace.customTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return custom.isEmpty ? workspace.title : custom
    }

    private func latestPersistedAbilitySession(
        for abilityId: String
    ) -> (workspaceId: UUID, session: PersistedAgentSession)? {
        let activeProjectId = projectStore.activeProjectId
        return WorkspaceMetadataStore.shared.byWorkspaceId
            .compactMap { workspaceId, metadata -> (UUID, PersistedAgentSession)? in
                guard metadata.projectId == activeProjectId,
                      metadata.assignedAbilityId == abilityId,
                      let session = metadata.persistedAgentSession else {
                    return nil
                }
                return (workspaceId, session)
            }
            .max(by: {
                ($0.1.updatedAt ?? .distantPast) < ($1.1.updatedAt ?? .distantPast)
            })
    }

    /// Opens Quick Action prefilled for an ability-creator run in the
    /// current project.
    private func presentNewAbilitySheet() {
        guard hasActiveProject else {
            errorMessage = "Select a project before creating an ability."
            return
        }
        if !store.isInitialized {
            store.initializeDirectory()
        }
        newSheetVisible = true
    }

    private func createNewAbility(name: String, description: String) {
        let slug = slugify(name)
        guard !slug.isEmpty else {
            errorMessage = "Could not derive a slug from that name."
            return
        }
        if store.ability(id: slug) != nil {
            errorMessage = "An ability with slug '\(slug)' already exists."
            return
        }
        guard let dir = store.abilitiesDirectoryURL() else {
            errorMessage = "No active project."
            return
        }
        let bundleURL = AbilityBundleStore.bundleDirectoryURL(parentDirectory: dir, slug: slug)
        let ability = Ability(
            id: slug,
            name: name,
            description: description.isEmpty ? "Use when…" : description,
            activation: .listed,
            body: "",
            systemReminderBody: nil,
            tags: [],
            items: [],
            filePath: bundleURL.appendingPathComponent(AbilityBundleManifest.defaultInstructionFile),
            metadataFilePath: bundleURL.appendingPathComponent("ability.json"),
            storageKind: .bundle
        )
        store.save(ability)
        detailState.show(slug)
    }

    private func slugify(_ text: String) -> String {
        let lowered = text.lowercased()
        let parts = lowered.components(separatedBy: CharacterSet.alphanumerics.inverted)
        return parts.filter { !$0.isEmpty }.joined(separator: "-")
    }

    private func handleCustomizeRequest() {
        guard let id = detailState.selectedAbilityId,
              let item = catalogItems.first(where: { $0.id == id }) else { return }
        let forceFresh = detailState.customizeRequestForceFresh
        detailState.customizeRequestForceFresh = false
        openOrStartAbilityAgent(for: item, forceFresh: forceFresh)
    }

    private func clearPersistedAbilitySessions(for abilityId: String) {
        let activeProjectId = projectStore.activeProjectId
        let store = WorkspaceMetadataStore.shared
        let targetWorkspaceIds: [UUID] = store.byWorkspaceId.compactMap { workspaceId, metadata in
            (metadata.projectId == activeProjectId && metadata.assignedAbilityId == abilityId)
                ? workspaceId
                : nil
        }
        // Close any open tabs assigned to this ability first — otherwise the
        // old Claude session keeps re-registering itself via hooks and the
        // restore coordinator fires a resume script in the new tab.
        for workspace in tabManager.tabs where targetWorkspaceIds.contains(workspace.id) {
            tabManager.closeWorkspace(workspace)
        }
        for workspaceId in targetWorkspaceIds {
            _ = store.clearPersistedAgentSession(for: workspaceId)
        }
    }

    private func installStarter(_ starter: AbilityStarter) {
        if !store.isInitialized {
            store.initializeDirectory()
        }
        guard let ability = store.installStarter(starter) else {
            errorMessage = "Could not install the starter ability."
            return
        }
        detailState.show(ability.id)
    }

    /// Sidebar Toggle handler for not-yet-installed starter rows. Installs
    /// the bundle, then immediately flips activation to the starter's
    /// intended mode (or `.listed` when the starter itself ships `.off`),
    /// bypassing the install-as-off default so a single tap turns the
    /// ability on.
    private func installAndEnableStarter(_ starter: AbilityStarter) {
        if !store.isInitialized {
            store.initializeDirectory()
        }
        guard let installed = store.installStarter(starter) else {
            errorMessage = "Could not install the starter ability."
            return
        }
        let target: AbilityActivation = starter.activation == .off
            ? .listed
            : starter.activation
        store.setActivation(id: installed.id, target)
    }

    private func resetStarter(_ starter: AbilityStarter) {
        if !store.isInitialized {
            store.initializeDirectory()
        }
        let projectFolderPath = projectStore.activeProjectId.flatMap { projectStore.project(id: $0)?.folderPath }
        if shouldCloseMarkdownDocument(projectFolderPath: projectFolderPath, abilityId: starter.id) {
            MarkdownDocumentStore.shared.close()
        }
        guard let ability = store.installStarter(starter) else {
            errorMessage = "Could not reset the starter ability."
            return
        }
        detailState.show(ability.id)
    }

    private func shouldCloseMarkdownDocument(
        projectFolderPath: String?,
        abilityId: String
    ) -> Bool {
        guard let selected = MarkdownDocumentStore.shared.selectedFileURL?.standardizedFileURL.path else {
            return false
        }
        if let projectFolderPath {
            let projectRoot = URL(fileURLWithPath: projectFolderPath, isDirectory: true).standardizedFileURL.path
            let abilityPrefix = "\(projectRoot)/.termloop/abilities/\(abilityId)/"
            if selected.hasPrefix(abilityPrefix) {
                return true
            }
        }
        return false
    }

    private func openOrStartAbilityAgent(for item: AbilityCatalogItem, forceFresh: Bool = false) {
        if !forceFresh, let existingWorkspaceId = assignedAbilityWorkspaceId(for: item.id) {
            TermLoopHooks.focusWorkspace(workspaceId: existingWorkspaceId)
            return
        }
        guard let projectId = projectStore.activeProjectId,
              projectStore.project(id: projectId) != nil else {
            errorMessage = "Select a project before opening an ability agent."
            return
        }
        if !store.isInitialized {
            store.initializeDirectory()
        }
        if forceFresh {
            clearPersistedAbilitySessions(for: item.id)
        } else if let persisted = latestPersistedAbilitySession(for: item.id) {
            reviveAbilityAgent(for: item, persistedSession: persisted.session, projectId: projectId)
            return
        }
        if let ability = item.ability {
            let bundlePath = ability.metadataFilePath.deletingLastPathComponent().path
            let systemBody = (ability.customizerPromptBody
                ?? ProjectInstructionStore.bundledPrompt(.creator))
                + "\n\nTarget bundle: `\(bundlePath)`\n"
            launchAbilityAgent(
                title: "ability: \(ability.name)",
                prompt: "Customize the **\(ability.name)** ability for this project. Begin Phase 1 (detection).",
                systemPromptBody: systemBody,
                kind: .abilityDiscussion(abilityId: ability.id),
                source: .abilityRefiner
            )
            return
        }
        guard let starter = item.starter else { return }
        var systemBody = ProjectInstructionStore.loadStarterAbility(starter)?.customizerPromptBody
            ?? ProjectInstructionStore.bundledPrompt(.creator)
        if let dir = store.abilitiesDirectoryURL() {
            let target = AbilityBundleStore.bundleDirectoryURL(parentDirectory: dir, slug: starter.id)
            systemBody += "\n\nTarget bundle: `\(target.path)` (will be created if missing)\n"
        }
        launchAbilityAgent(
            title: "ability: \(starter.name)",
            prompt: "Customize the **\(starter.name)** ability for this project. Begin Phase 1 (detection).",
            systemPromptBody: systemBody,
            kind: .abilityDiscussion(abilityId: starter.id),
            source: .abilityCreator
        )
    }

    private func launchAbilityAgent(
        title: String,
        prompt: String,
        systemPromptBody: String?,
        kind: AgentWorkspaceKind,
        source: AgentInvocationSource
    ) {
        QuickActionController.shared.present(
            prefill: QuickActionPresentationRequest(
                initialSurface: .run,
                promptText: prompt,
                advancedSystemPrompt: systemPromptBody,
                advancedTitle: title,
                advancedTerminalAgentId: TerminalAgent.claudeId,
                advancedPermission: .bypassPermissions,
                launchSource: source,
                reasonTag: "quickAction.freePrompt",
                projectId: projectStore.activeProjectId,
                placementOverride: .afterCurrent,
                openAdvanced: true,
                onLaunchedWorkspace: { workspace in
                    WorkspaceMetadataStore.shared.setAgentSession(
                        kind: kind,
                        spawnedAt: Date(),
                        forWorkspaceId: workspace.id
                    )
                }
            )
        )
    }

    private func reviveAbilityAgent(
        for item: AbilityCatalogItem,
        persistedSession: PersistedAgentSession,
        projectId: UUID
    ) {
        guard let project = projectStore.project(id: projectId) else { return }
        let agentId = persistedSession.agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let agent = TerminalAgentRegistry.shared.agent(id: agentId) else {
            errorMessage = "Could not restore the prior ability session because the agent `\(agentId)` is unavailable."
            return
        }
        let normalizedCwd = persistedSession.cwd?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let cwd = (normalizedCwd?.isEmpty == false ? normalizedCwd : nil) ?? project.folderPath
        let workspace = tabManager.addWorkspace(
            title: "ability: \(item.title)",
            workingDirectory: cwd,
            select: true,
            eagerLoadTerminal: true,
            projectId: projectId,
            terminalAgentId: agent.id
        )
        WorkspaceMetadataStore.shared.setPersistedAgentSession(persistedSession, for: workspace.id)
        WorkspaceMetadataStore.shared.setAgentSession(
            kind: .abilityDiscussion(abilityId: item.id),
            spawnedAt: Date(),
            forWorkspaceId: workspace.id
        )
        // User-initiated revival — force autoRestoreClaude=true even when the
        // setting is off, since the user just clicked the revive action.
        TerminalAgentLifecycle.restoreWorkspaces([workspace], autoRestoreClaude: true)
    }
}


@MainActor
final class AbilityDetailUIState: ObservableObject {
    static let shared = AbilityDetailUIState()

    @Published var selectedAbilityId: String?
    /// One-shot trigger bumped whenever the detail page wants the parent to
    /// launch the customize-with-agent flow for `selectedAbilityId`.
    @Published private(set) var customizeRequestTick: UInt = 0
    /// Latched alongside `customizeRequestTick` to ask the parent to bypass
    /// any prior assigned workspace or persisted session and start a fresh
    /// customizer run. Reset back to false after the parent observes the tick.
    @Published var customizeRequestForceFresh: Bool = false

    private init() {}

    var isPresented: Bool {
        selectedAbilityId != nil
    }

    func show(_ abilityId: String) {
        selectedAbilityId = abilityId
    }

    func close() {
        guard selectedAbilityId != nil else { return }
        selectedAbilityId = nil
    }

    func requestCustomize(forceFresh: Bool = false) {
        customizeRequestForceFresh = forceFresh
        customizeRequestTick &+= 1
    }
}

@MainActor
struct AbilityDetailPage: View {
    let abilityId: String

    @ObservedObject private var abilityStore = AbilityStore.shared
    @ObservedObject private var detailState = AbilityDetailUIState.shared
    @ObservedObject private var projectStore = ProjectStore.shared
    @State private var deleteConfirmation = false

    private var ability: Ability? {
        abilityStore.ability(id: abilityId)
    }

    private var projectFolderPath: String? {
        guard let id = projectStore.activeProjectId,
              let project = projectStore.project(id: id) else { return nil }
        return project.folderPath
    }

    var body: some View {
        Group {
            if let ability {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header(for: ability)
                        AbilitySetupCard(
                            ability: ability,
                            projectFolderPath: projectFolderPath
                        )
                        AbilityMCPToolsCard(
                            ability: ability,
                            onToggle: { name, enabled in
                                abilityStore.setMCPToolEnabled(
                                    id: ability.id,
                                    toolName: name,
                                    enabled: enabled
                                )
                            }
                        )
                        AbilitySystemReminderCard(
                            ability: ability,
                            onEditSource: { editSystemReminder(for: ability) }
                        )
                        if ability.requiredSkillIDs.isEmpty {
                            AbilityInstructionsCard(
                                ability: ability,
                                onCustomize: { detailState.requestCustomize() }
                            )
                        } else {
                            AbilityRequiredSkillsCard(
                                ability: ability,
                                projectFolderPath: projectFolderPath,
                                onCustomize: { detailState.requestCustomize() }
                            )
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            } else {
                missingState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
        .confirmationDialog(
            "Delete \(ability?.name ?? "ability")?",
            isPresented: $deleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let ability {
                    abilityStore.delete(id: ability.id)
                }
                detailState.close()
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func header(for ability: Ability) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(ability.name)
                    .font(.system(size: 22, weight: .semibold, design: .monospaced))
                Text(ability.description)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            Menu {
                ForEach(AbilityActivation.allCases, id: \.self) { mode in
                    Button(activationLabel(mode)) {
                        abilityStore.setActivation(id: ability.id, mode)
                    }
                }
            } label: {
                TermLoopSidebarToken(
                    label: ability.activation.rawValue,
                    tone: .accent,
                    emphasized: true
                )
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            Button {
                detailState.requestCustomize()
            } label: {
                Label("Customize with agent", systemImage: "sparkles")
            }
            .buttonStyle(.borderedProminent)
            Menu {
                Button("Restart customizer (fresh)") {
                    detailState.requestCustomize(forceFresh: true)
                }
                Divider()
                Button("Open ability.json") { open(ability.metadataFilePath, title: "\(ability.name) manifest") }
                Button("Show bundle in Finder") { revealInFinder(ability.metadataFilePath.deletingLastPathComponent()) }
                Button("Copy bundle path") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(
                        ability.metadataFilePath.deletingLastPathComponent().path,
                        forType: .string
                    )
                }
                Divider()
                Button("Close detail") { detailState.close() }
                Divider()
                Button("Delete ability", role: .destructive) { deleteConfirmation = true }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .padding(.bottom, 4)
    }

    private var missingState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Ability not found")
                .font(TermLoopSidebarTheme.bodyMonoStrong)
            Text("The selected ability is no longer available in the active project.")
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            Button("Back to terminal") { detailState.close() }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - Actions

    private func editSystemReminder(for ability: Ability) {
        let url = ability.metadataFilePath
            .deletingLastPathComponent()
            .appendingPathComponent(AbilityBundleManifest.systemReminderFile)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? "".write(to: url, atomically: true, encoding: .utf8)
        }
        open(url, title: "\(ability.name) — system reminder")
    }

    private func open(_ url: URL, title: String) {
        MarkdownDocumentStore.shared.open(
            fileURL: url,
            folderName: String(
                localized: "abilities.section.title",
                defaultValue: "ABILITIES",
                table: "TermLoop"
            ),
            displayTitle: title
        )
    }

    private func revealInFinder(_ url: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func activationLabel(_ mode: AbilityActivation) -> String {
        switch mode {
        case .always: return "always inject"
        case .worktree: return "inject in worktrees"
        case .listed: return "list on demand"
        case .off: return "off"
        }
    }
}

struct AbilitySkillProbe {
    enum Source {
        case projectCanonical
        case projectCopy
        case globalFallback
    }

    let exists: Bool
    let detail: String
    let fileURL: URL?
    let source: Source?

    var statusLabel: String {
        exists ? "installed" : "missing"
    }

    var canCopyToProject: Bool {
        guard exists, fileURL != nil else { return false }
        return source != .projectCanonical
    }

    static func resolve(id: String, projectRoot: URL?) -> AbilitySkillProbe {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        // Mirrors `ProjectInstructionStore.probeSkill` — both project dirs
        // (canonical `.termloop` plus agent-native catalogs) and global dirs
        // (~/.codex, ~/.agents, ~/.claude). Drift here causes "missing" UI
        // for skills the composer would actually find at launch.
        var candidates: [(url: URL, label: String, source: Source)] = []
        if let projectRoot {
            candidates.append((
                projectRoot.appendingPathComponent(".termloop/skills/\(id)/SKILL.md"),
                "project canonical",
                .projectCanonical
            ))
            candidates.append((
                projectRoot.appendingPathComponent(".claude/skills/\(id)/SKILL.md"),
                "Claude project copy",
                .projectCopy
            ))
            candidates.append((
                projectRoot.appendingPathComponent(".codex/skills/\(id)/SKILL.md"),
                "Codex project copy",
                .projectCopy
            ))
            candidates.append((
                projectRoot.appendingPathComponent(".agents/skills/\(id)/SKILL.md"),
                "Agents project copy",
                .projectCopy
            ))
        }
        candidates.append((
            home.appendingPathComponent(".codex/skills/\(id)/SKILL.md"),
            "Codex global fallback",
            .globalFallback
        ))
        candidates.append((
            home.appendingPathComponent(".agents/skills/\(id)/SKILL.md"),
            "Agents global fallback",
            .globalFallback
        ))
        candidates.append((
            home.appendingPathComponent(".claude/skills/\(id)/SKILL.md"),
            "Claude global fallback",
            .globalFallback
        ))

        if let hit = candidates.first(where: { fm.fileExists(atPath: $0.url.path) }) {
            return AbilitySkillProbe(
                exists: true,
                detail: "\(hit.label) — \(hit.url.path)",
                fileURL: hit.url,
                source: hit.source
            )
        }
        return AbilitySkillProbe(
            exists: false,
            detail: "Checked project .termloop/.claude/.codex/.agents plus ~/.codex, ~/.agents, and ~/.claude skill catalogs.",
            fileURL: nil,
            source: nil
        )
    }
}

private extension String {
    func nilIfEmpty() -> String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

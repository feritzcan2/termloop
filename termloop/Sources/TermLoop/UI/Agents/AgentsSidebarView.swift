// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct AgentsSidebarView: View {
    @ObservedObject private var templateStore = AgentTemplateStore.shared
    @ObservedObject private var promptStore = AgentPromptStore.shared
    @ObservedObject private var projectStore = ProjectStore.shared
    @ObservedObject private var uiState = AgentsCatalogUIState.shared
    @State private var errorMessage: String?
    @State private var searchText: String = ""

    var body: some View {
        VStack(spacing: 8) {
            toolbar
            sectionFilterBar
                .padding(.horizontal, 8)
            if uiState.selectedFilter == .prompts {
                promptTypeFilterBar
                    .padding(.horizontal, 8)
            }
            List(selection: $uiState.selectionId) {
                if filteredEntries.isEmpty {
                    catalogEmptyState
                } else {
                    catalogRows(filteredEntries)
                }
            }
            .listStyle(.sidebar)

            HStack {
                Text("Editing a built-in template saves a project override.")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dimmer)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
        }
        .frame(minWidth: 270, idealWidth: 320)
        .alert(
            "Catalog action failed",
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
        .onAppear {
            refreshProjectCatalogScope()
            reconcileSelection()
        }
        .onChange(of: searchText) {
            handleCatalogChange()
        }
        .onChange(of: templateStore.templates.map(\.id)) {
            handleCatalogChange()
        }
        .onChange(of: promptStore.documents.map(\.id)) {
            handleCatalogChange()
        }
        .onChange(of: projectStore.activeProjectId) {
            handleProjectChange()
        }
        .onChange(of: uiState.selectedFilter) {
            handleCatalogChange()
        }
        .onChange(of: uiState.selectedPromptFilter) {
            handleCatalogChange()
        }
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            TextField("Search templates and prompts", text: $searchText)
                .textFieldStyle(.roundedBorder)
                .font(TermLoopSidebarTheme.bodyMono)
            Menu {
                createMenu
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 28, height: 28)
            }
            .menuStyle(.borderlessButton)
            .disabled(activeProjectFolderPath == nil)
            .help(activeProjectFolderPath == nil ? "Select an active project to add project prompts." : "Add a new project prompt")
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
    }


    private var activeProjectFolderPath: String? {
        projectStore.activeProjectId.flatMap { projectStore.project(id: $0)?.folderPath }
    }

    @ViewBuilder
    private var createMenu: some View {
        Button("New Template") { createTemplate() }
        Divider()
        Button("New System Instructions") { createPrompt(.systemPromptTemplate) }
        Divider()
        Button("New Bridge Source Prompt") { createPrompt(.bridgeSourcePrompt) }
        Button("New Bridge Target Prompt") { createPrompt(.bridgeTargetPrompt) }
        Button("New Fork Handoff Prompt") { createPrompt(.forkHandoffPrompt) }
        Divider()
        Button("New Ability Creator Prompt") { createPrompt(.abilityCreatorPrompt) }
        Button("New Ability Refiner Prompt") { createPrompt(.abilityRefinerPrompt) }
        Divider()
        Button("New System Ability Template") { createPrompt(.systemAbilityDefaultTemplate) }
        Button("New System Ability Creator Prompt") { createPrompt(.systemAbilityCreatorPrompt) }
    }

    private var sectionFilterBar: some View {
        ScrollViewReader { proxy in
            HStack(spacing: 6) {
                filterStepButton(systemName: "chevron.left", direction: -1, proxy: proxy)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(AgentsCatalogFilter.allCases) { filter in
                            filterChip(filter: filter, proxy: proxy)
                                .id(filter.id)
                        }
                    }
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.trailing, 12)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                filterStepButton(systemName: "chevron.right", direction: 1, proxy: proxy)
            }
            .onAppear { scrollFilterSelection(into: proxy, animated: false) }
            .onChange(of: uiState.selectedFilter) {
                scrollFilterSelection(into: proxy, animated: true)
            }
        }
    }

    private func filterChip(filter: AgentsCatalogFilter, proxy: ScrollViewProxy) -> some View {
        let isSelected = uiState.selectedFilter == filter
        return Button {
            selectFilter(filter)
        } label: {
            Text(TermLoopSidebarTheme.caps(filter.shortTitle))
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .foregroundStyle(isSelected ? Color.white : Color.primary.opacity(0.72))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule()
                        .fill(isSelected ? TermLoopSidebarTheme.accent : Color.primary.opacity(0.06))
                )
                .overlay(
                    Capsule()
                        .stroke(isSelected ? TermLoopSidebarTheme.accent : Color.primary.opacity(0.08), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private var promptTypeFilterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(AgentsCatalogPromptFilter.allCases) { filter in
                    promptTypeChip(filter)
                }
            }
            .fixedSize(horizontal: true, vertical: false)
            .padding(.trailing, 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func promptTypeChip(_ filter: AgentsCatalogPromptFilter) -> some View {
        let isSelected = uiState.selectedPromptFilter == filter
        return Button {
            uiState.selectedPromptFilter = filter
        } label: {
            Text(TermLoopSidebarTheme.caps(filter.title))
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .foregroundStyle(isSelected ? Color.white : Color.primary.opacity(0.68))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    Capsule()
                        .fill(isSelected ? TermLoopSidebarTheme.accent.opacity(0.82) : Color.primary.opacity(0.045))
                )
                .overlay(
                    Capsule()
                        .stroke(isSelected ? TermLoopSidebarTheme.accent.opacity(0.9) : Color.primary.opacity(0.07), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private func filterStepButton(systemName: String, direction: Int, proxy: ScrollViewProxy) -> some View {
        Button {
            stepFilterSelection(direction: direction)
        } label: {
            Image(systemName: systemName)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 20, height: 20)
                .foregroundStyle(Color.primary.opacity(0.7))
        }
        .buttonStyle(.plain)
    }

    private func selectFilter(_ filter: AgentsCatalogFilter) {
        guard uiState.selectedFilter != filter else { return }
        uiState.selectedFilter = filter
        if filter != .prompts {
            uiState.selectedPromptFilter = .system
        }
    }

    private func stepFilterSelection(direction: Int) {
        let all = AgentsCatalogFilter.allCases
        let currentIndex = all.firstIndex(of: uiState.selectedFilter) ?? 0
        let nextIndex = min(max(currentIndex + direction, 0), all.count - 1)
        selectFilter(all[nextIndex])
    }

    private func scrollFilterSelection(into proxy: ScrollViewProxy, animated: Bool) {
        let target = uiState.selectedFilter.id
        if animated {
            withAnimation(.easeInOut(duration: 0.18)) {
                proxy.scrollTo(target, anchor: .center)
            }
        } else {
            proxy.scrollTo(target, anchor: .center)
        }
    }

    private var filteredEntries: [AgentsCatalogEntry] {
        AgentsCatalogContent.filteredEntries(
            searchText: searchText,
            filter: uiState.selectedFilter,
            promptFilter: uiState.selectedPromptFilter,
            templateStore: templateStore,
            promptStore: promptStore
        )
    }

    @ViewBuilder
    private func row(for entry: AgentsCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(entry.title)
                    .font(TermLoopSidebarTheme.bodyMonoStrong)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if entry.scope == .project {
                    TermLoopSidebarToken(label: entry.scope.label, tone: tokenTone(for: entry.scope))
                }
            }
            if !entry.subtitle.isEmpty {
                Text(entry.subtitle)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }

    private var catalogEmptyState: some View {
        Text(searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
             ? "No catalog items in this group."
             : "No matching catalog items.")
            .font(TermLoopSidebarTheme.tinyMono)
            .foregroundStyle(TermLoopSidebarTheme.dimmer)
            .padding(.vertical, 6)
    }


    @ViewBuilder
    private func catalogRows(_ entries: [AgentsCatalogEntry]) -> some View {
        ForEach(entries) { entry in
            row(for: entry)
                .tag(entry.id)
        }
    }

    private func handleCatalogChange() {
        reconcileSelection()
    }

    private func handleProjectChange() {
        refreshProjectCatalogScope()
        uiState.selectedFilter = .templates
        uiState.selectedPromptFilter = .system
        reconcileSelection()
    }

    private func performCatalogAction(_ action: () throws -> Void) {
        do {
            try action()
        } catch {
            NSSound.beep()
            errorMessage = error.localizedDescription
        }
    }

    private func reconcileAfterRemoving(id: String) {
        uiState.reconcileSelection(visibleEntries: filteredEntries.filter { $0.id != id })
    }

    private func tokenTone(for scope: AgentsCatalogEntry.Scope) -> TermLoopSidebarTokenTone {
        switch scope {
        case .project: return .accent
        case .runtime: return .warning
        case .builtin, .user: return .neutral
        case .placeholder: return .muted
        }
    }

    private func refreshProjectCatalogScope() {
        AgentEngine.shared.updateProjectLocalDir(
            AgentTemplateStore.projectTemplatesDir(projectFolderPath: activeProjectFolderPath)
        )
        promptStore.startWatching(projectDir: AgentPromptStore.projectPromptsDir(projectFolderPath: activeProjectFolderPath))
    }

    private func createPrompt(_ kind: AgentPromptDocument.Kind) {
        performCatalogAction {
            let created = try promptStore.createProjectDocument(kind: kind, title: "")
            uiState.showCreatedItem(id: "prompt:\(created.id)", in: AgentsCatalogContent.section(for: kind))
        }
    }

    private func createTemplate() {
        guard let activeProjectFolderPath else { return }
        performCatalogAction {
            let created = try templateStore.createProjectTemplate(projectFolderPath: activeProjectFolderPath, name: "")
            uiState.showCreatedItem(id: "template:\(created.id)", in: .templates)
        }
    }

    private func reconcileSelection() {
        uiState.reconcileSelection(visibleEntries: filteredEntries)
    }
}

@MainActor
final class AgentsCatalogUIState: ObservableObject {
    static let shared = AgentsCatalogUIState()

    @Published var selectionId: String?
    @Published var selectedFilter: AgentsCatalogFilter = .templates
    @Published var selectedPromptFilter: AgentsCatalogPromptFilter = .system
    @Published var statusMessage: String?

    private init() {}

    func reconcileSelection(visibleEntries: [AgentsCatalogEntry]) {
        if let selectionId,
           visibleEntries.contains(where: { $0.id == selectionId }) {
            return
        }
        selectionId = visibleEntries.first?.id
    }

    func showCreatedItem(id: String, in section: AgentsCatalogEntry.Section, message: String? = nil) {
        selectedFilter = AgentsCatalogFilter.filter(for: section)
        selectedPromptFilter = AgentsCatalogPromptFilter.filter(for: section)
        selectionId = id
        statusMessage = message
    }
}

enum AgentsCatalogFilter: String, CaseIterable, Identifiable {
    case templates
    case prompts
    case abilities
    case runtime

    var id: String { rawValue }

    var title: String {
        switch self {
        case .templates: return "Templates"
        case .prompts: return "Prompts"
        case .abilities: return "Abilities"
        case .runtime: return "Runtime"
        }
    }

    var shortTitle: String { title }

    func contains(_ section: AgentsCatalogEntry.Section) -> Bool {
        switch self {
        case .templates:
            return section == .templates
        case .prompts:
            return [.systemPrompts, .bridge, .fork].contains(section)
        case .abilities:
            return [.abilities, .systemAbilities].contains(section)
        case .runtime:
            return section == .runtimeFragments
        }
    }

    static func filter(for section: AgentsCatalogEntry.Section) -> AgentsCatalogFilter {
        switch section {
        case .templates:
            return .templates
        case .systemPrompts, .bridge, .fork:
            return .prompts
        case .abilities, .systemAbilities:
            return .abilities
        case .runtimeFragments:
            return .runtime
        }
    }
}

enum AgentsCatalogPromptFilter: String, CaseIterable, Identifiable {
    case system
    case bridge
    case fork

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .bridge: return "Bridge"
        case .fork: return "Fork"
        }
    }

    func contains(_ section: AgentsCatalogEntry.Section) -> Bool {
        switch self {
        case .system:
            return section == .systemPrompts
        case .bridge:
            return section == .bridge
        case .fork:
            return section == .fork
        }
    }

    static func filter(for section: AgentsCatalogEntry.Section) -> AgentsCatalogPromptFilter {
        switch section {
        case .systemPrompts:
            return .system
        case .bridge:
            return .bridge
        case .fork:
            return .fork
        case .templates, .abilities, .systemAbilities, .runtimeFragments:
            return .system
        }
    }
}

@MainActor
enum AgentsCatalogContent {
    static func entries(
        templateStore: AgentTemplateStore,
        promptStore: AgentPromptStore
    ) -> [AgentsCatalogEntry] {
        templateEntries(from: templateStore) +
        promptEntries(from: promptStore) +
        runtimeFragmentEntries
    }

    static func filteredEntries(
        searchText: String,
        filter: AgentsCatalogFilter = .templates,
        promptFilter: AgentsCatalogPromptFilter = .system,
        templateStore: AgentTemplateStore,
        promptStore: AgentPromptStore
    ) -> [AgentsCatalogEntry] {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return entries(templateStore: templateStore, promptStore: promptStore).filter { entry in
            let matchesSearch = trimmed.isEmpty || entry.searchBlob.localizedCaseInsensitiveContains(trimmed)
            let matchesSection = filter.contains(entry.section)
            let matchesPromptType = filter != .prompts || promptFilter.contains(entry.section)
            return matchesSearch && matchesSection && matchesPromptType
        }
    }

    static func scope(for source: AgentTemplate.Source) -> AgentsCatalogEntry.Scope {
        switch source {
        case .builtin: return .builtin
        case .user: return .user
        case .project: return .project
        }
    }

    static func section(for kind: AgentPromptDocument.Kind) -> AgentsCatalogEntry.Section {
        switch kind {
        case .systemPromptTemplate: return .systemPrompts
        case .bridgeSourcePrompt, .bridgeTargetPrompt: return .bridge
        case .forkHandoffPrompt: return .fork
        case .abilityCreatorPrompt, .abilityRefinerPrompt: return .abilities
        case .systemAbilityDefaultTemplate, .systemAbilityCreatorPrompt: return .systemAbilities
        }
    }

    static func kindLabel(for kind: AgentPromptDocument.Kind) -> String {
        switch kind {
        case .systemPromptTemplate: return "System Instructions"
        case .bridgeSourcePrompt: return "Bridge Source"
        case .bridgeTargetPrompt: return "Bridge Target"
        case .forkHandoffPrompt: return "Fork Prompt"
        case .abilityCreatorPrompt: return "Ability Prompt"
        case .abilityRefinerPrompt: return "Ability Prompt"
        case .systemAbilityDefaultTemplate: return "System Ability"
        case .systemAbilityCreatorPrompt: return "Creator Prompt"
        }
    }

    private static func templateEntries(from templateStore: AgentTemplateStore) -> [AgentsCatalogEntry] {
        templateStore.templates.map { template in
            AgentsCatalogEntry(
                id: "template:\(template.id)",
                section: .templates,
                title: template.name,
                subtitle: template.description.isEmpty ? template.id : template.description,
                body: template.body,
                kindLabel: "Template",
                scope: scope(for: template.source),
                metadata: [
                    .init(label: "ID", value: template.id),
                    .init(label: "Agent", value: template.agentId ?? "default"),
                    .init(label: "Model", value: template.model.rawValue),
                    .init(label: "Reason", value: template.reasoning?.rawValue ?? "default"),
                    .init(label: "Perm", value: template.permissionMode.rawValue),
                    .init(label: "Source", value: template.sourceURL.path),
                    .init(label: "Scope", value: template.scope.rawValue),
                    .init(label: "Lifecycle", value: template.lifecycle.rawValue),
                    .init(label: "System Instructions", value: template.systemPromptDocumentId ?? "—")
                ],
                isEditableHint: true,
                promptDocument: nil,
                template: template
            )
        }
    }

    private static func promptEntries(from promptStore: AgentPromptStore) -> [AgentsCatalogEntry] {
        let docs = promptStore.documents.map { document in
            AgentsCatalogEntry(
                id: "prompt:\(document.id)",
                section: section(for: document.kind),
                title: document.title,
                subtitle: document.subtitle,
                body: document.body,
                kindLabel: kindLabel(for: document.kind),
                scope: document.scope == .builtin ? .builtin : .project,
                metadata: document.metadata.map { .init(label: $0.label, value: $0.value) },
                isEditableHint: true,
                promptDocument: document,
                template: nil
            )
        }
        guard !docs.contains(where: { $0.section == .systemPrompts }) else { return docs }
        return docs + [systemPromptPlaceholderEntry]
    }

    private static var systemPromptPlaceholderEntry: AgentsCatalogEntry {
        AgentsCatalogEntry(
            id: "system:none-yet",
            section: .systemPrompts,
            title: "No project or built-in system instructions yet",
            subtitle: "Add project-scoped reusable system instructions from the + menu.",
            body: "System instructions are still authored per-run in Quick Action. This section now supports project documents; built-in system instruction templates can land later without changing the owner model.",
            kindLabel: "Placeholder",
            scope: .placeholder,
            metadata: [
                .init(label: "Owner", value: "AgentPromptStore")
            ],
            isEditableHint: true,
            promptDocument: nil,
            template: nil
        )
    }

    private static var runtimeFragmentEntries: [AgentsCatalogEntry] {
        [
            AgentsCatalogEntry(
                id: "runtime:claude",
                section: .runtimeFragments,
                title: "Claude delivery mode",
                subtitle: "Delivered through --append-system-prompt.",
                body: "--append-system-prompt {{effective_system_instructions}}",
                kindLabel: "Runtime",
                scope: .runtime,
                metadata: [
                    .init(label: "Mode", value: AgentSystemPromptInjector.DeliveryMode.appendSystemPromptFlag.rawValue),
                    .init(label: "Owner", value: "AgentInvocationTransportAdapter")
                ],
                isEditableHint: false,
                promptDocument: nil,
                template: nil
            ),
            AgentsCatalogEntry(
                id: "runtime:codex",
                section: .runtimeFragments,
                title: "Codex delivery mode",
                subtitle: "Delivered through a generated instructions file.",
                body: "-c model_instructions_file=\"{{instructions_file_path}}\"\n\nFile contents:\n{{effective_system_instructions}}",
                kindLabel: "Runtime",
                scope: .runtime,
                metadata: [
                    .init(label: "Mode", value: AgentSystemPromptInjector.DeliveryMode.instructionsFile.rawValue),
                    .init(label: "Owner", value: "AgentInvocationTransportAdapter")
                ],
                isEditableHint: false,
                promptDocument: nil,
                template: nil
            ),
            AgentsCatalogEntry(
                id: "runtime:prefix",
                section: .runtimeFragments,
                title: "Generic prefix delivery mode",
                subtitle: "Fallback transport for agents without native system-prompt flags.",
                body: "System instructions for this session:\n{{effective_system_instructions}}\n\n---\n\n{{initial_prompt}}",
                kindLabel: "Runtime",
                scope: .runtime,
                metadata: [
                    .init(label: "Mode", value: AgentSystemPromptInjector.DeliveryMode.promptPrefix.rawValue),
                    .init(label: "Owner", value: "AgentInvocationTransportAdapter")
                ],
                isEditableHint: false,
                promptDocument: nil,
                template: nil
            )
        ]
    }
}

struct AgentsCatalogMainAreaView: View {
    @ObservedObject private var templateStore = AgentTemplateStore.shared
    @ObservedObject private var promptStore = AgentPromptStore.shared
    @ObservedObject private var projectStore = ProjectStore.shared
    @ObservedObject private var uiState = AgentsCatalogUIState.shared
    @State private var errorMessage: String?

    private var activeProjectFolderPath: String? {
        projectStore.activeProjectId.flatMap { projectStore.project(id: $0)?.folderPath }
    }

    private var visibleEntries: [AgentsCatalogEntry] {
        AgentsCatalogContent.filteredEntries(
            searchText: "",
            filter: uiState.selectedFilter,
            promptFilter: uiState.selectedPromptFilter,
            templateStore: templateStore,
            promptStore: promptStore
        )
    }

    private var selectedEntry: AgentsCatalogEntry? {
        visibleEntries.first { $0.id == uiState.selectionId }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Templates & Prompts")
                    .font(.system(size: 18, weight: .semibold, design: .monospaced))
                Text("·")
                    .foregroundStyle(Color.primary.opacity(0.4))
                Text(selectedFilterTitle)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.primary.opacity(0.55))
                Spacer(minLength: 0)
                if let statusMessage = uiState.statusMessage {
                    Text(statusMessage)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(TermLoopSidebarTheme.accent.opacity(0.9))
                }
                if activeProjectFolderPath == nil {
                    Text("Select a project to customize catalog items.")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.primary.opacity(0.55))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            Divider()

            if selectedEntry == nil,
               visibleEntries.isEmpty {
                filterEmptyState(uiState.selectedFilter)
            } else {
                AgentsCatalogDetailPane(
                    entry: selectedEntry,
                    canEditProjectPrompts: activeProjectFolderPath != nil,
                    canEditProjectTemplates: activeProjectFolderPath != nil,
                    onSaveProjectTemplate: saveSelectedTemplate,
                    onDeleteProjectTemplate: deleteSelectedTemplate,
                    canResetTemplateToDefault: selectedTemplateCanReset,
                    canResetPromptToDefault: selectedPromptCanReset,
                    onSaveProjectPrompt: saveSelectedPrompt,
                    onDeleteProjectPrompt: deleteSelectedPrompt
                )
                .id(selectedEntry.map { "\($0.id):\($0.scope.rawValue)" } ?? "none")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
        .alert(
            "Catalog action failed",
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
    }

    private var selectedFilterTitle: String {
        if uiState.selectedFilter == .prompts {
            return "\(uiState.selectedFilter.title) / \(uiState.selectedPromptFilter.title)"
        }
        return uiState.selectedFilter.title
    }


    private func filterEmptyState(_ filter: AgentsCatalogFilter) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(TermLoopSidebarTheme.caps(filter.title))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            Text("No items in this group for the active project yet.")
                .font(TermLoopSidebarTheme.bodyMonoStrong)
            Text(emptyStateBody(for: filter))
                .font(TermLoopSidebarTheme.bodyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func emptyStateBody(for filter: AgentsCatalogFilter) -> String {
        switch filter {
        case .templates:
            return "Create a project template from the + menu, or edit a built-in template and save it as a project override."
        case .prompts:
            return "Create a reusable project prompt from the + menu, or edit a built-in prompt and save it as a project override."
        case .abilities:
            return "Create ability prompt overrides from the + menu, or edit a built-in ability prompt and save it as a project override."
        case .runtime:
            return "Runtime fragments are generated views."
        }
    }

    private func saveSelectedPrompt(title: String, body: String) {
        guard let document = selectedEntry?.promptDocument else { return }
        performCatalogAction {
            let saved = try promptStore.saveProjectDocument(document, title: title, body: body)
            uiState.showCreatedItem(
                id: "prompt:\(saved.id)",
                in: AgentsCatalogContent.section(for: saved.kind),
                message: document.scope == .project ? "Prompt saved" : "Project override saved"
            )
        }
    }

    private func deleteSelectedPrompt() {
        guard let document = selectedEntry?.promptDocument, document.scope == .project else { return }
        let resetsToDefault = selectedPromptCanReset
        performCatalogAction {
            try promptStore.deleteProjectDocument(document)
            if resetsToDefault {
                uiState.showCreatedItem(
                    id: "prompt:\(document.id)",
                    in: AgentsCatalogContent.section(for: document.kind),
                    message: "Reset to default"
                )
            } else {
                reconcileAfterRemoving(id: "prompt:\(document.id)")
            }
        }
    }

    private func saveSelectedTemplate(_ draft: AgentsCatalogTemplateDraft) {
        guard let template = selectedEntry?.template,
              let activeProjectFolderPath else { return }
        performCatalogAction {
            let saved = try templateStore.saveProjectTemplate(
                template,
                projectFolderPath: activeProjectFolderPath,
                name: draft.name,
                description: draft.description,
                icon: draft.icon,
                agentId: draft.agentId,
                model: draft.model,
                reasoning: draft.reasoning,
                permissionMode: draft.permissionMode,
                lifecycle: draft.lifecycle,
                scope: draft.scope,
                logging: draft.logging,
                triggers: draft.triggers,
                defaultAttach: draft.defaultAttach,
                cleanup: draft.cleanup,
                variables: draft.variables,
                timeoutSeconds: draft.timeoutSeconds,
                promptDocumentId: nil,
                systemPromptDocumentId: draft.systemPromptDocumentId,
                body: draft.body
            )
            uiState.showCreatedItem(
                id: "template:\(saved.id)",
                in: .templates,
                message: template.source == .project ? "Template saved" : "Project override saved"
            )
        }
    }

    private func deleteSelectedTemplate() {
        guard let template = selectedEntry?.template else { return }
        let resetsToDefault = selectedTemplateCanReset
        performCatalogAction {
            switch template.source {
            case .project:
                try templateStore.deleteProjectTemplate(template)
            case .user:
                try templateStore.deleteUserTemplate(template)
            case .builtin:
                guard let activeProjectFolderPath else {
                    throw NSError(domain: "AgentsCatalog", code: 1, userInfo: [NSLocalizedDescriptionKey: "No active project selected."])
                }
                try templateStore.deleteBuiltInTemplateFromProject(
                    template,
                    projectFolderPath: activeProjectFolderPath
                )
            }

            if resetsToDefault {
                uiState.showCreatedItem(
                    id: "template:\(template.id)",
                    in: .templates,
                    message: "Reset to default"
                )
            } else {
                reconcileAfterRemoving(id: "template:\(template.id)")
                uiState.statusMessage = template.source == .builtin
                    ? "Template removed from this project"
                    : "Template deleted"
            }
        }
    }

    private var selectedTemplateCanReset: Bool {
        guard let template = selectedEntry?.template, template.source == .project else { return false }
        return templateStore.hasDefaultTemplate(id: template.id)
    }

    private var selectedPromptCanReset: Bool {
        guard let document = selectedEntry?.promptDocument, document.scope == .project else { return false }
        return promptStore.hasDefaultDocument(id: document.id)
    }

    private func performCatalogAction(_ action: () throws -> Void) {
        do {
            try action()
        } catch {
            NSSound.beep()
            errorMessage = error.localizedDescription
        }
    }

    private func reconcileAfterRemoving(id: String) {
        uiState.reconcileSelection(visibleEntries: visibleEntries.filter { $0.id != id })
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct AgentsSidebarView: View {
    @ObservedObject private var templateStore = AgentTemplateStore.shared
    @ObservedObject private var promptStore = AgentPromptStore.shared
    @ObservedObject private var projectStore = ProjectStore.shared
    @ObservedObject private var uiState = AgentsCatalogUIState.shared
    @State private var searchText: String = ""

    var body: some View {
        VStack(spacing: 8) {
            toolbar
            sectionFilterBar
                .padding(.horizontal, 8)
            List(selection: $uiState.selectionId) {
                if uiState.selectedSectionFilter != nil {
                    catalogRows(filteredEntries)
                } else {
                    ForEach(filteredSections, id: \.0.id) { section, entries in
                        Section {
                            catalogRows(entries)
                        } header: {
                            Text(TermLoopSidebarTheme.caps(section.title))
                                .font(TermLoopSidebarTheme.sectionCaps)
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                        }
                    }
                }
            }
            .listStyle(.sidebar)

            HStack {
                Text("Select an item to edit in the main area.")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dimmer)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
        }
        .frame(minWidth: 270, idealWidth: 320)
        .onAppear {
            refreshPromptScope()
            reconcileSelection()
        }
        .onChange(of: searchText) { _ in
            handleCatalogChange()
        }
        .onChange(of: templateStore.templates.map(\.id)) { _ in
            handleCatalogChange()
        }
        .onChange(of: promptStore.documents.map(\.id)) { _ in
            handleCatalogChange()
        }
        .onChange(of: projectStore.activeProjectId) { _ in
            handleProjectChange()
        }
        .onChange(of: uiState.selectedSectionFilter) { _ in
            handleCatalogChange()
        }
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            TextField("Search prompts and templates", text: $searchText)
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
        Button("New System Prompt") { createPrompt(.systemPromptTemplate) }
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
                        filterChip(title: "All", section: nil, proxy: proxy)
                            .id("all")
                        ForEach(AgentsCatalogEntry.Section.allCases) { section in
                            filterChip(title: section.shortTitle, section: section, proxy: proxy)
                                .id(section.id)
                        }
                    }
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.trailing, 12)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                filterStepButton(systemName: "chevron.right", direction: 1, proxy: proxy)
            }
            .onAppear { scrollFilterSelection(into: proxy, animated: false) }
            .onChange(of: uiState.selectedSectionFilter) { _ in
                scrollFilterSelection(into: proxy, animated: true)
            }
        }
    }

    private func filterChip(title: String, section: AgentsCatalogEntry.Section?, proxy: ScrollViewProxy) -> some View {
        let isSelected = uiState.selectedSectionFilter == section
        return Button {
            selectFilter(section)
        } label: {
            Text(TermLoopSidebarTheme.caps(title))
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

    private func selectFilter(_ section: AgentsCatalogEntry.Section?) {
        guard uiState.selectedSectionFilter != section else { return }
        uiState.selectedSectionFilter = section
    }

    private func stepFilterSelection(direction: Int) {
        let all: [AgentsCatalogEntry.Section?] = [nil] + AgentsCatalogEntry.Section.allCases.map(Optional.some)
        let currentIndex = all.firstIndex(where: { $0 == uiState.selectedSectionFilter }) ?? 0
        let nextIndex = min(max(currentIndex + direction, 0), all.count - 1)
        selectFilter(all[nextIndex])
    }

    private func scrollFilterSelection(into proxy: ScrollViewProxy, animated: Bool) {
        let target = uiState.selectedSectionFilter?.id ?? "all"
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
            sectionFilter: uiState.selectedSectionFilter,
            templateStore: templateStore,
            promptStore: promptStore
        )
    }

    private var filteredSections: [(AgentsCatalogEntry.Section, [AgentsCatalogEntry])] {
        AgentsCatalogContent.filteredSections(entries: filteredEntries)
    }

    @ViewBuilder
    private func row(for entry: AgentsCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(entry.title)
                    .font(TermLoopSidebarTheme.bodyMonoStrong)
                    .lineLimit(1)
                Spacer(minLength: 0)
                TermLoopSidebarToken(label: entry.scope.label, tone: tokenTone(for: entry.scope))
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
        refreshPromptScope()
        uiState.selectedSectionFilter = nil
        reconcileSelection()
    }

    private func performCatalogAction(_ action: () throws -> Void) {
        do {
            try action()
        } catch {
            NSSound.beep()
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

    private func refreshPromptScope() {
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
    @Published var selectedSectionFilter: AgentsCatalogEntry.Section?

    private init() {}

    func reconcileSelection(visibleEntries: [AgentsCatalogEntry]) {
        if let selectionId,
           visibleEntries.contains(where: { $0.id == selectionId }) {
            return
        }
        selectionId = visibleEntries.first?.id
    }

    func showCreatedItem(id: String, in section: AgentsCatalogEntry.Section) {
        objectWillChange.send()
        selectedSectionFilter = section
        selectionId = id
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
        sectionFilter: AgentsCatalogEntry.Section? = nil,
        templateStore: AgentTemplateStore,
        promptStore: AgentPromptStore
    ) -> [AgentsCatalogEntry] {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return entries(templateStore: templateStore, promptStore: promptStore).filter { entry in
            let matchesSearch = trimmed.isEmpty || entry.searchBlob.localizedCaseInsensitiveContains(trimmed)
            let matchesSection = sectionFilter == nil || entry.section == sectionFilter
            return matchesSearch && matchesSection
        }
    }

    static func filteredSections(entries: [AgentsCatalogEntry]) -> [(AgentsCatalogEntry.Section, [AgentsCatalogEntry])] {
        let grouped = Dictionary(grouping: entries, by: \.section)
        return AgentsCatalogEntry.Section.allCases.compactMap { section in
            guard let sectionEntries = grouped[section], !sectionEntries.isEmpty else { return nil }
            return (section, sectionEntries)
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
        case .systemPromptTemplate: return "System Prompt"
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
                    .init(label: "Model", value: template.model.rawValue),
                    .init(label: "Perm", value: template.permissionMode.rawValue),
                    .init(label: "Source", value: template.sourceURL.path),
                    .init(label: "Scope", value: template.scope.rawValue),
                    .init(label: "Lifecycle", value: template.lifecycle.rawValue),
                    .init(label: "Prompt Doc", value: template.promptDocumentId ?? "—"),
                    .init(label: "System Doc", value: template.systemPromptDocumentId ?? "—")
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
            title: "No project or built-in system prompt templates yet",
            subtitle: "Add a project-scoped reusable system prompt from the + menu.",
            body: "System prompts are still authored per-run in Quick Action. This section now supports project documents; built-in system prompt templates can land later without changing the owner model.",
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

    private var activeProjectFolderPath: String? {
        projectStore.activeProjectId.flatMap { projectStore.project(id: $0)?.folderPath }
    }

    private var entries: [AgentsCatalogEntry] {
        AgentsCatalogContent.entries(templateStore: templateStore, promptStore: promptStore)
    }

    private var visibleEntries: [AgentsCatalogEntry] {
        guard let selectedSectionFilter = uiState.selectedSectionFilter else { return entries }
        return entries.filter { $0.section == selectedSectionFilter }
    }

    private var selectedEntry: AgentsCatalogEntry? {
        visibleEntries.first { $0.id == uiState.selectionId }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Agents Catalog")
                    .font(.system(size: 18, weight: .semibold, design: .monospaced))
                if let selectedSectionFilter = uiState.selectedSectionFilter {
                    Text("·")
                        .foregroundStyle(Color.primary.opacity(0.4))
                    Text(selectedSectionFilter.title)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.primary.opacity(0.55))
                } else if let selectedEntry {
                    Text("·")
                        .foregroundStyle(Color.primary.opacity(0.4))
                    Text(selectedEntry.section.title)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.primary.opacity(0.55))
                }
                Spacer(minLength: 0)
                if activeProjectFolderPath == nil {
                    Text("Select an active project to edit project catalog items.")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.primary.opacity(0.55))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            Divider()

            if selectedEntry == nil,
               let selectedSectionFilter = uiState.selectedSectionFilter,
               visibleEntries.isEmpty {
                filterEmptyState(selectedSectionFilter)
            } else {
                AgentsCatalogDetailPane(
                    entry: selectedEntry,
                    canEditProjectPrompts: activeProjectFolderPath != nil,
                    canEditProjectTemplates: activeProjectFolderPath != nil,
                    onDuplicateTemplateToProject: duplicateSelectedTemplateToProject,
                    onSaveProjectTemplate: saveSelectedTemplate,
                    onDeleteProjectTemplate: deleteSelectedTemplate,
                    onDuplicateToProject: duplicateSelectedPromptToProject,
                    onSaveProjectPrompt: saveSelectedPrompt,
                    onDeleteProjectPrompt: deleteSelectedPrompt
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
    }


    private func filterEmptyState(_ filter: AgentsCatalogEntry.Section) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(TermLoopSidebarTheme.caps(filter.title))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            Text("No items in this section for the active project yet.")
                .font(TermLoopSidebarTheme.bodyMonoStrong)
            Text(emptyStateBody(for: filter))
                .font(TermLoopSidebarTheme.bodyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func emptyStateBody(for filter: AgentsCatalogEntry.Section) -> String {
        switch filter {
        case .templates:
            return "Create a project template from the + menu, or duplicate a built-in template into the project catalog."
        case .systemPrompts:
            return "Create a reusable project system prompt from the + menu."
        case .bridge:
            return "Create bridge / ask-agent prompt overrides from the + menu."
        case .fork:
            return "Create a fork / handoff prompt override from the + menu."
        case .abilities:
            return "Create ability creator or refiner prompt overrides from the + menu."
        case .systemAbilities:
            return "Create a system ability template or creator prompt override from the + menu."
        case .runtimeFragments:
            return "Runtime fragments are generated views. Clear the filter to see built-in runtime entries."
        }
    }

    private func duplicateSelectedPromptToProject() {
        guard let document = selectedEntry?.promptDocument, document.scope == .builtin else { return }
        performCatalogAction {
            try promptStore.duplicateBuiltInToProject(id: document.id)
            uiState.showCreatedItem(id: "prompt:\(document.id)", in: AgentsCatalogContent.section(for: document.kind))
        }
    }

    private func saveSelectedPrompt(title: String, body: String) {
        guard let document = selectedEntry?.promptDocument, document.scope == .project else { return }
        performCatalogAction {
            try promptStore.saveProjectDocument(document, title: title, body: body)
        }
    }

    private func deleteSelectedPrompt() {
        guard let document = selectedEntry?.promptDocument, document.scope == .project else { return }
        performCatalogAction {
            try promptStore.deleteProjectDocument(document)
            reconcileAfterRemoving(id: "prompt:\(document.id)")
        }
    }

    private func duplicateSelectedTemplateToProject() {
        guard let template = selectedEntry?.template,
              template.source != .project,
              let activeProjectFolderPath else { return }
        performCatalogAction {
            try templateStore.duplicateTemplateToProject(id: template.id, projectFolderPath: activeProjectFolderPath)
            uiState.showCreatedItem(id: "template:\(template.id)", in: .templates)
        }
    }

    private func saveSelectedTemplate(
        name: String,
        description: String,
        model: AgentTemplate.Model,
        permissionMode: AgentTemplate.PermissionMode,
        lifecycle: AgentTemplate.Lifecycle,
        scope: AgentTemplate.Scope,
        promptDocumentId: String?,
        systemPromptDocumentId: String?,
        body: String
    ) {
        guard let template = selectedEntry?.template,
              template.source == .project,
              let activeProjectFolderPath else { return }
        performCatalogAction {
            try templateStore.saveProjectTemplate(
                template,
                projectFolderPath: activeProjectFolderPath,
                name: name,
                description: description,
                model: model,
                permissionMode: permissionMode,
                lifecycle: lifecycle,
                scope: scope,
                promptDocumentId: promptDocumentId,
                systemPromptDocumentId: systemPromptDocumentId,
                body: body
            )
        }
    }

    private func deleteSelectedTemplate() {
        guard let template = selectedEntry?.template, template.source == .project else { return }
        performCatalogAction {
            try templateStore.deleteProjectTemplate(template)
            reconcileAfterRemoving(id: "template:\(template.id)")
        }
    }

    private func performCatalogAction(_ action: () throws -> Void) {
        do {
            try action()
        } catch {
            NSSound.beep()
        }
    }

    private func reconcileAfterRemoving(id: String) {
        uiState.reconcileSelection(visibleEntries: visibleEntries.filter { $0.id != id })
    }
}

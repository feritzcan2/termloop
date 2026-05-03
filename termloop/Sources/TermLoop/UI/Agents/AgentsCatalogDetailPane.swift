// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct AgentsCatalogTemplateDraft {
    let name: String
    let description: String
    let icon: String
    let agentId: String?
    let model: AgentModelOption
    let reasoning: AgentReasoningOption?
    let permissionMode: AgentTemplate.PermissionMode
    let lifecycle: AgentTemplate.Lifecycle
    let scope: AgentTemplate.Scope
    let logging: AgentTemplate.Logging
    let triggers: [AgentTemplate.Trigger]
    let defaultAttach: Bool
    let cleanup: AgentTemplate.Cleanup
    let variables: [String]
    let timeoutSeconds: Int
    let systemPromptDocumentId: String?
    let body: String
}

struct AgentsCatalogDetailPane: View {
    @ObservedObject private var agentCatalogStore = AgentCatalogStore.shared
    @ObservedObject private var promptStore = AgentPromptStore.shared
    @ObservedObject private var projectStore = ProjectStore.shared
    let entry: AgentsCatalogEntry?
    let canEditProjectPrompts: Bool
    let canEditProjectTemplates: Bool
    let onSaveProjectTemplate: (AgentsCatalogTemplateDraft) -> Void
    let onDeleteProjectTemplate: () -> Void
    let canResetTemplateToDefault: Bool
    let canResetPromptToDefault: Bool
    let onSaveProjectPrompt: (String, String) -> Void
    let onDeleteProjectPrompt: () -> Void

    @State private var draftTitle: String = ""
    @State private var draftSubtitle: String = ""
    @State private var draftIcon: String = ""
    @State private var draftBody: String = ""
    @State private var draftAgentId: String?
    @State private var draftTemplateModel: AgentModelOption = .default
    @State private var draftReasoning: AgentReasoningOption = .default
    @State private var draftPermissionMode: AgentTemplate.PermissionMode = .bypassPermissions
    @State private var draftLifecycle: AgentTemplate.Lifecycle = .detached
    @State private var draftTemplateScope: AgentTemplate.Scope = .workspace
    @State private var draftLogging: AgentTemplate.Logging = .file
    @State private var draftCleanup: AgentTemplate.Cleanup = .none
    @State private var draftDefaultAttach: Bool = false
    @State private var draftTriggerManual: Bool = true
    @State private var draftTriggerOnWorkspaceClose: Bool = false
    @State private var draftVariablesText: String = ""
    @State private var draftTimeoutSecondsText: String = "600"
    @State private var draftSystemPromptDocumentId: String?

    var body: some View {
        Group {
            if let entry {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        header(entry)
                        TermLoopSidebarRule()

                        if let template = entry.template {
                            templateEditor(entry: entry, template: template)
                        } else if let document = entry.promptDocument {
                            promptEditor(entry: entry, document: document)
                        } else {
                            readOnlyBody(entry)
                        }

                        TermLoopSidebarRule()
                        footerNote(entry)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .onAppear { syncDrafts(for: entry) }
                .onChange(of: entry.id) { syncDrafts(for: entry) }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text(TermLoopSidebarTheme.caps("Templates & Prompts"))
                        .font(TermLoopSidebarTheme.sectionCaps)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                    Text("Select a template or prompt on the left. Editing a built-in template saves a project override you can reset later.")
                        .font(TermLoopSidebarTheme.bodyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                }
                .padding(12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .background(Color.clear)
    }

    private func header(_ entry: AgentsCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Text(entry.title)
                    .font(TermLoopSidebarTheme.bodyMonoStrong)
                    .textSelection(.enabled)
                Spacer(minLength: 10)
                primaryAction(for: entry)
            }
            if !entry.subtitle.isEmpty {
                Text(entry.subtitle)
                    .font(TermLoopSidebarTheme.bodyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private func primaryAction(for entry: AgentsCatalogEntry) -> some View {
        if let template = entry.template, template.source != .project {
            if canEditProjectTemplates {
                Text("Editing creates a project override")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
            }
        } else if let document = entry.promptDocument,
                  document.scope == .builtin,
                  canEditProjectPrompts {
            Text("Editing creates a project override")
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
        }
    }

    private func templateEditor(entry: AgentsCatalogEntry, template: AgentTemplate) -> some View {
        let canEditTemplate = template.source == .project || canEditProjectTemplates
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(TermLoopSidebarTheme.caps("Template"))
                    .font(TermLoopSidebarTheme.sectionCaps)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                Spacer(minLength: 0)
                if template.source == .project {
                    Button(canResetTemplateToDefault ? "Reset to Default" : "Delete", role: .destructive, action: onDeleteProjectTemplate)
                }
                if canEditTemplate {
                    Button {
                        onSaveProjectTemplate(templateDraft())
                    } label: {
                        Label(
                            template.source == .project ? "Save Template" : "Save Override",
                            systemImage: "checkmark.circle.fill"
                        )
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    .keyboardShortcut("s", modifiers: [.command])
                    .help(template.source == .project
                          ? "Save changes to this project template."
                          : "Save these edits as a project override.")
                }
            }

            field(label: "Name") {
                if !canEditTemplate {
                    Text(entry.title).font(TermLoopSidebarTheme.bodyMono).textSelection(.enabled)
                } else {
                    TextField("Template name", text: $draftTitle)
                        .textFieldStyle(.roundedBorder)
                        .font(TermLoopSidebarTheme.bodyMono)
                }
            }

            field(label: "Description") {
                if !canEditTemplate {
                    Text(entry.subtitle).font(TermLoopSidebarTheme.bodyMono).textSelection(.enabled)
                } else {
                    TextField("Template description", text: $draftSubtitle)
                        .textFieldStyle(.roundedBorder)
                        .font(TermLoopSidebarTheme.bodyMono)
                }
            }

            HStack(spacing: 10) {
                field(label: "Agent") {
                    if !canEditTemplate {
                        Text(templateAgentLabel(template.agentId))
                            .font(TermLoopSidebarTheme.bodyMono)
                            .textSelection(.enabled)
                    } else {
                        Picker("", selection: $draftAgentId) {
                            Text("Default").tag(Optional<String>.none)
                            ForEach(agentCatalogStore.agents, id: \.id) { agent in
                                Text(agent.displayName).tag(Optional(agent.id))
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                }
                field(label: "Model") {
                    if !canEditTemplate {
                        Text(template.model.displayLabel)
                            .font(TermLoopSidebarTheme.bodyMono)
                    } else {
                        Picker("", selection: $draftTemplateModel) {
                            ForEach(draftModelOptions, id: \.self) { option in
                                Text(option.displayLabel).tag(option)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                }
                if !draftReasoningOptions.isEmpty {
                    field(label: "Reason") {
                        if !canEditTemplate {
                            Text(template.reasoning?.rawValue ?? AgentReasoningOption.default.rawValue)
                                .font(TermLoopSidebarTheme.bodyMono)
                        } else {
                            Picker("", selection: $draftReasoning) {
                                ForEach(draftReasoningOptions, id: \.self) { option in
                                    Text(option.rawValue).tag(option)
                                }
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                        }
                    }
                }
            }

            field(label: "System Instructions") {
                if !canEditTemplate {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(linkedPromptTitle(id: template.systemPromptDocumentId) ?? template.systemPromptDocumentId ?? "—")
                            .font(TermLoopSidebarTheme.bodyMono)
                        if let systemPromptDocumentId = template.systemPromptDocumentId {
                            Text(systemPromptDocumentId)
                                .font(TermLoopSidebarTheme.tinyMono)
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                        }
                    }
                } else {
                    Picker("", selection: $draftSystemPromptDocumentId) {
                        Text("none").tag(Optional<String>.none)
                        ForEach(promptStore.documents.filter { $0.kind.canBackSystemPrompt }, id: \.id) { document in
                            Text(document.title).tag(Optional(document.id))
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                }
            }

            Text(TermLoopSidebarTheme.caps("Prompt Body"))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            if !canEditTemplate {
                codeBlock(entry.body)
            } else {
                PromptTextEditor(text: $draftBody, minHeight: 280)
            }

            let selectedSystemDocumentId = canEditTemplate
                ? draftSystemPromptDocumentId
                : template.systemPromptDocumentId
            if let systemDocument = linkedPromptDocument(id: selectedSystemDocumentId) {
                Text(TermLoopSidebarTheme.caps("Selected System Instructions"))
                    .font(TermLoopSidebarTheme.sectionCaps)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                VStack(alignment: .leading, spacing: 6) {
                    Text(systemDocument.title)
                        .font(TermLoopSidebarTheme.bodyMonoStrong)
                        .textSelection(.enabled)
                    if !systemDocument.subtitle.isEmpty {
                        Text(systemDocument.subtitle)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .textSelection(.enabled)
                    }
                    codeBlock(systemDocument.body)
                }
            }
        }
        .onChange(of: draftAgentId) { normalizeDraftRuntimeDefaults() }
    }

    private func promptEditor(entry: AgentsCatalogEntry, document: AgentPromptDocument) -> some View {
        let canEditPrompt = document.scope == .project || canEditProjectPrompts
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(TermLoopSidebarTheme.caps("Title"))
                    .font(TermLoopSidebarTheme.sectionCaps)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                Spacer(minLength: 0)
                if document.scope == .project {
                    Button(canResetPromptToDefault ? "Reset to Default" : "Delete", role: .destructive, action: onDeleteProjectPrompt)
                }
                if canEditPrompt {
                    Button {
                        onSaveProjectPrompt(draftTitle, draftBody)
                    } label: {
                        Label(
                            document.scope == .project ? "Save Prompt" : "Save Override",
                            systemImage: "checkmark.circle.fill"
                        )
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    .keyboardShortcut("s", modifiers: [.command])
                    .help(document.scope == .project
                          ? "Save changes to this project prompt."
                          : "Save these edits as a project override.")
                }
            }
            if !canEditPrompt {
                Text(entry.title)
                    .font(TermLoopSidebarTheme.bodyMono)
                    .textSelection(.enabled)
            } else {
                TextField("Prompt title", text: $draftTitle)
                    .textFieldStyle(.roundedBorder)
                    .font(TermLoopSidebarTheme.bodyMono)
            }

            field(label: "Usage") {
                Text(document.kind.usageLabel)
                    .font(TermLoopSidebarTheme.bodyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
            }

            Text(TermLoopSidebarTheme.caps("Body"))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            if !canEditPrompt {
                codeBlock(entry.body)
            } else {
                PromptTextEditor(text: $draftBody, minHeight: 260)
            }
        }
    }

    private func field<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(TermLoopSidebarTheme.caps(label))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            content()
        }
    }

    private func readOnlyBody(_ entry: AgentsCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(TermLoopSidebarTheme.caps(entry.isEditableHint ? "Body" : "Body / Preview"))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            codeBlock(entry.body)
        }
    }

    private func codeBlock(_ text: String) -> some View {
        ZStack(alignment: .topTrailing) {
            Text(verbatim: text.isEmpty ? "—" : text)
                .font(.system(size: 11, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .padding(.trailing, 28)
                .textSelection(.enabled)
            Button {
                copyToPasteboard(text)
            } label: {
                Image(systemName: "doc.on.doc")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.plain)
            .foregroundStyle(TermLoopSidebarTheme.dim)
            .help("Copy prompt text")
            .padding(6)
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(MarkdownTheme.insetBg)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(MarkdownTheme.codeBorder, lineWidth: 1)
        )
    }

    private func copyToPasteboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func templateDraft() -> AgentsCatalogTemplateDraft {
        AgentsCatalogTemplateDraft(
            name: draftTitle,
            description: draftSubtitle,
            icon: draftIcon,
            agentId: normalizedAgentId(draftAgentId),
            model: agentCatalogStore.resolveModel(draftTemplateModel, for: draftEffectiveAgentId),
            reasoning: agentCatalogStore.resolveReasoning(draftReasoning, for: draftEffectiveAgentId),
            permissionMode: draftPermissionMode,
            lifecycle: draftLifecycle,
            scope: draftTemplateScope,
            logging: draftLogging,
            triggers: resolvedDraftTriggers(),
            defaultAttach: draftDefaultAttach,
            cleanup: draftCleanup,
            variables: resolvedDraftVariables(),
            timeoutSeconds: resolvedDraftTimeoutSeconds(),
            systemPromptDocumentId: draftSystemPromptDocumentId,
            body: draftBody
        )
    }

    private func resolvedDraftTriggers() -> [AgentTemplate.Trigger] {
        var triggers: [AgentTemplate.Trigger] = []
        if draftTriggerManual { triggers.append(.manual) }
        if draftTriggerOnWorkspaceClose { triggers.append(.onWorkspaceClose) }
        return triggers.isEmpty ? [.manual] : triggers
    }

    private func resolvedDraftVariables() -> [String] {
        draftVariablesText
            .components(separatedBy: CharacterSet(charactersIn: ",\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func resolvedDraftTimeoutSeconds() -> Int {
        let trimmed = draftTimeoutSecondsText.trimmingCharacters(in: .whitespacesAndNewlines)
        return max(1, Int(trimmed) ?? 600)
    }

    private func footerNote(_ entry: AgentsCatalogEntry) -> some View {
        Text(note(for: entry))
            .font(TermLoopSidebarTheme.tinyMono)
            .foregroundStyle(TermLoopSidebarTheme.dimmer)
    }

    private func note(for entry: AgentsCatalogEntry) -> String {
        if let template = entry.template {
            switch template.source {
            case .builtin:
                return "Built-in template. Saving creates a project override; reset later to return to the default."
            case .user:
                return "User template. Saving creates a project override for the active project."
            case .project:
                return canResetTemplateToDefault
                    ? "Project override. Reset deletes the override and returns this template to its default."
                    : "Project template. Saving writes back to the active project's .termloop/templates catalog."
            }
        }
        if let document = entry.promptDocument {
            switch document.scope {
            case .builtin:
                return "Built-in prompt. Saving creates a project override; reset later to return to the default."
            case .project:
                return canResetPromptToDefault
                    ? "Project override. Reset deletes the override and returns this prompt to its default."
                    : "Project prompt document. Saving writes back to the active project's .termloop/prompts catalog."
            }
        }
        return "Read-only view. Runtime fragments remain projections from transport/runtime owners."
    }

    private func syncDrafts(for entry: AgentsCatalogEntry) {
        draftTitle = entry.template?.name ?? entry.promptDocument?.title ?? entry.title
        draftSubtitle = entry.template?.description ?? entry.subtitle
        draftIcon = entry.template?.icon ?? ""
        draftBody = entry.template?.body ?? entry.promptDocument?.body ?? entry.body
        draftAgentId = entry.template?.agentId
        draftTemplateModel = entry.template?.model ?? .default
        draftReasoning = entry.template?.reasoning ?? .default
        draftPermissionMode = entry.template?.permissionMode ?? .bypassPermissions
        draftLifecycle = entry.template?.lifecycle ?? .detached
        draftTemplateScope = entry.template?.scope ?? .workspace
        draftLogging = entry.template?.logging ?? .file
        draftCleanup = entry.template?.cleanup ?? .none
        draftDefaultAttach = entry.template?.defaultAttach ?? false
        let triggers = entry.template?.triggers ?? [.manual]
        draftTriggerManual = triggers.contains(.manual)
        draftTriggerOnWorkspaceClose = triggers.contains(.onWorkspaceClose)
        draftVariablesText = entry.template?.variables.joined(separator: ", ") ?? ""
        draftTimeoutSecondsText = "\(entry.template?.timeoutSeconds ?? 600)"
        draftSystemPromptDocumentId = entry.template?.systemPromptDocumentId
        normalizeDraftRuntimeDefaults()
    }

    private var activeProjectFolderPath: String? {
        projectStore.activeProjectId.flatMap { projectStore.project(id: $0)?.folderPath }
    }

    private func linkedPromptDocument(id: String?) -> AgentPromptDocument? {
        guard let id else { return nil }
        return AgentPromptStore.lookup(id: id, projectFolderPath: activeProjectFolderPath)
    }

    private func linkedPromptTitle(id: String?) -> String? {
        linkedPromptDocument(id: id)?.title
    }

    private var draftEffectiveAgentId: String {
        if let id = normalizedAgentId(draftAgentId),
           agentCatalogStore.agent(id: id) != nil {
            return id
        }
        let defaultId = TermLoopSettings.shared.defaultTerminalAgentId
        if agentCatalogStore.agent(id: defaultId) != nil {
            return defaultId
        }
        return agentCatalogStore.agents.first?.id ?? TerminalAgent.claudeId
    }

    private var draftModelOptions: [AgentModelOption] {
        agentCatalogStore.orderedModelOptions(for: draftEffectiveAgentId)
    }

    private var draftReasoningOptions: [AgentReasoningOption] {
        agentCatalogStore.orderedReasoningOptions(for: draftEffectiveAgentId)
    }

    private func normalizeDraftRuntimeDefaults() {
        draftTemplateModel = agentCatalogStore.resolveModel(draftTemplateModel, for: draftEffectiveAgentId)
        draftReasoning = agentCatalogStore.resolveReasoning(draftReasoning, for: draftEffectiveAgentId) ?? .default
    }

    private func normalizedAgentId(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func templateAgentLabel(_ agentId: String?) -> String {
        guard let agentId = normalizedAgentId(agentId) else { return "Default" }
        return agentCatalogStore.agent(id: agentId)?.displayName ?? agentId
    }

}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct AgentsCatalogDetailPane: View {
    @ObservedObject private var promptStore = AgentPromptStore.shared
    @ObservedObject private var projectStore = ProjectStore.shared
    let entry: AgentsCatalogEntry?
    let canEditProjectPrompts: Bool
    let canEditProjectTemplates: Bool
    let onDuplicateTemplateToProject: () -> Void
    let onSaveProjectTemplate: (String, String, AgentTemplate.Model, AgentTemplate.PermissionMode, AgentTemplate.Lifecycle, AgentTemplate.Scope, String?, String?, String) -> Void
    let onDeleteProjectTemplate: () -> Void
    let onDuplicateToProject: () -> Void
    let onSaveProjectPrompt: (String, String) -> Void
    let onDeleteProjectPrompt: () -> Void

    @State private var draftTitle: String = ""
    @State private var draftSubtitle: String = ""
    @State private var draftBody: String = ""
    @State private var draftTemplateModel: AgentTemplate.Model = .default
    @State private var draftPermissionMode: AgentTemplate.PermissionMode = .bypassPermissions
    @State private var draftLifecycle: AgentTemplate.Lifecycle = .detached
    @State private var draftTemplateScope: AgentTemplate.Scope = .workspace
    @State private var draftPromptDocumentId: String?
    @State private var draftSystemPromptDocumentId: String?

    var body: some View {
        Group {
            if let entry {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        header(entry)
                        TermLoopSidebarRule()

                        if !entry.metadata.isEmpty {
                            metadataBlock(entry)
                            TermLoopSidebarRule()
                        }

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
                .onChange(of: entry.id) { _ in syncDrafts(for: entry) }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text(TermLoopSidebarTheme.caps("Agents Catalog"))
                        .font(TermLoopSidebarTheme.sectionCaps)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                    Text("Select a template or prompt on the left. Templates and prompt documents duplicate built-ins to the active project before edit; runtime fragments remain read-only.")
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
                Spacer(minLength: 0)
                TermLoopSidebarToken(label: entry.kindLabel, tone: .accent)
                TermLoopSidebarToken(label: entry.scope.label, tone: scopeTone(entry.scope))
            }
            if !entry.subtitle.isEmpty {
                Text(entry.subtitle)
                    .font(TermLoopSidebarTheme.bodyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .textSelection(.enabled)
            }
        }
    }

    private func metadataBlock(_ entry: AgentsCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(TermLoopSidebarTheme.caps("Metadata"))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            ForEach(entry.metadata, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.label)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dimmer)
                        .frame(width: 92, alignment: .leading)
                    Text(item.value)
                        .font(TermLoopSidebarTheme.bodyMono)
                        .foregroundStyle(Color.primary.opacity(0.85))
                        .textSelection(.enabled)
                }
            }
        }
    }

    private func templateEditor(entry: AgentsCatalogEntry, template: AgentTemplate) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(TermLoopSidebarTheme.caps("Template"))
                    .font(TermLoopSidebarTheme.sectionCaps)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                Spacer(minLength: 0)
                if template.source != .project {
                    Button("Duplicate to Project", action: onDuplicateTemplateToProject)
                        .disabled(!canEditProjectTemplates)
                } else {
                    Button("Delete", role: .destructive, action: onDeleteProjectTemplate)
                    Button("Save") {
                        onSaveProjectTemplate(
                            draftTitle,
                            draftSubtitle,
                            draftTemplateModel,
                            draftPermissionMode,
                            draftLifecycle,
                            draftTemplateScope,
                            draftPromptDocumentId,
                            draftSystemPromptDocumentId,
                            draftBody
                        )
                    }
                }
            }

            field(label: "Name") {
                if template.source != .project {
                    Text(entry.title).font(TermLoopSidebarTheme.bodyMono).textSelection(.enabled)
                } else {
                    TextField("Template name", text: $draftTitle)
                        .textFieldStyle(.roundedBorder)
                        .font(TermLoopSidebarTheme.bodyMono)
                }
            }

            field(label: "Description") {
                if template.source != .project {
                    Text(entry.subtitle).font(TermLoopSidebarTheme.bodyMono).textSelection(.enabled)
                } else {
                    TextField("Template description", text: $draftSubtitle)
                        .textFieldStyle(.roundedBorder)
                        .font(TermLoopSidebarTheme.bodyMono)
                }
            }

            HStack(spacing: 10) {
                field(label: "Model") {
                    if template.source != .project {
                        Text(template.model.rawValue).font(TermLoopSidebarTheme.bodyMono)
                    } else {
                        Picker("", selection: $draftTemplateModel) {
                            Text("default").tag(AgentTemplate.Model.default)
                            Text("sonnet").tag(AgentTemplate.Model.sonnet)
                            Text("opus").tag(AgentTemplate.Model.opus)
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                }
                field(label: "Perm") {
                    if template.source != .project {
                        Text(template.permissionMode.rawValue).font(TermLoopSidebarTheme.bodyMono)
                    } else {
                        Picker("", selection: $draftPermissionMode) {
                            ForEach([AgentTemplate.PermissionMode.bypassPermissions, .default, .plan, .dontAsk, .acceptEdits], id: \.rawValue) { mode in
                                Text(mode.rawValue).tag(mode)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                }
                field(label: "Lifecycle") {
                    if template.source != .project {
                        Text(template.lifecycle.rawValue).font(TermLoopSidebarTheme.bodyMono)
                    } else {
                        Picker("", selection: $draftLifecycle) {
                            Text("detached").tag(AgentTemplate.Lifecycle.detached)
                            Text("app-bound").tag(AgentTemplate.Lifecycle.appBound)
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                }
                field(label: "Scope") {
                    if template.source != .project {
                        Text(template.scope.rawValue).font(TermLoopSidebarTheme.bodyMono)
                    } else {
                        Picker("", selection: $draftTemplateScope) {
                            Text("workspace").tag(AgentTemplate.Scope.workspace)
                            Text("folder").tag(AgentTemplate.Scope.folder)
                            Text("root").tag(AgentTemplate.Scope.root)
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                }
            }

            HStack(spacing: 10) {
                field(label: "Prompt Doc") {
                    if template.source != .project {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(linkedPromptTitle(id: template.promptDocumentId) ?? template.promptDocumentId ?? "—")
                                .font(TermLoopSidebarTheme.bodyMono)
                            if let promptDocumentId = template.promptDocumentId {
                                Text(promptDocumentId)
                                    .font(TermLoopSidebarTheme.tinyMono)
                                    .foregroundStyle(TermLoopSidebarTheme.dim)
                            }
                        }
                    } else {
                        Picker("", selection: $draftPromptDocumentId) {
                            Text("none").tag(Optional<String>.none)
                            ForEach(promptStore.documents.filter { $0.kind.canBackPromptBody }, id: \.id) { document in
                                Text(document.title).tag(Optional(document.id))
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                }
                field(label: "System Doc") {
                    if template.source != .project {
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
            }

            Text(TermLoopSidebarTheme.caps("Prompt Body"))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            if template.source != .project {
                codeBlock(entry.body)
            } else {
                PromptTextEditor(text: $draftBody, minHeight: 280)
            }

            if let systemDocument = linkedPromptDocument(id: template.systemPromptDocumentId) {
                Text(TermLoopSidebarTheme.caps("System Prompt"))
                    .font(TermLoopSidebarTheme.sectionCaps)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        TermLoopSidebarToken(label: systemDocument.kind.displayLabel, tone: .accent)
                        TermLoopSidebarToken(label: systemDocument.scope.displayLabel.uppercased(), tone: systemDocument.scope == .builtin ? .neutral : .accent)
                        if systemDocument.kind.isInternalFacing {
                            TermLoopSidebarToken(label: "INTERNAL", tone: .warning)
                        }
                    }
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
    }

    private func promptEditor(entry: AgentsCatalogEntry, document: AgentPromptDocument) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TermLoopSidebarToken(label: document.kind.displayLabel, tone: .accent)
                TermLoopSidebarToken(label: document.scope.displayLabel.uppercased(), tone: document.scope == .builtin ? .neutral : .accent)
                if document.kind.isInternalFacing {
                    TermLoopSidebarToken(label: "INTERNAL", tone: .warning)
                }
            }

            HStack(spacing: 8) {
                Text(TermLoopSidebarTheme.caps("Title"))
                    .font(TermLoopSidebarTheme.sectionCaps)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                Spacer(minLength: 0)
                if document.scope == .builtin {
                    Button("Duplicate to Project", action: onDuplicateToProject)
                        .disabled(!canEditProjectPrompts)
                } else {
                    Button("Delete", role: .destructive, action: onDeleteProjectPrompt)
                    Button("Save") { onSaveProjectPrompt(draftTitle, draftBody) }
                }
            }
            if document.scope == .builtin {
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
            if document.scope == .builtin {
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
        Text(verbatim: text.isEmpty ? "—" : text)
            .font(.system(size: 11, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(MarkdownTheme.insetBg)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(MarkdownTheme.codeBorder, lineWidth: 1)
            )
            .textSelection(.enabled)
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
                return "Built-in templates stay immutable. Duplicate to Project to override without breaking source-of-truth discipline."
            case .user:
                return "Legacy user template. It stays read-only here; duplicate it to the active project to bring it under project-owned catalog truth."
            case .project:
                return "Project template. Saving writes back to the active project's .termloop/templates catalog."
            }
        }
        if let document = entry.promptDocument {
            return document.scope == .builtin
                ? "Built-in prompt documents stay immutable. Duplicate to Project to override without breaking source-of-truth discipline."
                : "Project prompt document. Saving writes back to the active project's .termloop/prompts catalog."
        }
        return "Read-only view. Runtime fragments remain projections from transport/runtime owners."
    }

    private func syncDrafts(for entry: AgentsCatalogEntry) {
        draftTitle = entry.template?.name ?? entry.promptDocument?.title ?? entry.title
        draftSubtitle = entry.template?.description ?? entry.subtitle
        draftBody = entry.template?.body ?? entry.promptDocument?.body ?? entry.body
        draftTemplateModel = entry.template?.model ?? .default
        draftPermissionMode = entry.template?.permissionMode ?? .bypassPermissions
        draftLifecycle = entry.template?.lifecycle ?? .detached
        draftTemplateScope = entry.template?.scope ?? .workspace
        draftPromptDocumentId = entry.template?.promptDocumentId
        draftSystemPromptDocumentId = entry.template?.systemPromptDocumentId
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

    private func scopeTone(_ scope: AgentsCatalogEntry.Scope) -> TermLoopSidebarTokenTone {
        switch scope {
        case .builtin: return .neutral
        case .project: return .accent
        case .user: return .neutral
        case .runtime: return .warning
        case .placeholder: return .muted
        }
    }
}

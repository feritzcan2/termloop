// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionAdvancedTable: View {
    @ObservedObject var viewModel: QuickActionViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            rowGroup(title: String(
                localized: "quickAction.advanced.group.run",
                defaultValue: "Run",
                table: "TermLoop"
            )) {
                titleRow
            }

            rowGroup(title: String(
                localized: "quickAction.advanced.group.target",
                defaultValue: "Target",
                table: "TermLoop"
            )) {
                targetRow
            }

            rowGroup(title: String(
                localized: "quickAction.advanced.group.context",
                defaultValue: "Context",
                table: "TermLoop"
            )) {
                promptDocumentRow
                systemPromptDocumentRow
                systemPromptRow
            }

            if let tpl = viewModel.activeTemplate, !tpl.variables.isEmpty {
                rowGroup(title: String(
                    localized: "quickAction.advanced.group.variables",
                    defaultValue: "Variables",
                    table: "TermLoop"
                )) {
                    ForEach(tpl.variables, id: \.self) { name in
                        variableRow(name: name)
                    }
                }
            }

            runButtonBar
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            columnLabel(String(
                localized: "quickAction.advanced.col.field",
                defaultValue: "Field",
                table: "TermLoop"
            ), width: 100)
            columnLabel(String(
                localized: "quickAction.advanced.col.value",
                defaultValue: "Value",
                table: "TermLoop"
            ), width: 340)
            columnLabel(String(
                localized: "quickAction.advanced.col.persist",
                defaultValue: "Persist",
                table: "TermLoop"
            ), width: 72)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    private func columnLabel(_ text: String, width: CGFloat) -> some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundColor(.secondary)
            .frame(width: width, alignment: .leading)
    }

    @ViewBuilder
    private func rowGroup<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        Text(title.uppercased())
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundColor(.secondary)
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 2)
        VStack(spacing: 2) {
            content()
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }

    private var titleRow: some View {
        row(
            field: "title",
            persist: .once,
            value: AnyView(
                TextField(
                    String(
                        localized: "quickAction.advanced.title.placeholder",
                        defaultValue: "Agent title (optional)",
                        table: "TermLoop"
                    ),
                    text: $viewModel.advancedTitle
                )
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 320)
            )
        )
    }

    private var targetRow: some View {
        row(
            field: "workspace",
            persist: .session,
            value: AnyView(QuickActionWorkspaceTargetPill(viewModel: viewModel))
        )
    }

    private var systemPromptRow: some View {
        row(
            field: "system",
            persist: .saved,
            value: AnyView(
                VStack(alignment: .leading, spacing: 4) {
                    TextEditor(text: $viewModel.advancedSystemPrompt)
                        .font(.system(size: 11, design: .monospaced))
                        .frame(minHeight: 48, maxHeight: 120)
                        .overlay(
                            RoundedRectangle(cornerRadius: 5, style: .continuous)
                                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
                        )
                    Text(String(
                        localized: "quickAction.advanced.systemPrompt.hint",
                        defaultValue: "Injected before the user's message. Claude → --append-system-prompt · Codex → developer_instructions · others → prepended to the prompt.",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            )
        )
    }

    private var promptDocumentRow: some View {
        row(
            field: "prompt doc",
            persist: .session,
            value: AnyView(
                VStack(alignment: .leading, spacing: 4) {
                    Menu {
                        ForEach(viewModel.availablePromptDocuments, id: \.id) { document in
                            Button {
                                viewModel.selectedPromptDocumentId = document.id
                            } label: {
                                documentMenuLabel(document)
                            }
                        }
                        if viewModel.selectedPromptDocumentId != nil {
                            Divider()
                            Button(viewModel.activeTemplate?.promptDocumentId != nil ? "Reset to template default" : "Clear selection") {
                                viewModel.resetPromptDocumentSelectionToTemplateDefault()
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(viewModel.selectedPromptDocumentTitle)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.secondary)
                        }
                        .font(.system(size: 11, design: .monospaced))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 5, style: .continuous)
                                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
                        )
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize(horizontal: false, vertical: true)

                    Text(String(
                        localized: "quickAction.advanced.promptDocument.hint",
                        defaultValue: "Reusable prompt body. Used only when the main prompt box is empty.",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            )
        )
    }

    private var systemPromptDocumentRow: some View {
        row(
            field: "system doc",
            persist: .session,
            value: AnyView(
                VStack(alignment: .leading, spacing: 4) {
                    Menu {
                        ForEach(viewModel.availableSystemPromptDocuments, id: \.id) { document in
                            Button {
                                viewModel.selectedSystemPromptDocumentId = document.id
                            } label: {
                                documentMenuLabel(document)
                            }
                        }
                        if viewModel.selectedSystemPromptDocumentId != nil {
                            Divider()
                            Button(viewModel.activeTemplate?.systemPromptDocumentId != nil ? "Reset to template default" : "Clear selection") {
                                viewModel.resetSystemPromptDocumentSelectionToTemplateDefault()
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(viewModel.selectedSystemPromptDocumentTitle)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.secondary)
                        }
                        .font(.system(size: 11, design: .monospaced))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 5, style: .continuous)
                                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
                        )
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize(horizontal: false, vertical: true)

                    Text(String(
                        localized: "quickAction.advanced.systemDocument.hint",
                        defaultValue: "Reusable system prompt. Applied only when Advanced › System prompt is empty.",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            )
        )
    }

    private func variableRow(name: String) -> some View {
        let autoFillable = QuickActionRunResolver.autoFilledVariableNames
        let isAutoFilled = autoFillable.contains(name) && viewModel.advancedVariableValues[name] == nil
        return row(
            field: name,
            persist: .session,
            value: AnyView(
                Group {
                    if isAutoFilled {
                        Text(String(
                            localized: "quickAction.advanced.variable.autofilled",
                            defaultValue: "(auto-filled)",
                            table: "TermLoop"
                        ))
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                    } else {
                        TextField("", text: Binding(
                            get: { viewModel.advancedVariableValues[name] ?? "" },
                            set: { viewModel.advancedVariableValues[name] = $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 320)
                    }
                }
            )
        )
    }

    private enum Persistence: String {
        case saved, session, once
    }

    private func row(field: String, persist: Persistence, value: AnyView) -> some View {
        HStack(spacing: 8) {
            Text(field)
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(.purple)
                .frame(width: 100, alignment: .leading)
            value
                .frame(width: 340, alignment: .leading)
            persistTag(persist)
                .frame(width: 72, alignment: .leading)
        }
        .padding(.vertical, 4)
    }

    private func persistTag(_ p: Persistence) -> some View {
        Text(p.rawValue)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(tagColor(for: p).opacity(0.15))
            )
            .foregroundColor(tagColor(for: p))
    }

    private func tagColor(for p: Persistence) -> Color {
        switch p {
        case .saved: return .green
        case .session: return .blue
        case .once: return .secondary
        }
    }
    private var runButtonBar: some View {
        HStack {
            Spacer()
            Button {
                _ = viewModel.submit()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "macwindow")
                    Text(runButtonLabel)
                }
            }
            .keyboardShortcut(.defaultAction)
            .buttonStyle(.borderedProminent)
        }
    }

    private var runButtonLabel: String {
        String(
            localized: "quickAction.advanced.runInTerminal",
            defaultValue: "Run in terminal",
            table: "TermLoop"
        )
    }

    @ViewBuilder
    private func documentMenuLabel(_ document: AgentPromptDocument) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(document.title)
            HStack(spacing: 4) {
                menuTag(document.kind.displayLabel)
                menuTag(document.scope.displayLabel)
                if document.kind.isInternalFacing {
                    menuTag("internal")
                }
            }
        }
    }

    private func menuTag(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundStyle(.secondary)
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionTemplateDropdown: View {
    @ObservedObject var viewModel: QuickActionViewModel
    var onSelectFreePrompt: () -> Void
    var onSelectTemplate: (String) -> Void
    var onClose: () -> Void

    @State private var filter: String = ""
    @FocusState private var filterFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            filterRow

            ScrollView {
                VStack(spacing: 2) {
                    freePromptRow
                    if !filteredTemplates.isEmpty {
                        Divider().padding(.vertical, 4)
                    }
                    ForEach(filteredTemplates, id: \.id) { tpl in
                        templateRow(tpl)
                    }
                }
            }
            .frame(maxHeight: 260)
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(.regularMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
        )
        .onAppear { filterFocused = true }
    }

    private var filterRow: some View {
        let placeholder = String(
            localized: "quickAction.dropdown.placeholder",
            defaultValue: "Search templates",
            table: "TermLoop"
        )
        return HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)
            TextField(placeholder, text: $filter)
                .textFieldStyle(.plain)
                .focused($filterFocused)
                .onSubmit(submitFilter)
                .onKeyPress(.escape) {
                    onClose()
                    return .handled
                }
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.secondary.opacity(0.08))
        )
    }

    private func submitFilter() {
        if let first = filteredTemplates.first {
            onSelectTemplate(first.id)
        } else {
            onSelectFreePrompt()
        }
    }

    private var freePromptRow: some View {
        Button(action: onSelectFreePrompt) {
            HStack(spacing: 10) {
                Image(systemName: "pencil.line")
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(String(
                        localized: "quickAction.dropdown.freePrompt.title",
                        defaultValue: "Free prompt",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 13, weight: .medium))
                    Text(freePromptSubtitle)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                }
                Spacer()
                if case .freePrompt = viewModel.composition {
                    Text(String(
                        localized: "quickAction.dropdown.current",
                        defaultValue: "current",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.accentColor)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(isFreePromptCurrent ? Color.accentColor.opacity(0.12) : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }

    private func templateRow(_ tpl: AgentTemplate) -> some View {
        Button {
            onSelectTemplate(tpl.id)
        } label: {
            HStack(spacing: 10) {
                Text(tpl.icon.isEmpty ? "⚡" : tpl.icon)
                    .font(.system(size: 14))
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(tpl.name)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                    if !tpl.description.isEmpty {
                        Text(tpl.description)
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    let defaults = templateDefaultsSummary(for: tpl)
                    if !defaults.isEmpty {
                        Text(defaults)
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundColor(.secondary.opacity(0.85))
                            .lineLimit(1)
                    }
                }
                Spacer()
                if isTemplateCurrent(tpl.id) {
                    Text(String(
                        localized: "quickAction.dropdown.current",
                        defaultValue: "current",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.accentColor)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var isFreePromptCurrent: Bool {
        if case .freePrompt = viewModel.composition { return true }
        return false
    }

    private func isTemplateCurrent(_ id: String) -> Bool {
        if case .template(let currentId) = viewModel.composition {
            return currentId == id
        }
        return false
    }

    private var filteredTemplates: [AgentTemplate] {
        let all = viewModel.orderedTemplates
        let q = filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return all }
        return all.filter { tpl in
            tpl.name.lowercased().contains(q)
                || tpl.description.lowercased().contains(q)
                || tpl.id.lowercased().contains(q)
        }
    }

    private var freePromptSubtitle: String {
        if !viewModel.freePromptUsesDedicatedTemplate,
           let name = viewModel.freePromptBackingTemplateName {
            return String(
                localized: "quickAction.dropdown.freePrompt.subtitle.backing",
                defaultValue: "Type anything. Backed by \(name).",
                table: "TermLoop"
            )
        }
        return String(
            localized: "quickAction.dropdown.freePrompt.subtitle",
            defaultValue: "Type anything. Default.",
            table: "TermLoop"
        )
    }

    private func templateDefaultsSummary(for template: AgentTemplate) -> String {
        var parts: [String] = []
        if let promptDocumentId = template.promptDocumentId,
           !promptDocumentId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append("prompt doc")
        } else if !template.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append("default prompt")
        }
        if let systemDocumentId = template.systemPromptDocumentId,
           !systemDocumentId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append("system doc")
        }
        return parts.joined(separator: " · ")
    }
}

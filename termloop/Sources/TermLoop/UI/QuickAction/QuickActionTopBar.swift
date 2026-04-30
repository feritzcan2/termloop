// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionTopBar: View {
    @ObservedObject var viewModel: QuickActionViewModel
    var onTapTemplatePicker: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            templatePickerButton
                .frame(minWidth: 140, idealWidth: 280, maxWidth: 360, alignment: .leading)
                .layoutPriority(2)
            QuickActionWorkspaceTargetPill(viewModel: viewModel)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(0)
        }
    }

    private var templatePickerButton: some View {
        ViewThatFits(in: .horizontal) {
            fullTemplatePickerLabel
            compactTemplatePickerLabel
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.white.opacity(0.04))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.white.opacity(0.09), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { onTapTemplatePicker() }
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(String(
            localized: "quickAction.topBar.templatePicker.help",
            defaultValue: "Pick a template (⌘K)",
            table: "TermLoop"
        ))
        .help(titleText)
    }

    private var fullTemplatePickerLabel: some View {
        HStack(spacing: 8) {
            iconBox
            Text(titleText)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(2)
            Rectangle()
                .fill(Color.white.opacity(0.12))
                .frame(width: 1, height: 14)
            Text(subtitleText)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .semibold))
                .foregroundColor(.secondary)
        }
    }

    private var compactTemplatePickerLabel: some View {
        HStack(spacing: 8) {
            iconBox
            Text(titleText)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
            Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .semibold))
                .foregroundColor(.secondary)
        }
    }

    private var iconBox: some View {
        Text(iconText)
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(.white)
            .frame(width: 20, height: 20)
            .background(iconBackground)
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .stroke(Color.white.opacity(0.14), lineWidth: 1)
            )
    }

    @ViewBuilder
    private var iconBackground: some View {
        switch viewModel.composition {
        case .freePrompt:
            Color.white.opacity(0.08)
        case .template:
            LinearGradient(
                colors: [Color(red: 0.42, green: 0.24, blue: 0.78), Color(red: 0.73, green: 0.55, blue: 1.0)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    private var iconText: String {
        switch viewModel.composition {
        case .freePrompt: return "✎"
        case .template: return "⌘"
        }
    }

    private var titleText: String {
        switch viewModel.composition {
        case .freePrompt:
            return String(
                localized: "quickAction.topBar.freePrompt.title",
                defaultValue: "Free prompt",
                table: "TermLoop"
            )
        case .template(let id):
            return AgentTemplateStore.shared.template(id: id)?.name ?? id
        }
    }

    private var subtitleText: String {
        switch viewModel.composition {
        case .freePrompt:
            if !viewModel.freePromptUsesDedicatedTemplate,
               let name = viewModel.freePromptBackingTemplateName {
                return String(
                    localized: "quickAction.topBar.freePrompt.subtitle.backing",
                    defaultValue: "via \(name)",
                    table: "TermLoop"
                )
            }
            return String(
                localized: "quickAction.topBar.freePrompt.subtitle",
                defaultValue: "default",
                table: "TermLoop"
            )
        case .template:
            return viewModel.templateDefaultsSummaryText
        }
    }
}

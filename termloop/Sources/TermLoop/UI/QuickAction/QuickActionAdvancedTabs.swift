// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionAdvancedTabs: View {
    @ObservedObject var viewModel: QuickActionViewModel
    @ObservedObject private var preview: QuickActionPreviewViewModel
    @State private var selection: Tab = .preview

    enum Tab: Hashable { case preview, raw }

    init(
        viewModel: QuickActionViewModel,
        settingsPrimaryAction: (() -> Void)? = nil,
        settingsPrimaryLabel: String? = nil,
        settingsPrimaryIcon: String = "macwindow"
    ) {
        self.viewModel = viewModel
        self._preview = ObservedObject(wrappedValue: viewModel.preview)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            tabStrip
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 2)

            Group {
                switch selection {
                case .preview:
                    QuickActionAdvancedPreviewTab(
                        preview: preview,
                        promptStatus: viewModel.promptInputStatus,
                        systemStatus: viewModel.systemInputStatus,
                        selectedTemplate: viewModel.activeTemplate,
                        templateOriginLabel: viewModel.activeTemplateOriginLabel,
                        promptSourceLabel: viewModel.activeTemplatePromptSourceLabel,
                        templateSourcePath: viewModel.activeTemplateSourcePathForPreview,
                        resolvedVariables: viewModel.resolvedTemplateVariablesForPreview,
                        cwd: viewModel.resolvedRunCwdForPreview(),
                        branch: viewModel.resolvedBranchForPreview(),
                        plan: preview.plan,
                        transport: viewModel.transportResolutionForPreview()
                    )
                case .raw:
                    QuickActionAdvancedRawTab(
                        preview: preview,
                        fullCommand: viewModel.fullCommandForPreview(),
                        promptStatus: viewModel.promptInputStatus,
                        systemStatus: viewModel.systemInputStatus,
                        selectedTemplate: viewModel.activeTemplate,
                        templateOriginLabel: viewModel.activeTemplateOriginLabel,
                        promptSourceLabel: viewModel.activeTemplatePromptSourceLabel,
                        templateSourcePath: viewModel.activeTemplateSourcePathForPreview,
                        resolvedVariables: viewModel.resolvedTemplateVariablesForPreview,
                        plan: preview.plan,
                        transport: viewModel.transportResolutionForPreview()
                    )
                }
            }
            .frame(maxWidth: .infinity, minHeight: 260, maxHeight: 320, alignment: .topLeading)
            .clipped()
        }
    }

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                tabPill("Preview", tab: .preview)
                tabPill("Raw", tab: .raw)
            }
        }
    }

    private func tabPill(_ title: String, tab: Tab) -> some View {
        let active = selection == tab
        return Button(action: { selection = tab }) {
            Text(title)
                .font(.system(size: 11, weight: active ? .semibold : .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(
                    active
                        ? Color.accentColor.opacity(0.18)
                        : Color.secondary.opacity(0.08)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(
                            active
                                ? Color.accentColor.opacity(0.5)
                                : Color.secondary.opacity(0.25),
                            lineWidth: 0.5
                        )
                )
                .foregroundStyle(active ? Color.accentColor : Color.primary)
                .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }
}

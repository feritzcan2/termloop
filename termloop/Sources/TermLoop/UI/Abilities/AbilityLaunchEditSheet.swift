// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Pre-launch editor for the long-form prompt that drives an ability
/// creator / refiner workspace. The sheet pre-fills with a bundled
/// default (`AbilityPrompts.creator`, `.refiner`, or a template's
/// `creatorPrompt`); the user can adjust it before Launch — matching the
/// editable-prompt contract used by QuickAction and AskToSheet.
@MainActor
struct AbilityLaunchEditSheet: View {
    let title: String
    let defaultPrompt: String
    let onLaunch: (String) -> Void
    let onCancel: () -> Void

    @State private var prompt: String

    init(
        title: String,
        defaultPrompt: String,
        onLaunch: @escaping (String) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.title = title
        self.defaultPrompt = defaultPrompt
        self.onLaunch = onLaunch
        self.onCancel = onCancel
        _prompt = State(initialValue: defaultPrompt)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(TermLoopSidebarTheme.caps("Launch Ability Agent"))
                    .font(TermLoopSidebarTheme.sectionCaps)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                Text(verbatim: title)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dimmer)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if prompt != defaultPrompt {
                    Button(action: { prompt = defaultPrompt }) {
                        Text(verbatim: "reset")
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .underline()
                    }
                    .buttonStyle(.plain)
                }
            }

            Text("Edit the prompt before launch. The agent will read this content exactly as shown.")
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dimmer)

            TextEditor(text: $prompt)
                .termLoopPromptEditorBox(minHeight: 260, maxHeight: 420)

            HStack(spacing: 6) {
                Spacer()
                Button("Cancel", action: onCancel)
                    .buttonStyle(.plain)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .keyboardShortcut(.cancelAction)
                Button("Launch") { onLaunch(prompt) }
                    .controlSize(.small)
                    .keyboardShortcut(.defaultAction)
                    .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .frame(width: 520)
    }
}

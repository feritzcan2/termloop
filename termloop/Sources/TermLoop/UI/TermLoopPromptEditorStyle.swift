// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Shared prompt input used by launch sheets, quick action advanced settings,
/// bridge kickoff prompts, and catalog prompt editors. Keep behavior here so
/// prompt fields do not drift while the full markdown document editor remains
/// a separate surface.
struct PromptTextEditor: View {
    @Binding var text: String
    let minHeight: CGFloat
    let maxHeight: CGFloat

    init(text: Binding<String>, minHeight: CGFloat, maxHeight: CGFloat = 180) {
        self._text = text
        self.minHeight = minHeight
        self.maxHeight = maxHeight
    }

    var body: some View {
        TextEditor(text: $text)
            .termLoopPromptEditorBox(minHeight: minHeight, maxHeight: maxHeight)
    }
}

/// Shared styling for editable prompt `TextEditor` boxes (AskToSheet
/// source/target editors, AbilityLaunchEditSheet). Thin visual theme
/// only — each call-site still owns the caption / reset / binding.
extension View {
    func termLoopPromptEditorBox(minHeight: CGFloat, maxHeight: CGFloat = 180) -> some View {
        self
            .font(TermLoopSidebarTheme.tinyMono)
            .scrollContentBackground(.hidden)
            .padding(6)
            .frame(minHeight: minHeight, maxHeight: maxHeight)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(MarkdownTheme.editorBg)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(MarkdownTheme.codeBorder, lineWidth: 0.5)
            )
    }
}

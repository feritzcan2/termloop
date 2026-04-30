// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

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
                    .stroke(TermLoopSidebarTheme.dimmer.opacity(0.35), lineWidth: 0.5)
            )
    }
}

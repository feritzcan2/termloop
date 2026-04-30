// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Warm-gradient highlight applied to a view. This used to animate with a
/// continuous TimelineView shimmer, but a static treatment is materially
/// cheaper when many sidebar rows are live at once.
struct ClaudeRunningShimmerModifier: ViewModifier {
    let isActive: Bool

    private static let gradientColors: [Color] = [
        Color(red: 1.00, green: 0.60, blue: 0.30),
        Color(red: 1.00, green: 0.30, blue: 0.56),
        Color(red: 0.65, green: 0.30, blue: 1.00),
        Color(red: 1.00, green: 0.30, blue: 0.56),
        Color(red: 1.00, green: 0.60, blue: 0.30),
    ]

    func body(content: Content) -> some View {
        if isActive {
            content
                .hidden()
                .overlay(gradientLayer.mask(content))
        } else {
            content
        }
    }

    @ViewBuilder
    private var gradientLayer: some View {
        LinearGradient(
            colors: Self.gradientColors,
            startPoint: .leading,
            endPoint: .trailing
        )
    }
}

extension TermLoopHooks {
    /// Called from `SidebarMetadataEntryRow.rowContent` via a single-line
    /// hook in upstream `ContentView.swift`. When the entry belongs to a
    /// known terminal agent and is `Running`, the row's icon + label shimmer
    /// with a warm gradient. All other entries pass through untouched.
    static func claudeRunningShimmer(entryKey: String, entryValue: String) -> ClaudeRunningShimmerModifier {
        let trimmed = entryValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let active = TerminalAgentRegistry.shared.statusKeys.contains(entryKey) && trimmed == "Running"
        return ClaudeRunningShimmerModifier(isActive: active)
    }
}

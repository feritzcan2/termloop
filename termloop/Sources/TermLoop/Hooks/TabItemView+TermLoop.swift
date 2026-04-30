// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

extension TermLoopHooks {
    @ViewBuilder
    static func sidebarWorkspaceDescription(
        markdown: String?,
        isActive: Bool
    ) -> some View {
        TermLoopSidebarWorkspaceDescriptionGate(markdown: markdown, isActive: isActive)
    }
}

/// Gates the upstream workspace description beneath the title by the
/// `hideWorkspaceDescription` flag. When enabled (default), renders nothing.
/// When disabled, shows a minimal replica of the upstream styling.
private struct TermLoopSidebarWorkspaceDescriptionGate: View {
    let markdown: String?
    let isActive: Bool
    @ObservedObject private var flags = TermLoopSidebarFeatureFlags.shared

    var body: some View {
        if flags.hideWorkspaceDescription {
            EmptyView()
        } else if let text = markdown, !text.isEmpty {
            Text(text)
                .font(.system(size: 10.5))
                .foregroundColor(isActive ? .white.opacity(0.84) : .secondary.opacity(0.95))
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

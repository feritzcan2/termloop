// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Shared chrome for the three cards stacked inside `AbilityDetailPage`:
/// caption strip on top, content body, optional footer row of borderless
/// trailing-aligned actions.
@MainActor
struct AbilityDetailCard<Content: View, Footer: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder let content: () -> Content
    @ViewBuilder let footer: () -> Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(TermLoopSidebarTheme.sectionCaps)
                    .foregroundStyle(Color.primary)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            content()
            let footerView = footer()
            if !(footerView is EmptyView) {
                HStack(spacing: 12) {
                    Spacer(minLength: 0)
                    footerView
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.primary.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(TermLoopSidebarTheme.ruleStrong, lineWidth: 1)
        )
    }
}

extension AbilityDetailCard where Footer == EmptyView {
    init(
        title: String,
        subtitle: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self.content = content
        self.footer = { EmptyView() }
    }
}

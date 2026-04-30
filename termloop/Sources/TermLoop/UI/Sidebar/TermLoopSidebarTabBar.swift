// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Brutalist mono tab bar rendered above the sidebar content.
/// Selection persists in `@AppStorage(TermLoopSidebarTab.storageKey)`.
struct TermLoopSidebarTabBar: View {
    @Binding var selection: TermLoopSidebarTab

    var body: some View {
        HStack(spacing: 0) {
            ForEach(TermLoopSidebarTab.allCases) { tab in
                tabButton(tab)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 28)
        .background(Color.black.opacity(0.15))
        .overlay(Rectangle().frame(height: 1).foregroundColor(Color.primary.opacity(0.1)),
                 alignment: .bottom)
    }

    @ViewBuilder
    private func tabButton(_ tab: TermLoopSidebarTab) -> some View {
        let isActive = selection == tab
        Button {
            selection = tab
        } label: {
            Text(tab.displayTitle)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .tracking(1.6)
                .foregroundColor(isActive ? .primary : Color.primary.opacity(0.45))
                .frame(maxWidth: .infinity, minHeight: 28)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .frame(height: 2)
                        .foregroundColor(isActive ? Color.accentColor : .clear)
                }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("TermLoopSidebarTab.\(tab.rawValue)")
    }
}

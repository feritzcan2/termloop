// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct PlanFileRow: View {
    let entry: PlanFileEntry

    var body: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(categoryColor)
                .frame(width: 3)
                .frame(maxHeight: .infinity)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.displayTitle)
                    .font(TermLoopSidebarTheme.bodyMono)
                    .foregroundColor(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let date = entry.datePrefix {
                    Text(date)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundColor(TermLoopSidebarTheme.dim)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
        .contentShape(Rectangle())
        .help(entry.url.path)
    }

    private var categoryColor: Color {
        switch entry.folder.path {
        case "docs/superpowers/specs":
            return .blue
        case "docs/superpowers/plans":
            return .green
        default:
            return .orange
        }
    }
}

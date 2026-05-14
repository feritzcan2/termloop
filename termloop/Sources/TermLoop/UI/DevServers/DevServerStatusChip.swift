// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct DevServerStatusChip: View {
    let summary: TaskDevServerSummary

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "server.rack")
                .font(.system(size: 9, weight: .semibold))
            Text(label)
                .lineLimit(1)
        }
        .font(.system(size: 10, weight: .semibold))
        .foregroundColor(color)
        .padding(.vertical, 2)
        .padding(.horizontal, 6)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
        .help(helpText)
    }

    private var color: Color {
        switch summary.dominantPhase {
        case .running: return Color(red: 0.30, green: 0.78, blue: 0.36)
        case .starting, .settingUp, .stopping: return .orange
        case .failed: return Color(red: 0.92, green: 0.36, blue: 0.31)
        case .exited, .idle: return .secondary
        }
    }

    private var helpText: String {
        if let latestURL = summary.latestURL {
            return String(
                localized: "devservers.card.helpWithURL",
                defaultValue: "Dev server: \(label)\n\(latestURL)",
                table: "TermLoop"
            )
        }
        return String(
            localized: "devservers.card.help",
            defaultValue: "Dev server: \(label)",
            table: "TermLoop"
        )
    }

    private var label: String {
        summary.compactLabel
    }
}

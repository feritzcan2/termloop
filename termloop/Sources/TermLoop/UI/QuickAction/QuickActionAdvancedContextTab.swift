// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionAdvancedContextTab: View {
    let projectFolderPath: String?
    let cwd: String?
    let branch: String?
    let isWorktree: Bool
    let env: [String: String]

    private let unmaskedPrefixes = ["TERMLOOP_", "TERMLOOP_", "CLAUDE_"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                    row("Project", projectFolderPath ?? "—")
                    row("cwd", cwd ?? "—")
                    row("Branch", branch ?? "—")
                    row("Worktree", isWorktree ? "yes" : "no")
                }
                Divider()
                Text("Environment").font(.headline)
                ForEach(env.keys.sorted(), id: \.self) { k in
                    HStack {
                        Text(k).font(.system(.callout, design: .monospaced))
                        Spacer()
                        Text(display(value: env[k] ?? "", key: k))
                            .font(.system(.callout, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(12)
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        GridRow {
            Text(k).foregroundStyle(.secondary)
            Text(v).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
        }
    }

    private func display(value: String, key: String) -> String {
        if unmaskedPrefixes.contains(where: { key.hasPrefix($0) }) { return value }
        return "••••"
    }
}

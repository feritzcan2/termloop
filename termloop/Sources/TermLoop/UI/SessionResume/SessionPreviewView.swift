// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

enum PreviewFilter: String, CaseIterable {
    case user = "User"
    case all = "All"
}

struct SessionPreviewView: View {
    let metadata: JSONLMetadata?
    var filter: PreviewFilter = .user

    private var visibleLines: [TranscriptLine] {
        guard let lines = metadata?.previewLines else { return [] }
        switch filter {
        case .user:
            return lines.filter { if case .user = $0 { return true }; return false }
        case .all:
            return lines
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(visibleLines.enumerated()), id: \.offset) { idx, line in
                    row(for: line)
                        .padding(.vertical, 4)
                    if idx < visibleLines.count - 1 {
                        Divider()
                    }
                }
            }
            .padding(8)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
    }

    @ViewBuilder
    private func row(for line: TranscriptLine) -> some View {
        switch line {
        case .user(let s):
            Text("❯ \(s)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        case .assistant(let s):
            Text(s)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        case .toolCall(let name, let arg):
            Text("▶ \(name) \(arg)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
    }
}

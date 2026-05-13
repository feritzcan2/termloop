// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct DevServerLogPopover: View {
    let run: DevServerRunSnapshot
    let lines: [DevServerLogLine]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 3) {
                if lines.isEmpty {
                    Text(String(localized: "devservers.logs.empty", defaultValue: "No logs yet.", table: "TermLoop"))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(lines) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(line.stream.rawValue)
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .foregroundStyle(color(for: line.stream))
                                .frame(width: 48, alignment: .leading)
                            Text(line.text)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.primary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .padding(10)
        }
        .frame(width: 520, height: 260)
    }

    private func color(for stream: DevServerLogStream) -> Color {
        switch stream {
        case .stdout: return .secondary
        case .stderr: return .orange
        case .system: return .blue
        }
    }
}

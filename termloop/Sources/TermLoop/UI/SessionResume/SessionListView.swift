// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct SessionListView: View {
    let sessions: [JSONLMetadata]
    @Binding var selectedId: String?
    var isSearching: Bool = false
    let onDelete: (JSONLMetadata) -> Void

    var body: some View {
        if sessions.isEmpty {
            if isSearching { noMatchesState } else { emptyState }
        } else {
            List(selection: $selectedId) {
                ForEach(sessions, id: \.sessionId) { m in
                    row(m)
                        .tag(m.sessionId)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 4) {
            Text(String(
                localized: "session_resume.empty_title",
                defaultValue: "No past sessions for this directory.",
                table: "TermLoop"))
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text(String(
                localized: "session_resume.empty_subtitle",
                defaultValue: "Press Cmd-T to start a new one.",
                table: "TermLoop"))
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var noMatchesState: some View {
        Text(String(
            localized: "session_resume.no_matches",
            defaultValue: "No matching sessions.",
            table: "TermLoop"))
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
    }

    private func row(_ m: JSONLMetadata) -> some View {
        RowContent(metadata: m, relative: relative, onDelete: { onDelete(m) })
    }

    private func relative(_ d: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f.localizedString(for: d, relativeTo: Date())
    }
}

private struct RowContent: View {
    let metadata: JSONLMetadata
    let relative: (Date) -> String
    let onDelete: () -> Void
    @State private var isHovering = false

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(metadata.title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text("\(relative(metadata.mtime)) · \(metadata.messageCount) msgs")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                if !metadata.lastUserSnippet.isEmpty {
                    Text("› \(metadata.lastUserSnippet)")
                        .font(.system(size: 10).italic())
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer()
            if isHovering {
                Button(action: onDelete) {
                    Image(systemName: "trash")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(String(localized: "session_resume.delete_tooltip",
                             defaultValue: "Delete this session",
                             table: "TermLoop"))
            }
        }
        .padding(.vertical, 2)
        .onHover { isHovering = $0 }
    }
}

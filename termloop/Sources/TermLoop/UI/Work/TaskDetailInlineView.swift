// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct TaskDetailInlineView: View {
    let task: TermLoopTask
    let workspaces: [Workspace]
    let onOpenScratchpad: () -> Void
    let onNewWorkspace: () -> Void
    let onDelete: () -> Void
    let onRefresh: () -> Void
    let onOpenWorktreeInFinder: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(task.branch)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)

            if let link = task.externalLink {
                Link(destination: link.url) {
                    HStack(spacing: 4) {
                        Image(systemName: "link")
                        Text(link.ticketKey ?? link.url.host ?? link.url.absoluteString)
                    }
                    .font(.system(size: 11))
                }
            }

            Divider()

            prSection
            mergeSection
            syncSection

            Divider()

            workspaceSection

            Divider()

            scratchpadRow
            helperAgentRow

            HStack(spacing: 8) {
                Button("Open worktree in Finder", action: onOpenWorktreeInFinder)
                Spacer()
                Button(role: .destructive, action: onDelete) {
                    Text("Delete task…")
                }
            }
            .font(.system(size: 11))
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 10)
    }

    private var prSection: some View {
        HStack {
            if let pr = task.prInfo {
                Text("PR #\(pr.number) • \(pr.state.rawValue)")
            } else {
                Text("no PR").foregroundStyle(.secondary)
            }
            Spacer()
        }
        .font(.system(size: 11))
    }

    private var mergeSection: some View {
        let merged = task.mergeState.mergedInto.isEmpty ? "—" : task.mergeState.mergedInto.joined(separator: ", ")
        return Text("merged into: \(merged)")
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
    }

    private var syncSection: some View {
        HStack(spacing: 6) {
            if let synced = task.lastSyncedAt {
                Text("synced \(synced.formatted(.relative(presentation: .named)))")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Button(action: onRefresh) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10))
            }
            .buttonStyle(.plain)
        }
    }

    private var workspaceSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Workspaces (\(workspaces.count))").font(.system(size: 11, weight: .semibold))
            ForEach(workspaces, id: \.id) { ws in
                Text("· \(ws.displayTitle)").font(.system(size: 11))
            }
            Button(action: onNewWorkspace) {
                Text("· + New workspace in this task")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
    }

    private var scratchpadRow: some View {
        HStack {
            Label("Scratchpad", systemImage: "note.text")
                .font(.system(size: 11))
            Spacer()
            Button("Open", action: onOpenScratchpad)
                .font(.system(size: 11))
        }
    }

    private var helperAgentRow: some View {
        HStack {
            Text("Helper: \(task.helperAgentId ?? "none")")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            Spacer()
            Button("Run now") {}
                .disabled(true)
                .help("Coming in v1.1")
                .font(.system(size: 11))
        }
    }
}

private extension Workspace {
    var displayTitle: String {
        title.isEmpty ? "Terminal" : title
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import SwiftUI

private struct WorktreeCodeDeltaSnapshot: Equatable {
    let isDirty: Bool
    let hasDivergedFromBaseline: Bool

    var showsCoderBadge: Bool {
        isDirty || hasDivergedFromBaseline
    }
}

private enum WorktreeCodeDeltaProbe {
    static func snapshot(
        worktreePath: String,
        baselineHead: String?
    ) -> WorktreeCodeDeltaSnapshot {
        let service = GitWorktreeService()
        let isDirty = (try? service.isClean(worktreePath: worktreePath)).map { !$0 } ?? false
        let currentHead = try? service.headRevision(worktreePath: worktreePath)
        let hasDivergedFromBaseline = baselineHead.map { baseline in
            guard let currentHead, !currentHead.isEmpty else { return false }
            return currentHead != baseline
        } ?? false
        return WorktreeCodeDeltaSnapshot(
            isDirty: isDirty,
            hasDivergedFromBaseline: hasDivergedFromBaseline
        )
    }
}

struct WorktreeCoderBadge: View {
    let workspace: Workspace
    let branch: String
    let baselineHead: String?

    @State private var snapshot: WorktreeCodeDeltaSnapshot? = nil
    @State private var refreshNonce: UInt64 = 0

    private let pulseColor = Color(
        nsColor: NSColor(srgbRed: 0.486, green: 0.361, blue: 1.0, alpha: 1.0)
    )

    var body: some View {
        if snapshot?.showsCoderBadge == true {
            HStack(spacing: 4) {
                Circle()
                    .fill(pulseColor)
                    .frame(width: 5, height: 5)
                    .opacity(TerminalAgentActivityStore.shared.isRunning(forWorkspace: workspace) ? 1 : 0.8)

                Text(
                    String(
                        localized: "sidebar.worktree.coder",
                        defaultValue: "CODER",
                        table: "TermLoop"
                    )
                )
            }
            .font(.system(size: 9, weight: .bold))
            .foregroundColor(pulseColor)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(
                pulseColor.opacity(0.12),
                in: Capsule()
            )
            .help(tooltip)
            .task(id: refreshTaskKey) {
                await refreshSnapshot()
            }
            .onReceive(
                workspace.sidebarObservationPublisher
                    .receive(on: RunLoop.main)
                    .debounce(for: .milliseconds(120), scheduler: RunLoop.main)
            ) { _ in
                refreshNonce &+= 1
            }
        } else {
            Color.clear
                .frame(width: 0, height: 0)
                .task(id: refreshTaskKey) {
                    await refreshSnapshot()
                }
                .onReceive(
                    workspace.sidebarObservationPublisher
                        .receive(on: RunLoop.main)
                        .debounce(for: .milliseconds(120), scheduler: RunLoop.main)
                ) { _ in
                    refreshNonce &+= 1
                }
        }
    }

    private var refreshTaskKey: String {
        "\(branch)|\(baselineHead ?? "none")|\(refreshNonce)"
    }

    private var tooltip: String {
        guard let snapshot else {
            return branch
        }
        var parts: [String] = [branch]
        if snapshot.isDirty {
            parts.append(
                String(
                    localized: "sidebar.worktree.coder.reasonDirty",
                    defaultValue: "Uncommitted changes present",
                    table: "TermLoop"
                )
            )
        }
        if snapshot.hasDivergedFromBaseline {
            parts.append(
                String(
                    localized: "sidebar.worktree.coder.reasonCommitted",
                    defaultValue: "HEAD moved past attach baseline",
                    table: "TermLoop"
                )
            )
        }
        return parts.joined(separator: "\n")
    }

    @MainActor
    private func refreshInput() -> (path: String, baselineHead: String?)? {
        guard workspace.projectId != nil,
              let worktreePath = workspace.termLoopPresentationCwd() else {
            return nil
        }
        return (worktreePath, baselineHead)
    }

    private func refreshSnapshot() async {
        guard let input = refreshInput() else {
            await MainActor.run {
                snapshot = nil
            }
            return
        }
        let result = await Task.detached(priority: .utility) {
            WorktreeCodeDeltaProbe.snapshot(
                worktreePath: input.path,
                baselineHead: input.baselineHead
            )
        }.value
        guard !Task.isCancelled else { return }
        await MainActor.run {
            snapshot = result
        }
    }
}

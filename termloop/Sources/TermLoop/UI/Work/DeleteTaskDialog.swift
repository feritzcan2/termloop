// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct DeleteTaskDialog: View {
    let task: TermLoopTask
    let onConfirm: (TaskDeletionCoordinator.Options) -> Void
    let onCancel: () -> Void

    @State private var deleteWorktree = true
    @State private var deleteBranch = false
    @State private var deleteScratchpad = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Delete task").font(.title3).bold()
            Text("Delete \"\(task.title)\"?")

            Toggle(isOn: $deleteWorktree) {
                VStack(alignment: .leading) {
                    Text("Delete worktree at").font(.system(size: 12))
                    Text(task.worktreePath).font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            Toggle(isOn: $deleteBranch) {
                Text("Also delete branch '\(task.branch)' (local + remote if present)")
                    .font(.system(size: 12))
            }
            .disabled(!deleteWorktree)

            Toggle("Delete scratchpad notes", isOn: $deleteScratchpad)

            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                Button(role: .destructive) {
                    onConfirm(.init(
                        deleteWorktree: deleteWorktree,
                        deleteBranch: deleteBranch && deleteWorktree,
                        deleteScratchpad: deleteScratchpad
                    ))
                } label: { Text("Delete") }
            }
        }
        .padding(16)
        .frame(width: 420)
    }
}

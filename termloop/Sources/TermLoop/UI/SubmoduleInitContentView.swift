// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Bonsplit
import SwiftUI

// MARK: - Hook entry point

extension TermLoopHooks {
    /// ViewModifier that hides terminal content and shows a progress view
    /// while submodule init is active for the given workspace. Uses
    /// conditional rendering (not overlay) because AppKit terminal portal
    /// views render above SwiftUI overlays.
    static func submoduleInitGate(for workspaceId: UUID) -> SubmoduleInitGateModifier {
        SubmoduleInitGateModifier(workspaceId: workspaceId)
    }
}

/// ViewModifier that observes `SubmoduleInitStore` and swaps the
/// content between the terminal tree and a progress view. Replaces
/// the prior `.overlay` approach which didn't work because AppKit
/// portal-hosted terminal views sit above SwiftUI overlay layers.
@MainActor
struct SubmoduleInitGateModifier: ViewModifier {
    let workspaceId: UUID
    @ObservedObject private var store = SubmoduleInitStore.shared

    func body(content: Content) -> some View {
        let task = store.activeTask(for: workspaceId)
        #if DEBUG
        let _ = {
            dlog("submodule.gate wsId=\(workspaceId.uuidString.prefix(5)) taskCount=\(store.tasks.count) activeTask=\(task?.id.uuidString.prefix(5) ?? "nil") phase=\(task.map { "\($0.phase)" } ?? "n/a")")
        }()
        #endif
        if let task {
            SubmoduleInitContentView(task: task)
        } else {
            content
        }
    }
}

// MARK: - Content view

/// Full content-area view shown instead of terminal panes while a
/// workspace's submodule init is in progress. Displays per-submodule
/// progress, a live git stderr line, and (on failure) a retry button.
///
/// Replaces the Bonsplit terminal tree in `WorkspaceContentView` when
/// `SubmoduleInitStore.activeTask(for: workspaceId)` is non-nil.
@MainActor
struct SubmoduleInitContentView: View {
    @ObservedObject var task: SubmoduleInitStore.Task

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            icon
            titleSection
            cardSection
            logSection
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Icon

    @ViewBuilder
    private var icon: some View {
        switch task.phase {
        case .starting, .running:
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 36))
                .foregroundStyle(.tertiary)
                .padding(.bottom, 12)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 36))
                .foregroundStyle(.orange.opacity(0.7))
                .padding(.bottom, 12)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 36))
                .foregroundStyle(.green.opacity(0.7))
                .padding(.bottom, 12)
        }
    }

    // MARK: - Title

    private var titleSection: some View {
        VStack(spacing: 4) {
            switch task.phase {
            case .starting, .running:
                Text(String(
                    localized: "worktree.submodule.content.title.running",
                    defaultValue: "Initializing Submodules",
                    table: "TermLoop"
                ))
                .font(.system(size: 16, weight: .semibold))
                Text(String(
                    localized: "worktree.submodule.content.subtitle.running",
                    defaultValue: "\(task.label) worktree is being prepared…",
                    table: "TermLoop"
                ))
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            case .failed:
                Text(String(
                    localized: "worktree.submodule.content.title.failed",
                    defaultValue: "Submodule Init Failed",
                    table: "TermLoop"
                ))
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.orange)
                Text(String(
                    localized: "worktree.submodule.content.subtitle.failed",
                    defaultValue: "\(task.label) worktree could not be prepared",
                    table: "TermLoop"
                ))
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            case .completed:
                Text(String(
                    localized: "worktree.submodule.content.title.completed",
                    defaultValue: "Submodules Ready",
                    table: "TermLoop"
                ))
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.green)
            }
        }
        .padding(.bottom, 24)
    }

    // MARK: - Card

    private var cardSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch task.phase {
            case .starting:
                progressRow(
                    label: String(
                        localized: "worktree.submodule.content.starting",
                        defaultValue: "Starting…",
                        table: "TermLoop"
                    ),
                    showSpinner: true,
                    percent: nil
                )

            case .running(let submodule, let percent):
                progressRow(
                    label: submodule ?? String(
                        localized: "worktree.submodule.content.running",
                        defaultValue: "Running…",
                        table: "TermLoop"
                    ),
                    showSpinner: true,
                    percent: percent
                )

            case .failed(let reason):
                VStack(alignment: .leading, spacing: 12) {
                    Text(reason)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineLimit(6)

                    Button {
                        SubmoduleInitStore.shared.retry(taskId: task.id)
                    } label: {
                        Label(String(
                            localized: "worktree.submodule.content.retry",
                            defaultValue: "Retry Init",
                            table: "TermLoop"
                        ), systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                }

            case .completed:
                EmptyView()
            }
        }
        .padding(16)
        .frame(maxWidth: 440)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.5))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Color.primary.opacity(0.08))
                )
        )
    }

    // MARK: - Log

    @ViewBuilder
    private var logSection: some View {
        if !task.lastLine.isEmpty, isInProgress {
            VStack(alignment: .leading, spacing: 0) {
                Text(task.lastLine)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(10)
            .frame(maxWidth: 440, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(nsColor: .textBackgroundColor).opacity(0.3))
            )
            .padding(.top, 12)
        }
    }

    // MARK: - Helpers

    private var isInProgress: Bool {
        switch task.phase {
        case .starting, .running: return true
        default: return false
        }
    }

    private func progressRow(label: String, showSpinner: Bool, percent: Double?) -> some View {
        HStack(spacing: 10) {
            if showSpinner {
                ProgressView()
                    .progressViewStyle(.circular)
                    .controlSize(.small)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.system(size: 13))
                if let percent {
                    ProgressView(value: percent)
                        .progressViewStyle(.linear)
                }
            }

            Spacer()

            if let percent {
                Text("\(Int(percent * 100))%")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

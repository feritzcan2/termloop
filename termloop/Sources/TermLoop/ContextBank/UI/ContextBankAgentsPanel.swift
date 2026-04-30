// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Bottom panel of the Context Bank tab. Replaces the old card-style
/// `ContextBankSuggestionsView` — suggestions now live as child nodes in
/// the file tree (see `ContextBankView`). This panel surfaces the active
/// (and recently-finished) curator-fork runs that produced those
/// suggestions, plus an analyzer-error banner when one is present.
///
/// Each row reads from `ContextBankRunSnapshot`. Coordinator publishes
/// snapshots through `ContextBankStore.upsertRun(_:forProjectRoot:)`.
struct ContextBankAgentsPanel: View {
    let runs: [ContextBankRunSnapshot]
    let phase: ContextBankStore.AnalyzerPhase
    let onCancel: (UUID) -> Void
    let onDismiss: (UUID) -> Void
    let onClearError: () -> Void
    let onOpen: (UUID) -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .background(Color(NSColor.textBackgroundColor).opacity(0.2))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(String(
                localized: "contextBank.agents.title",
                defaultValue: "Analysis Agents",
                table: "TermLoop"
            ))
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            Spacer()
            if !runs.isEmpty {
                Text("\(runs.count)")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.accentColor))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(NSColor.windowBackgroundColor))
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                if case .error(let message) = phase {
                    errorBanner(message)
                }
                if runs.isEmpty {
                    emptyState
                } else {
                    ForEach(runs) { run in
                        AgentRow(
                            run: run,
                            onCancel: { onCancel(run.id) },
                            onDismiss: { onDismiss(run.id) },
                            onOpen: { onOpen(run.id) }
                        )
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "person.crop.rectangle")
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(.tertiary)
            Text(String(
                localized: "contextBank.agents.empty",
                defaultValue: "No analyses yet.\nRight-click a workspace → Send to Analyze.",
                table: "TermLoop"
            ))
            .multilineTextAlignment(.center)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.orange)
            Text(message)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button(action: onClearError) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.12))
        )
    }
}

private struct AgentRow: View {
    let run: ContextBankRunSnapshot
    let onCancel: () -> Void
    let onDismiss: () -> Void
    let onOpen: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            indicator
            VStack(alignment: .leading, spacing: 2) {
                Text(run.sourceWorkspaceTitle)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(phaseLabel)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            actionButton
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color.primary.opacity(0.04))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.primary.opacity(0.10), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { onOpen() }
        .help(String(
            localized: "contextBank.agents.openHint",
            defaultValue: "Click to open the curator's terminal",
            table: "TermLoop"
        ))
    }

    @ViewBuilder
    private var indicator: some View {
        switch run.phase {
        case .running:
            ProgressView().controlSize(.mini)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.system(size: 12, weight: .semibold))
        case .timeout:
            Image(systemName: "clock.badge.exclamationmark")
                .foregroundStyle(.orange)
                .font(.system(size: 12, weight: .semibold))
        case .cancelled:
            Image(systemName: "xmark.circle")
                .foregroundStyle(.secondary)
                .font(.system(size: 12, weight: .semibold))
        case .malformed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .font(.system(size: 12, weight: .semibold))
        }
    }

    private var phaseLabel: String {
        switch run.phase {
        case .running:
            return String(
                localized: "contextBank.agents.phase.running",
                defaultValue: "Curator thinking…",
                table: "TermLoop"
            )
        case .completed(let count):
            if count == 0 {
                return String(
                    localized: "contextBank.agents.phase.completedZero",
                    defaultValue: "Finalized · 0 suggestions",
                    table: "TermLoop"
                )
            }
            return String(
                localized: "contextBank.agents.phase.completedN",
                defaultValue: "Finalized · \(count) suggestion\(count == 1 ? "" : "s")",
                table: "TermLoop"
            )
        case .timeout:
            return String(
                localized: "contextBank.agents.phase.timeout",
                defaultValue: "Timed out",
                table: "TermLoop"
            )
        case .cancelled:
            return String(
                localized: "contextBank.agents.phase.cancelled",
                defaultValue: "Cancelled",
                table: "TermLoop"
            )
        case .malformed(let reason):
            return String(
                localized: "contextBank.agents.phase.malformed",
                defaultValue: "Malformed · \(reason)",
                table: "TermLoop"
            )
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        if run.isTerminal {
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.tertiary)
                    .padding(4)
            }
            .buttonStyle(.plain)
            .help(String(
                localized: "contextBank.agents.dismiss",
                defaultValue: "Dismiss",
                table: "TermLoop"
            ))
        } else {
            Button(action: onCancel) {
                Image(systemName: "stop.circle")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(2)
            }
            .buttonStyle(.plain)
            .help(String(
                localized: "contextBank.agents.cancel",
                defaultValue: "Cancel run",
                table: "TermLoop"
            ))
        }
    }
}

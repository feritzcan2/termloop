// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct LocalSetupInlineStatusRow: View {
    let status: WorktreeSetupStatusSnapshot
    let logs: [WorktreeSetupLogLine]
    let onPrepare: () -> Void
    let onSkip: () -> Void
    let onCancel: () -> Void
    let onOpenConfig: () -> Void
    let onGenerate: () -> Void

    @State private var showLogs = false

    var body: some View {
        HStack(alignment: .center, spacing: 7) {
            statusIcon
            VStack(alignment: .leading, spacing: 2) {
                Text(status.phase.localizedLabel)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(tint)
                if let error = status.errorMessage, !error.isEmpty {
                    Text(error)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                } else if status.phase == .needed {
                    Text(String(localized: "worktreeSetup.sidebar.detail", defaultValue: "Runs once before profiles that require project-local files.", table: "TermLoop"))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            controls
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(tint.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(tint.opacity(0.20), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var statusIcon: some View {
        if status.phase == .running {
            ProgressView()
                .controlSize(.small)
                .frame(width: 14, height: 14)
        } else {
            Image(systemName: status.phase == .failed || status.phase == .loadFailed ? "exclamationmark.triangle" : "wrench.and.screwdriver")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 14)
        }
    }

    @ViewBuilder
    private var controls: some View {
        HStack(spacing: 6) {
            switch status.phase {
            case .needed:
                Button(String(localized: "worktreeSetup.action.prepare", defaultValue: "Prepare", table: "TermLoop"), action: onPrepare)
                    .buttonStyle(.borderedProminent)
                Button(String(localized: "worktreeSetup.action.skip", defaultValue: "Skip", table: "TermLoop"), action: onSkip)
                    .buttonStyle(.bordered)
            case .running:
                logsButton
                Button(String(localized: "worktreeSetup.action.cancel", defaultValue: "Cancel", table: "TermLoop"), action: onCancel)
                    .buttonStyle(.bordered)
            case .failed:
                Button(String(localized: "worktreeSetup.action.retry", defaultValue: "Retry", table: "TermLoop"), action: onPrepare)
                    .buttonStyle(.borderedProminent)
                Button(String(localized: "worktreeSetup.action.skip", defaultValue: "Skip", table: "TermLoop"), action: onSkip)
                    .buttonStyle(.bordered)
                logsButton
            case .loadFailed:
                Button(String(localized: "worktreeSetup.action.openConfig", defaultValue: "Open config", table: "TermLoop"), action: onOpenConfig)
                    .buttonStyle(.bordered)
                Button(String(localized: "worktreeSetup.action.generate", defaultValue: "Generate", table: "TermLoop"), action: onGenerate)
                    .buttonStyle(.bordered)
            case .ready, .skipped:
                EmptyView()
            }
        }
        .controlSize(.mini)
        .font(.system(size: 10, weight: .medium))
    }

    private var logsButton: some View {
        Button(String(localized: "worktreeSetup.action.logs", defaultValue: "Logs", table: "TermLoop")) {
            showLogs = true
        }
        .buttonStyle(.borderless)
        .popover(isPresented: $showLogs) {
            LocalSetupLogPopover(lines: logs)
        }
    }

    private var tint: Color {
        switch status.phase {
        case .running, .needed:
            return .orange
        case .failed, .loadFailed:
            return .red
        case .ready:
            return Color(red: 0.30, green: 0.78, blue: 0.36)
        case .skipped:
            return .secondary
        }
    }
}

private struct LocalSetupLogPopover: View {
    let lines: [WorktreeSetupLogLine]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 5) {
                if lines.isEmpty {
                    Text(String(localized: "worktreeSetup.logs.empty", defaultValue: "No local setup logs yet.", table: "TermLoop"))
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(lines) { line in
                        HStack(alignment: .top, spacing: 8) {
                            Text(line.stream.rawValue)
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .foregroundStyle(color(for: line.stream))
                                .frame(width: 48, alignment: .trailing)
                            Text(line.text)
                                .font(.system(size: 10, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
            .padding(12)
        }
        .frame(width: 640, height: 300)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func color(for stream: DevServerLogStream) -> Color {
        switch stream {
        case .stdout: return .secondary
        case .stderr: return .orange
        case .system: return .accentColor
        }
    }
}


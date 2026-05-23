// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Composite chip for the `running-your-application` ability. Each stored
/// target is one run target the agent reported. With one
/// target we show a single chip; with two or more we collapse to
/// `Running (N)` and reveal the full list in a click-popover. Each row in
/// the popover is clickable (opens the URL/path) and has a × that clears
/// just that target — re-publishing happens the next time the agent calls
/// `set_run_targets`, so dismissals are not sticky on purpose.
@MainActor
struct WorktreeGroupRunTargetsBadge: View {
    let targets: [RunTargetStore.RunTarget]
    let workspaceIds: [UUID]
    let worktreePath: String?

    @State private var popoverShown = false

    var body: some View {
        if targets.count == 1, let only = targets.first {
            singleChip(for: only)
        } else if targets.count >= 2 {
            multiChip
        }
    }

    @ViewBuilder
    private func singleChip(for target: RunTargetStore.RunTarget) -> some View {
        let chip = HStack(spacing: 4) {
            statusDot(for: target.status)
            Text(verbatim: target.displayLabel)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .font(TermLoopSidebarTheme.tinyMono)
        .foregroundStyle(runTargetForeground)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(runTargetBackground))
        .overlay(Capsule().strokeBorder(runTargetBorder, lineWidth: 1))
        .help(tooltip(for: target))

        if let destination = target.destinationURL {
            Button {
                openTarget(destination)
            } label: {
                chip
            }
            .buttonStyle(.plain)
        } else {
            chip
        }
    }

    private var multiChip: some View {
        Button {
            popoverShown.toggle()
        } label: {
            HStack(spacing: 4) {
                aggregateStatusDot
                Text(verbatim: "Running (\(targets.count))")
                    .lineLimit(1)
            }
            .font(TermLoopSidebarTheme.tinyMono)
            .foregroundStyle(runTargetForeground)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(runTargetBackground))
            .overlay(Capsule().strokeBorder(runTargetBorder, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .popover(isPresented: $popoverShown, arrowEdge: .top) {
            popoverContent
                .padding(.vertical, 8)
                .padding(.horizontal, 10)
                .frame(minWidth: 260, alignment: .leading)
        }
    }

    private var popoverContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Target id is stable across re-publishes even when reportedAt
            // changes.
            ForEach(targets) { target in
                runTargetRow(for: target)
            }
        }
    }

    private func runTargetRow(
        for target: RunTargetStore.RunTarget
    ) -> some View {
        HStack(spacing: 6) {
            statusDot(for: target.status)
            VStack(alignment: .leading, spacing: 1) {
                if let destination = target.destinationURL {
                    Button {
                        openTarget(destination)
                    } label: {
                        Text(verbatim: target.label)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(verbatim: target.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.primary)
                }
                if let detail = secondaryLine(for: target) {
                    Text(verbatim: detail)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            Button {
                clear(target)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(4)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(Text(verbatim: "Remove from chip"))
        }
    }

    private func secondaryLine(
        for target: RunTargetStore.RunTarget
    ) -> String? {
        guard let url = target.url, !url.isEmpty else { return nil }
        return url
    }

    private func tooltip(
        for target: RunTargetStore.RunTarget
    ) -> String {
        var parts = [target.label]
        if let status = target.status, !status.isEmpty {
            parts.append("status: \(status)")
        }
        if let url = target.url, !url.isEmpty {
            parts.append(url)
            if let scheme = URL(string: url)?.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                parts.append("⌘/⌥-click to open in TermLoop browser")
            }
        }
        return parts.joined(separator: "\n")
    }

    /// Plain click → external browser (`NSWorkspace.open`). Cmd- or
    /// Option-click on an http(s) URL → open in a new browser pane inside
    /// the worktree's focused workspace. `file://` URLs (app bundles, log
    /// files) always go to the system regardless of modifier.
    private func openTarget(_ url: URL) {
        WorktreeURLRouter.open(url, workspaceIds: workspaceIds)
    }

    private func clear(
        _ target: RunTargetStore.RunTarget
    ) {
        guard let worktreePath else { return }
        RunTargetStore.shared.removeTarget(id: target.id, forPath: worktreePath)
    }

    // MARK: Status visuals

    private func statusDot(for raw: String?) -> some View {
        Circle()
            .fill(color(for: normalizedStatus(raw)))
            .frame(width: 6, height: 6)
    }

    private var aggregateStatusDot: some View {
        Circle()
            .fill(aggregateStatusColor)
            .frame(width: 6, height: 6)
    }

    private var aggregateStatusColor: Color {
        let statuses = targets.map { normalizedStatus($0.status) }
        if statuses.contains(.error) { return color(for: .error) }
        if statuses.contains(.running) { return color(for: .running) }
        if statuses.allSatisfy({ $0 == .stopped }) { return color(for: .stopped) }
        return color(for: .unknown)
    }

    private enum NormalizedStatus { case running, stopped, error, unknown }

    /// Schema/hint promise three values; anything else surfaces as `unknown`.
    /// Synonym lists were dropped — undocumented strings shouldn't quietly
    /// paint a row green/red and let the agent assume the contract was met.
    private func normalizedStatus(_ raw: String?) -> NormalizedStatus {
        switch raw?.lowercased() {
        case "running": return .running
        case "stopped": return .stopped
        case "error":   return .error
        default:        return .unknown
        }
    }

    private func color(for normalized: NormalizedStatus) -> Color {
        switch normalized {
        case .running: return Color(red: 0.30, green: 0.78, blue: 0.36)
        case .stopped: return Color(white: 0.55)
        case .error:   return Color(red: 0.92, green: 0.36, blue: 0.31)
        case .unknown: return Color(white: 0.55).opacity(0.7)
        }
    }

    private var runTargetForeground: Color {
        Color(red: 0.30, green: 0.78, blue: 0.36)
    }

    private var runTargetBackground: Color {
        runTargetForeground.opacity(0.14)
    }

    private var runTargetBorder: Color {
        runTargetForeground.opacity(0.45)
    }
}

@MainActor
enum WorktreeURLRouter {
    /// Plain click opens in the system default app. Command- or Option-click
    /// on http(s) opens in TermLoop's internal browser for the worktree.
    static func open(
        _ url: URL,
        workspaceIds: [UUID],
        preferredWorkspaceId: UUID? = nil
    ) {
        let modifiers = NSEvent.modifierFlags.intersection([.command, .option])
        let isWebURL = (url.scheme?.lowercased()).map { $0 == "http" || $0 == "https" } ?? false
        guard !modifiers.isEmpty, isWebURL else {
            NSWorkspace.shared.open(url)
            return
        }

        let candidateWorkspaceIds = ([preferredWorkspaceId].compactMap { $0 } + workspaceIds)
            .uniquedPreservingOrder()
        for workspaceId in candidateWorkspaceIds {
            guard let tabManager = AppDelegate.shared?.tabManagerFor(tabId: workspaceId) else {
                continue
            }
            _ = tabManager.openBrowser(
                inWorkspace: workspaceId,
                url: url,
                preferSplitRight: true
            )
            return
        }

        NSWorkspace.shared.open(url)
    }
}

private extension Array where Element: Hashable {
    func uniquedPreservingOrder() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

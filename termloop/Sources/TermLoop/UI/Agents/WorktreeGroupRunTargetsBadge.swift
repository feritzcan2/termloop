// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Composite chip for the `running-your-application` ability. Each binding
/// under that ability is one run target the agent reported. With one
/// target we show a single chip; with two or more we collapse to
/// `Running (N)` and reveal the full list in a click-popover. Each row in
/// the popover is clickable (opens the URL/path) and has a × that clears
/// just that target — re-publishing happens the next time the agent calls
/// `set_run_targets`, so dismissals are not sticky on purpose.
@MainActor
struct WorktreeGroupRunTargetsBadge: View {
    let bindings: [AgentReportedStateStore.AgentReportedBinding]
    let workspaceIds: [UUID]

    @State private var popoverShown = false

    var body: some View {
        if bindings.count == 1, let only = bindings.first {
            singleChip(for: only)
        } else if bindings.count >= 2 {
            multiChip
        }
    }

    @ViewBuilder
    private func singleChip(for binding: AgentReportedStateStore.AgentReportedBinding) -> some View {
        let chip = HStack(spacing: 4) {
            statusDot(for: binding.status)
            Text(verbatim: binding.displayLabel)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .font(TermLoopSidebarTheme.tinyMono)
        .foregroundStyle(runTargetForeground)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(runTargetBackground))
        .overlay(Capsule().strokeBorder(runTargetBorder, lineWidth: 1))
        .help(tooltip(for: binding))

        if let destination = binding.destinationURL {
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
                Text(verbatim: "Running (\(bindings.count))")
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
            // id: \.bindingId — `AgentReportedBinding` Hashable folds in
            // `reportedAt`, so `\.self` would re-create every row on each
            // re-publish even when label/url/status are unchanged.
            ForEach(bindings, id: \AgentReportedStateStore.AgentReportedBinding.bindingId) { binding in
                runTargetRow(for: binding)
            }
        }
    }

    private func runTargetRow(
        for binding: AgentReportedStateStore.AgentReportedBinding
    ) -> some View {
        HStack(spacing: 6) {
            statusDot(for: binding.status)
            VStack(alignment: .leading, spacing: 1) {
                if let destination = binding.destinationURL {
                    Button {
                        openTarget(destination)
                    } label: {
                        Text(verbatim: binding.label)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(verbatim: binding.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.primary)
                }
                if let detail = secondaryLine(for: binding) {
                    Text(verbatim: detail)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            Button {
                clear(binding)
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
        for binding: AgentReportedStateStore.AgentReportedBinding
    ) -> String? {
        guard let url = binding.url, !url.isEmpty else { return nil }
        return url
    }

    private func tooltip(
        for binding: AgentReportedStateStore.AgentReportedBinding
    ) -> String {
        var parts = [binding.label]
        if let status = binding.status, !status.isEmpty {
            parts.append("status: \(status)")
        }
        if let url = binding.url, !url.isEmpty {
            parts.append(url)
            if let scheme = URL(string: url)?.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                parts.append("⌘/⌥-click to open in cmux browser")
            }
        }
        return parts.joined(separator: "\n")
    }

    /// Plain click → external browser (`NSWorkspace.open`). Cmd- or
    /// Option-click on an http(s) URL → open in a new browser pane inside
    /// the worktree's focused workspace, split right of whatever's there
    /// so the existing terminal stays visible. `file://` URLs (app
    /// bundles, log files) always go to the system regardless of
    /// modifier — internal WKWebView wouldn't render those usefully.
    private func openTarget(_ url: URL) {
        let modifiers = NSEvent.modifierFlags.intersection([.command, .option])
        let isWebURL = (url.scheme?.lowercased()).map { $0 == "http" || $0 == "https" } ?? false
        let openInternally = !modifiers.isEmpty && isWebURL
        guard openInternally,
              let workspaceId = workspaceIds.first,
              let tabManager = AppDelegate.shared?.tabManagerFor(tabId: workspaceId) else {
            NSWorkspace.shared.open(url)
            return
        }
        _ = tabManager.openBrowser(
            inWorkspace: workspaceId,
            url: url,
            preferSplitRight: true
        )
    }

    private func clear(
        _ binding: AgentReportedStateStore.AgentReportedBinding
    ) {
        // Bindings are path-keyed and every workspace in a group shares the
        // same worktree path, so any id resolves to the same store entry.
        guard let firstId = workspaceIds.first else { return }
        WorkspaceMetadataStore.shared.setReportedBinding(
            nil,
            abilityId: binding.abilityId,
            bindingId: binding.bindingId,
            forWorkspaceId: firstId
        )
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
        let statuses = bindings.map { normalizedStatus($0.status) }
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

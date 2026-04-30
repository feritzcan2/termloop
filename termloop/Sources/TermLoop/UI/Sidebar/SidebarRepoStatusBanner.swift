// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import SwiftUI

/// Compact info banner shown in the sidebar tutorial stack: detected repo
/// (host + slug) plus the CLI tools relevant to that host with availability
/// ticks. Read-only — taps do nothing today.
struct SidebarRepoStatusBanner: View {
    private static let dismissId = "repo-status-banner"

    @ObservedObject private var projectStore = ProjectStore.shared
    @ObservedObject private var cliProbe = SidebarCLIStatusProbe.shared
    @ObservedObject private var sessionState = SidebarTutorialSessionState.shared

    @State private var identity: GitProjectIdentity?
    @State private var observation: AnyCancellable?
    @State private var observedFolderPath: String?

    var body: some View {
        if !sessionState.isDismissed(id: Self.dismissId) {
            VStack(alignment: .leading, spacing: 6) {
                repoHeader
                cliRow
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Rectangle()
                    .fill(Color.primary.opacity(0.04))
            )
            .overlay(
                Rectangle()
                    .stroke(TermLoopSidebarTheme.ruleStrong, lineWidth: 1)
            )
            .help(tooltipText)
            .onAppear {
                cliProbe.refreshIfStale()
                observeActiveProject()
            }
            .onChange(of: projectStore.activeProjectId) { _ in
                observeActiveProject()
            }
        }
    }

    // MARK: - Repo header

    @ViewBuilder
    private var repoHeader: some View {
        HStack(spacing: 6) {
            Image(systemName: hostIconName(for: identity?.hostKind))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(identity?.primaryRemote != nil
                                 ? TermLoopSidebarTheme.accent
                                 : TermLoopSidebarTheme.dim)
                .frame(width: 14)

            VStack(alignment: .leading, spacing: 1) {
                Text(repoTitle)
                    .font(TermLoopSidebarTheme.bodyMonoStrong)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let label = hostLabel {
                    Text(label)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                }
            }
            Spacer(minLength: 0)
            dismissButton
        }
    }

    private var dismissButton: some View {
        Button {
            sessionState.dismiss(id: Self.dismissId)
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(String(
            localized: "sidebarTutorial.dismiss.help",
            defaultValue: "Hide until app relaunch",
            table: "TermLoop"
        ))
    }

    @ViewBuilder
    private var cliRow: some View {
        HStack(spacing: 6) {
            ForEach(relevantTools(for: identity?.hostKind ?? .unknown)) { tool in
                cliPill(for: tool)
            }
            Spacer(minLength: 0)
        }
    }

    private func cliPill(for tool: SidebarCLIStatusProbe.Tool) -> some View {
        let status = cliProbe.status(tool)
        return TermLoopSidebarToken(
            label: tool.displayName,
            iconSystemName: status.isAvailable ? "checkmark" : "xmark",
            tone: status.isAvailable ? .accent : .muted
        )
        .help(pillTooltip(for: status))
    }

    // MARK: - Strings

    private var repoTitle: String {
        if let primary = identity?.primaryRemote {
            return primary.displaySlug
        }
        return String(
            localized: "sidebar.repoStatus.notDetected",
            defaultValue: "Repository not detected",
            table: "TermLoop"
        )
    }

    private var hostLabel: String? {
        guard let host = identity?.hostKind else { return nil }
        switch host {
        case .github:
            return "GitHub"
        case .githubEnterprise:
            return "GitHub Enterprise"
        case .azureDevOps:
            return "Azure DevOps"
        case .gitLab:
            return "GitLab"
        case .unknown:
            return identity?.primaryRemote == nil
                ? String(
                    localized: "sidebar.repoStatus.noRemote",
                    defaultValue: "No remote configured",
                    table: "TermLoop"
                )
                : nil
        }
    }

    private var tooltipText: String {
        guard let primary = identity?.primaryRemote else {
            return String(
                localized: "sidebar.repoStatus.tooltip.noRepo",
                defaultValue: "Active project has no detectable git remote.",
                table: "TermLoop"
            )
        }
        return primary.cloneURL
    }

    private func pillTooltip(for status: SidebarCLIStatusProbe.Status) -> String {
        if let path = status.resolvedPath {
            return "\(status.tool.fullName) → \(path)"
        }
        return String(
            localized: "sidebar.repoStatus.cli.missing",
            defaultValue: "\(status.tool.fullName) not found in PATH",
            table: "TermLoop"
        )
    }

    // MARK: - Host → icon / tools

    private func hostIconName(for host: GitHostKind?) -> String {
        switch host {
        case .github, .githubEnterprise:
            return "chevron.left.forwardslash.chevron.right"
        case .azureDevOps:
            return "cloud"
        case .gitLab:
            return "arrow.triangle.branch"
        case .unknown, .none:
            return "questionmark.folder"
        }
    }

    private func relevantTools(for host: GitHostKind) -> [SidebarCLIStatusProbe.Tool] {
        switch host {
        case .github, .githubEnterprise:
            return [.git, .gh]
        case .azureDevOps:
            return [.git, .az]
        case .gitLab:
            return [.git, .glab]
        case .unknown:
            return [.git]
        }
    }

    // MARK: - Identity observation

    @MainActor
    private func observeActiveProject() {
        guard let projectId = projectStore.activeProjectId,
              let project = projectStore.project(id: projectId) else {
            identity = nil
            observation = nil
            observedFolderPath = nil
            return
        }
        let folderPath = project.folderPath
        if observedFolderPath == folderPath { return }
        observedFolderPath = folderPath
        identity = nil // clear stale display while the new identity loads
        observation = GitProjectStore.shared
            .identityPublisher(for: folderPath)
            .receive(on: DispatchQueue.main)
            .sink { resolved in
                identity = resolved
            }
    }
}

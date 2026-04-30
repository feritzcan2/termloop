// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Renders the `requiredMCP / requiredCLI / requiredSkill` rows for an ability
/// alongside install/connection status pulled from `IntegrationsStore`. Read-only;
/// configuration happens elsewhere.
@MainActor
struct AbilitySetupCard: View {
    let ability: Ability
    let projectFolderPath: String?
    @ObservedObject private var integrationsStore = IntegrationsStore.shared
    @State private var skillRefreshTick: UInt = 0
    @State private var skillErrorMessage: String? = nil

    var body: some View {
        AbilityDetailCard(
            title: "Setup",
            subtitle: "Tools and connections this ability expects."
        ) {
            if ability.items.isEmpty {
                Text("No external requirements declared.")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(ability.requiredMCPs, id: \.id) { mcpRow($0) }
                    ForEach(ability.requiredCLIs, id: \.command) { cliRow($0) }
                    ForEach(ability.requiredSkillIDs, id: \.self) { skillRow($0) }
                }
            }
        }
        .onAppear {
            // Catch freshly added MCP/CLI entries when the user opens the
            // Setup card without visiting the Integrations tab. Debounced
            // so re-mounts (tab switches, scrolls) don't restart the full
            // discovery + testAll pipeline.
            IntegrationsStore.shared.refreshIfStale()
        }
        .alert(
            "Skill copy failed",
            isPresented: Binding(
                get: { skillErrorMessage != nil },
                set: { if !$0 { skillErrorMessage = nil } }
            ),
            presenting: skillErrorMessage
        ) { _ in
            Button("OK", role: .cancel) { skillErrorMessage = nil }
        } message: { message in
            Text(message)
        }
    }

    // MARK: Rows

    @ViewBuilder
    private func mcpRow(_ requirement: AbilityMCPRequirement) -> some View {
        let match = integrationsStore.match(requirement: requirement)
        let token: (label: String, tone: TermLoopSidebarTokenTone) = {
            if match.ready { return ("ready", .accent) }
            if match.partial { return ("partial", .warning) }
            return ("missing", .warning)
        }()
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: match.ready ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(match.ready ? Color.green : Color.orange)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    TermLoopSidebarToken(label: "MCP", tone: .muted)
                    Text(requirement.title)
                        .font(TermLoopSidebarTheme.bodyMonoStrong)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    TermLoopSidebarToken(
                        label: token.label,
                        tone: token.tone,
                        emphasized: !match.ready
                    )
                }
                if let summary = match.primaryItem?.summary {
                    Text(summary)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(requirement.requiredFor, id: \.self) { agent in
                    perAgentLine(agent: agent, hasIt: match.hasRegistered(agent))
                }
                if !match.ready, let installHint = requirement.installHint, !installHint.isEmpty {
                    Text(installHint)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dimmer)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func perAgentLine(agent: AbilityAgentFamily, hasIt: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: hasIt ? "checkmark" : "xmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(hasIt ? Color.green : Color.orange)
            Text(agent.displayName)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            Text("—")
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dimmer)
            Text(hasIt ? "registered in \(agent.configFileLabel)" : "not in \(agent.configFileLabel)")
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dimmer)
        }
    }

    private func cliRow(_ requirement: AbilityCLIRequirement) -> some View {
        let item = integrationsStore.item(id: IntegrationItem.makeId(kind: .cli, name: requirement.command))
        // CLI discovery only PATH-checks (no functional probe), so it leaves
        // a found binary at `.idle`. For the Setup card "discovered on PATH"
        // is enough — full verification is the Integrations panel's job. MCP
        // rows still demand `.ok` because the connection has to actually work.
        let ready = (item?.binaryPath != nil) || (item?.status.isReady ?? false)
        return requirementRow(
            kind: "CLI",
            title: "\(requirement.title) (`\(requirement.command)`)",
            subtitle: item?.summary ?? "`\(requirement.command)` was not detected on PATH.",
            installHint: requirement.installHint,
            ready: ready
        )
    }

    private func skillRow(_ id: String) -> some View {
        _ = skillRefreshTick
        let projectRoot = projectFolderPath.map { URL(fileURLWithPath: $0, isDirectory: true) }
        let probe = AbilitySkillProbe.resolve(id: id, projectRoot: projectRoot)
        return requirementRow(
            kind: "Skill",
            title: id,
            subtitle: probe.detail,
            installHint: nil,
            ready: probe.exists,
            actionTitle: probe.canCopyToProject ? "Copy to project" : nil,
            action: probe.canCopyToProject ? {
                copySkillToProject(id: id, probe: probe)
            } : nil
        )
    }

    private func copySkillToProject(id: String, probe: AbilitySkillProbe) {
        guard let source = probe.fileURL else { return }
        do {
            try ProjectSkillMaterializer.adoptSkillToProject(
                projectFolderPath: projectFolderPath,
                skillId: id,
                sourceSkillFile: source
            )
            skillRefreshTick &+= 1
        } catch {
            skillErrorMessage = error.localizedDescription
        }
    }

    private func requirementRow(
        kind: String,
        title: String,
        subtitle: String,
        installHint: String?,
        ready: Bool,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: ready ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(ready ? Color.green : Color.orange)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    TermLoopSidebarToken(label: kind, tone: .muted)
                    Text(title)
                        .font(TermLoopSidebarTheme.bodyMonoStrong)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    if let actionTitle, let action {
                        Button(actionTitle, action: action)
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                    }
                    TermLoopSidebarToken(
                        label: ready ? "ready" : "missing",
                        tone: ready ? .accent : .warning,
                        emphasized: !ready
                    )
                }
                Text(subtitle)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .fixedSize(horizontal: false, vertical: true)
                if !ready, let installHint, !installHint.isEmpty {
                    Text(installHint)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dimmer)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

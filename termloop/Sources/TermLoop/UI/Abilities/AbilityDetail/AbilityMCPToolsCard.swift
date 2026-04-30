// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// "MCP tools" card on `AbilityDetailPage`. Lists each TermLoop built-in MCP
/// tool the ability ships, with the description and JSON schema the agent
/// actually sees in `tools/list`. Toggle drops the tool from the surfaced set
/// for any agent run launched in this project (filter lives in the CLI MCP
/// server's disk read of `<cwd>/.termloop/abilities/*/ability.json`).
@MainActor
struct AbilityMCPToolsCard: View {
    let ability: Ability
    let onToggle: (_ toolName: String, _ enabled: Bool) -> Void

    var body: some View {
        AbilityDetailCard(
            title: "MCP tools",
            subtitle: ability.mcpTools.isEmpty
                ? "This ability does not provide any TermLoop MCP tools."
                : "TermLoop MCP tools surfaced to the agent when this ability is active. Toggle off to hide one without uninstalling the ability."
        ) {
            if ability.mcpTools.isEmpty {
                EmptyView()
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(ability.mcpTools, id: \.name) { binding in
                        toolBlock(binding)
                    }
                }
            }
        }
    }

    private func toolBlock(_ binding: AbilityMCPToolBinding) -> some View {
        let meta = TermLoopBuiltInToolMeta.meta(for: binding.name)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text("mcp__termloop__\(binding.name)")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(binding.enabled ? Color.primary : TermLoopSidebarTheme.dim)
                Spacer(minLength: 0)
                Toggle(
                    "",
                    isOn: Binding(
                        get: { binding.enabled },
                        set: { onToggle(binding.name, $0) }
                    )
                )
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
            }
            if let meta {
                Text(meta.description)
                    .font(.system(size: 11))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .fixedSize(horizontal: false, vertical: true)
                DisclosureGroup("Input schema") {
                    Text(meta.inputSchemaJSON)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(
                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .fill(Color.primary.opacity(0.04))
                        )
                        .padding(.top, 4)
                }
                .font(.system(size: 11))
            } else {
                Text("Unknown tool — not in the bundled CLI registry.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.primary.opacity(0.03))
        )
    }
}

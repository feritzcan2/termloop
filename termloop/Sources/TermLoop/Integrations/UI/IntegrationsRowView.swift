// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct IntegrationsRowView: View {
    let item: IntegrationItem
    let isSelected: Bool
    let onSelect: () -> Void
    let onTest: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            statusDot
            Text(item.displayName)
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.tail)
            // For MCPs, surface which agent configs declare this server so
            // the user can spot Claude-only / Codex-only mismatches without
            // opening each entry. Skip when no per-agent membership info is
            // available (CLIs, hooks, etc.).
            if item.kind == .mcp {
                ForEach(AbilityAgentFamily.allCases, id: \.self) { agent in
                    agentBadge(agent: agent, hasIt: item.availableForAgents.contains(agent))
                }
            }
            Spacer(minLength: 6)
            Button(action: onTest) {
                Text(String(localized: "integrations.action.test",
                            defaultValue: "Test", table: "TermLoop"))
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 3)
                        .stroke(Color.primary.opacity(0.2), lineWidth: 1))
            }
            .buttonStyle(.plain)
            if item.attachedToActiveSpawn {
                Image(systemName: "star.fill")
                    .font(.system(size: 9))
                    .foregroundColor(.yellow)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { onSelect() }
    }

    private func agentBadge(agent: AbilityAgentFamily, hasIt: Bool) -> some View {
        Text(agent.rawValue)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundColor(hasIt ? .green : Color.primary.opacity(0.25))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 3)
                .stroke(hasIt ? Color.green.opacity(0.4) : Color.primary.opacity(0.15),
                        lineWidth: 1))
            .help(hasIt
                  ? "Registered in \(agent.configFileLabel)"
                  : "Not in \(agent.configFileLabel)")
    }

    @ViewBuilder
    private var statusDot: some View {
        Circle()
            .fill(color(for: item.status))
            .frame(width: 7, height: 7)
    }

    private func color(for status: IntegrationItem.Status) -> Color {
        switch status {
        case .ok: return .green
        case .fail: return .red
        case .running: return .yellow
        case .notConfigured: return .gray
        case .idle: return Color.primary.opacity(0.3)
        }
    }
}

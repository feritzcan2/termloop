// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct QuickActionAdvancedPreviewTab: View {
    @ObservedObject var preview: QuickActionPreviewViewModel
    let promptStatus: QuickActionInputStatus
    let systemStatus: QuickActionInputStatus
    let selectedTemplate: AgentTemplate?
    let templateOriginLabel: String
    let promptSourceLabel: String
    let templateSourcePath: String?
    let resolvedVariables: [QuickActionResolvedVariable]
    let cwd: String?
    let branch: String?
    let plan: AgentInvocationPlan?
    let transport: AgentInvocationTransportAdapter.Resolution?
    @State private var promptExpanded: Bool = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                templateSection
                abilitiesSection
                authoredSystemPromptSection
                promptSection
            }
            .padding(12)
        }
    }

    @ViewBuilder
    private var templateSection: some View {
        let effectiveTemplate = plan?.template ?? selectedTemplate
        if let effectiveTemplate {
            VStack(alignment: .leading, spacing: 6) {
                Text("Template").font(.headline)
                if let selectedTemplate,
                   let planTemplate = plan?.template,
                   selectedTemplate.id != planTemplate.id {
                    Text("Selection and composed plan disagree.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Text(effectiveTemplate.name)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                Divider()
            }
        }
    }

    @ViewBuilder
    private var authoredSystemPromptSection: some View {
        if plan?.resolvedUserSystemPrompt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            VStack(alignment: .leading, spacing: 6) {
                Text(String(localized: "quickAction.preview.tab.deliveredSystemInstructions",
                            defaultValue: "System instructions",
                            table: "TermLoop"))
                    .font(.headline)
                Text(systemStatus.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                monoBlock(plan?.resolvedUserSystemPrompt, empty: "")
                Divider()
            }
        }
    }

    @ViewBuilder
    private var abilitiesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(String(localized: "quickAction.preview.tab.abilities",
                            defaultValue: "Sent context",
                            table: "TermLoop"))
                    .font(.headline)
                Text("source map")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.accentColor.opacity(0.18))
                    .foregroundStyle(Color.accentColor)
                    .cornerRadius(3)
            }
            Text(String(localized: "quickAction.preview.tab.abilitiesSource",
                        defaultValue: "Ability rules and generated folder context included in this run.",
                        table: "TermLoop"))
                .font(.caption)
                .foregroundStyle(.secondary)
            if contextInstructionParts.isEmpty {
                Text(String(localized: "quickAction.preview.tab.noAbilities",
                            defaultValue: "No project abilities or generated context are active for this preview.",
                            table: "TermLoop"))
                    .foregroundStyle(.secondary)
            } else {
                AgentInstructionPartsList(
                    parts: contextInstructionParts,
                    mutedAbilityIds: preview.mutedIds,
                    onToggleAbility: preview.togglePerRunMute,
                    onToggleGenerated: preview.toggleGeneratedPart
                )
            }
            Divider()
        }
    }

    private var contextInstructionParts: [AgentInstructionPart] {
        guard let plan else { return [] }
        return AgentInputQueries.contextInstructionParts(from: plan)
    }

    @ViewBuilder
    private var promptSection: some View {
        if plan?.resolvedPromptBody?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("First message").font(.headline)
                    Text(promptStatus.shortLabel)
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Color.accentColor.opacity(0.18))
                        .foregroundStyle(Color.accentColor)
                        .cornerRadius(3)
                    Spacer()
                    if shouldOfferPromptExpansion {
                        Button(promptExpanded ? "Collapse" : "Expand") {
                            promptExpanded.toggle()
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    }
                }
                Text(promptStatus.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                monoBlock(promptBodyForDisplay, empty: "")
            }
        }
    }

    private var shouldOfferPromptExpansion: Bool {
        guard let prompt = plan?.resolvedPromptBody else { return false }
        return promptLineCount(prompt) > 14
    }

    private var promptBodyForDisplay: String? {
        guard let prompt = plan?.resolvedPromptBody else { return nil }
        guard !promptExpanded else { return prompt }
        return truncatedPrompt(prompt)
    }

    private func truncatedPrompt(_ value: String) -> String {
        let lines = value.components(separatedBy: .newlines)
        guard lines.count > 14 else { return value }
        return lines.prefix(14).joined(separator: "\n") + "\n\n…"
    }

    private func promptLineCount(_ value: String) -> Int {
        value.components(separatedBy: .newlines).count
    }

    @ViewBuilder
    private func monoBlock(_ value: String?, empty: String) -> some View {
        Text(value?.isEmpty == false ? value! : empty)
            .font(.system(.callout, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(Color.secondary.opacity(0.06))
            .cornerRadius(4)
    }

}

@MainActor
struct AgentInstructionPartsList: View {
    let parts: [AgentInstructionPart]
    let folderName: String
    let mutedAbilityIds: Set<String>
    let onToggleAbility: ((String) -> Void)?
    let onToggleGenerated: ((InstructionRunOverrides.GeneratedPartKind) -> Void)?
    @State private var expandedPartIds: Set<String> = []

    init(
        parts: [AgentInstructionPart],
        folderName: String = "PAYLOAD",
        mutedAbilityIds: Set<String> = [],
        onToggleAbility: ((String) -> Void)? = nil,
        onToggleGenerated: ((InstructionRunOverrides.GeneratedPartKind) -> Void)? = nil
    ) {
        self.parts = parts
        self.folderName = folderName
        self.mutedAbilityIds = mutedAbilityIds
        self.onToggleAbility = onToggleAbility
        self.onToggleGenerated = onToggleGenerated
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(parts) { part in
                partRow(part)
            }
        }
    }

    private func partRow(_ part: AgentInstructionPart) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(part.title)
                    .font(.system(.body, weight: .semibold))
                badge(part.source.kindLabel)
                badge(part.scope.rawValue)
                if !part.enabled {
                    badge("disabled", color: .orange)
                }
                Spacer(minLength: 8)
                Button("Copy") {
                    copy(part.body)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                if case .openFile(let url) = part.editability {
                    Button(part.editability.actionLabel ?? "Open") {
                        open(url, title: part.title)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
                if let onToggleAbility,
                   let abilityId = part.kind.abilityRunOverrideId {
                    let isMuted = mutedAbilityIds.contains(abilityId)
                    Button(isMuted ? "Restore" : "Disable for run") {
                        onToggleAbility(abilityId)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
                if let onToggleGenerated,
                   let overrideKind = part.kind.generatedOverrideKind {
                    Button(part.enabled ? generatedDisableLabel(for: part) : "Restore") {
                        onToggleGenerated(overrideKind)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
            }
            Text(displayedBody(for: part))
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if shouldTruncate(part) {
                Button(expandedPartIds.contains(part.id) ? "Show less" : "Show more") {
                    toggleExpansion(for: part.id)
                }
                .buttonStyle(.borderless)
                .controlSize(.mini)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("source: \(part.source.label)")
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("edit: \(part.editability.detail)")
                if let disableReason = part.disableReason {
                    Text("disabled: \(disableReason)")
                }
            }
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(.secondary)
        }
        .padding(8)
        .background(Color.secondary.opacity(0.06))
        .cornerRadius(4)
    }

    private func generatedDisableLabel(for part: AgentInstructionPart) -> String {
        switch part.kind {
        case .abilityPayloadBlock:
            return "Disable block"
        default:
            return "Disable for run"
        }
    }

    private func badge(_ label: String, color: Color = .accentColor) -> some View {
        Text(label)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(color.opacity(0.16))
            .foregroundStyle(color)
            .cornerRadius(3)
    }

    private func displayedBody(for part: AgentInstructionPart) -> String {
        let body = part.body.isEmpty ? "(disabled for this run)" : part.body
        guard shouldTruncate(part), !expandedPartIds.contains(part.id) else { return body }
        return truncated(body)
    }

    private func shouldTruncate(_ part: AgentInstructionPart) -> Bool {
        let body = part.body.isEmpty ? "(disabled for this run)" : part.body
        return body.count > 1_200 || body.filter { $0 == "\n" }.count > 18
    }

    private func truncated(_ body: String) -> String {
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false)
        if lines.count > 18 {
            return lines.prefix(18).joined(separator: "\n") + "\n…"
        }
        if body.count > 1_200 {
            return String(body.prefix(1_200)) + "\n…"
        }
        return body
    }

    private func toggleExpansion(for id: String) {
        if expandedPartIds.contains(id) {
            expandedPartIds.remove(id)
        } else {
            expandedPartIds.insert(id)
        }
    }

    private func copy(_ value: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(value, forType: .string)
    }

    private func open(_ url: URL, title: String) {
        MarkdownDocumentStore.shared.open(
            fileURL: url,
            folderName: folderName,
            displayTitle: title
        )
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

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
                authoredSystemPromptSection
                deliveredSystemInstructionsSection
                abilitiesSection
                runContextSection
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
                HStack(spacing: 6) {
                    Text("Template").font(.headline)
                    originBadge(label: effectiveTemplate.source == .builtin ? "builtin" : templateOriginLabel)
                }
                if let selectedTemplate,
                   let planTemplate = plan?.template,
                   selectedTemplate.id != planTemplate.id {
                    Text("Selection and composed plan disagree.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                field("name", effectiveTemplate.name)
                field("id", effectiveTemplate.id)
                field("prompt source", promptSourceLabel)
                field("source", effectiveTemplate.source.rawValue)
                field("scope", effectiveTemplate.scope.rawValue)
                let effectivePath = plan?.template?.sourceURL.path ?? templateSourcePath
                if let effectivePath {
                    field("file", effectivePath)
                }
                if !resolvedVariables.isEmpty {
                    Text("Resolved variables")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(resolvedVariables) { variable in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(variable.name)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 120, alignment: .leading)
                                Text(variable.value)
                                    .font(.system(.callout, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(8)
                    .background(Color.secondary.opacity(0.06))
                    .cornerRadius(4)
                }
                Divider()
            }
        }
    }

    @ViewBuilder
    private var authoredSystemPromptSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(String(localized: "quickAction.preview.tab.userSystemPrompt",
                        defaultValue: "System instructions",
                        table: "TermLoop"))
                .font(.headline)
            Text(String(localized: "quickAction.preview.tab.userSystemPromptSource",
                        defaultValue: "Resolved direct system instructions before transport delivery.",
                        table: "TermLoop"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(systemStatus.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
            monoBlock(
                plan?.resolvedUserSystemPrompt,
                empty: String(localized: "quickAction.preview.tab.noDirectSystemPrompt",
                              defaultValue: "(empty — no system instructions document or advanced system instructions set)",
                              table: "TermLoop")
            )
            Divider()
        }
    }

    @ViewBuilder
    private var deliveredSystemInstructionsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(String(localized: "quickAction.preview.tab.deliveredSystemInstructions",
                            defaultValue: "Delivered system instructions",
                            table: "TermLoop"))
                    .font(.headline)
                Text(deliveryFlagLabel)
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.blue.opacity(0.15))
                    .foregroundStyle(Color.blue)
                    .cornerRadius(3)
            }
            Text(String(localized: "quickAction.preview.tab.deliveredSystemInstructionsSource",
                        defaultValue: "Exact transport-visible system text after AgentSystemPromptInjector. If this block is empty, nothing hidden will be sent.",
                        table: "TermLoop"))
                .font(.caption)
                .foregroundStyle(.secondary)
            monoBlock(
                transport?.deliveredSystemInstructions,
                empty: String(localized: "quickAction.preview.tab.noDeliveredSystemInstructions",
                              defaultValue: "(empty — no per-invocation system instructions will be delivered)",
                              table: "TermLoop")
            )
            Divider()
        }
    }

    @ViewBuilder
    private var abilitiesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(String(localized: "quickAction.preview.tab.abilities",
                            defaultValue: "Project abilities context",
                            table: "TermLoop"))
                    .font(.headline)
                Text("preview-only")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.accentColor.opacity(0.18))
                    .foregroundStyle(Color.accentColor)
                    .cornerRadius(3)
            }
            Text(String(localized: "quickAction.preview.tab.abilitiesSource",
                        defaultValue: "Current project ability block. Fresh Quick Action launches do not deliver this block unless a later launch path explicitly composes it.",
                        table: "TermLoop"))
                .font(.caption)
                .foregroundStyle(.secondary)
            if preview.effectiveInjected.isEmpty && preview.effectiveListed.isEmpty {
                Text(String(localized: "quickAction.preview.tab.noAbilities",
                            defaultValue: "No project abilities are active for this preview.",
                            table: "TermLoop"))
                    .foregroundStyle(.secondary)
            } else {
                if !preview.effectiveInjected.isEmpty {
                    Text(String(localized: "quickAction.preview.tab.activeAbilities",
                                defaultValue: "Active (full content)",
                                table: "TermLoop"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(preview.effectiveInjected, id: \.id) { a in
                        abilityBlock(a, fullBody: true)
                    }
                }
                if !preview.effectiveListed.isEmpty {
                    Text(String(localized: "quickAction.preview.tab.listedAbilities",
                                defaultValue: "Available on-demand",
                                table: "TermLoop"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(preview.effectiveListed, id: \.id) { a in
                        abilityBlock(a, fullBody: false)
                    }
                }
            }
            Divider()
        }
    }

    @ViewBuilder
    private var runContextSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Run Context").font(.headline)
            HStack(spacing: 16) {
                field("cwd", cwd ?? "—")
                field("branch", branch ?? "—")
                field("worktree", preview.isWorktree ? "yes" : "no")
                field("model", plan?.resolvedModel.rawValue ?? "—")
                field("reasoning", plan?.resolvedReasoning?.rawValue ?? "—")
            }
            Divider()
        }
    }

    @ViewBuilder
    private var promptSection: some View {
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
            monoBlock(
                promptBodyForDisplay,
                empty: "(empty — no prompt text, prompt document, or template default prompt)"
            )
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

    private var deliveryFlagLabel: String {
        switch transport?.deliveryMode ?? .none {
        case .appendSystemPromptFlag: return "--append-system-prompt"
        case .instructionsFile: return "-c model_instructions_file"
        case .promptPrefix: return "prompt prefix"
        case .none: return "none"
        }
    }

    @ViewBuilder
    private func abilityBlock(_ a: Ability, fullBody: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(a.name).font(.system(.body, weight: .semibold))
            Text(a.description).font(.caption).foregroundStyle(.secondary)
            if fullBody {
                Text(a.body)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(8)
        .background(Color.secondary.opacity(0.06))
        .cornerRadius(4)
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

    private func field(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
        }
    }

    private func originBadge(label: String) -> some View {
        Text(label)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Color.purple.opacity(0.16))
            .foregroundStyle(Color.purple)
            .cornerRadius(3)
    }
}

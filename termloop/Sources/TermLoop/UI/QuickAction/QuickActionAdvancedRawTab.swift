// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct QuickActionAdvancedRawTab: View {
    @ObservedObject var preview: QuickActionPreviewViewModel
    let fullCommand: String
    let promptStatus: QuickActionInputStatus
    let systemStatus: QuickActionInputStatus
    let selectedTemplate: AgentTemplate?
    let templateOriginLabel: String
    let promptSourceLabel: String
    let templateSourcePath: String?
    let resolvedVariables: [QuickActionResolvedVariable]
    let plan: AgentInvocationPlan?
    let transport: AgentInvocationTransportAdapter.Resolution?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                copyRow
                templateInfoBlock
                promptBlock
                authoredSystemPromptBlock
                deliveredSystemInstructionsBlock
                abilityContextBlock
                commandBlock
            }
            .padding(12)
        }
    }

    private var copyRow: some View {
        HStack {
            Button(String(localized: "quickAction.raw.copyPrompt",
                          defaultValue: "Copy resolved prompt",
                          table: "TermLoop")) {
                copy(plan?.resolvedPromptBody ?? "")
            }
            .keyboardShortcut("c", modifiers: .command)
            Button(String(localized: "quickAction.raw.copyDirect",
                          defaultValue: "Copy authored system prompt",
                          table: "TermLoop")) {
                copy(plan?.resolvedUserSystemPrompt ?? "")
            }
            Button(String(localized: "quickAction.raw.copyCommand",
                          defaultValue: "Copy full command",
                          table: "TermLoop")) {
                copy(fullCommand)
            }
            .keyboardShortcut("c", modifiers: [.command, .shift])
            Spacer()
        }
    }

    @ViewBuilder
    private var templateInfoBlock: some View {
        let effectiveTemplate = plan?.template ?? selectedTemplate
        if let effectiveTemplate {
            let effectivePath = plan?.template?.sourceURL.path ?? templateSourcePath
            let mismatch: String = {
                guard let selectedTemplate,
                      let planTemplate = plan?.template,
                      selectedTemplate.id != planTemplate.id else { return "selection_matches_plan: yes" }
                return "selection_matches_plan: no"
            }()
            let originLabel = effectiveTemplate.source == .builtin ? "builtin" : templateOriginLabel
            VStack(alignment: .leading, spacing: 4) {
                sectionHeader(title: "Template", flag: effectiveTemplate.id)
                monoBlock("""
name: \(effectiveTemplate.name)
prompt_source: \(promptSourceLabel)
source: \(originLabel)
scope: \(effectiveTemplate.scope.rawValue)
file: \(effectivePath ?? "—")
\(mismatch)
\(resolvedVariablesBlock)
""", empty: "—")
            }
        }
    }

    @ViewBuilder
    private var promptBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionHeader(
                title: "Resolved prompt",
                flag: promptStatus.shortLabel
            )
            Text(promptStatus.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
            monoBlock(
                plan?.resolvedPromptBody,
                empty: "(empty — no prompt text, prompt document, or template prompt body)"
            )
        }
    }

    @ViewBuilder
    private var authoredSystemPromptBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionHeader(
                title: "Authored system prompt",
                flag: systemStatus.shortLabel
            )
            Text(systemStatus.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
            monoBlock(
                plan?.resolvedUserSystemPrompt,
                empty: String(localized: "quickAction.raw.directEmpty",
                              defaultValue: "(empty — no system prompt document or advanced system prompt)",
                              table: "TermLoop")
            )
        }
    }

    @ViewBuilder
    private var deliveredSystemInstructionsBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionHeader(
                title: "Delivered system instructions",
                flag: deliveryFlagLabel
            )
            monoBlock(
                transport?.deliveredSystemInstructions,
                empty: String(localized: "quickAction.raw.empty",
                              defaultValue: "(empty — no per-invocation system instructions will be delivered)",
                              table: "TermLoop")
            )
        }
    }

    @ViewBuilder
    private var abilityContextBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionHeader(
                title: "Project ability block",
                flag: "preview-only"
            )
            monoBlock(
                preview.renderedSystemPrompt,
                empty: String(localized: "quickAction.raw.abilitiesEmpty",
                              defaultValue: "(no preview-only ability block)",
                              table: "TermLoop")
            )
        }
    }

    @ViewBuilder
    private var commandBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Full command")
                .font(.headline)
            Text(fullCommand)
                .font(.system(.callout, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .padding(8)
                .background(Color.secondary.opacity(0.06))
                .cornerRadius(4)
        }
    }

    private var deliveryFlagLabel: String {
        switch transport?.deliveryMode ?? .none {
        case .appendSystemPromptFlag: return "--append-system-prompt"
        case .instructionsFile: return "-c model_instructions_file"
        case .promptPrefix: return "prompt prefix"
        case .none: return "none"
        }
    }

    private var resolvedVariablesBlock: String {
        guard !resolvedVariables.isEmpty else { return "resolved_variables: —" }
        let lines = resolvedVariables.map { "\($0.name): \($0.value)" }
        return "resolved_variables:\n" + lines.joined(separator: "\n")
    }

    private func sectionHeader(title: String, flag: String) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.headline)
            Text(flag)
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(Color.accentColor.opacity(0.18))
                .foregroundStyle(Color.accentColor)
                .cornerRadius(3)
        }
    }

    @ViewBuilder
    private func monoBlock(_ value: String?, empty: String) -> some View {
        Text(value?.isEmpty == false
             ? value!
             : empty)
            .font(.system(.callout, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .padding(8)
            .background(Color.secondary.opacity(0.06))
            .cornerRadius(4)
    }

    private func copy(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }
}

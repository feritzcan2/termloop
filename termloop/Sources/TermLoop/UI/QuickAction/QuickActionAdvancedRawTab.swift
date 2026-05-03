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
                commandBlock
            }
            .padding(12)
        }
    }

    private var copyRow: some View {
        HStack {
            Button(String(localized: "quickAction.raw.copyPrompt",
                          defaultValue: "Copy first message",
                          table: "TermLoop")) {
                copy(plan?.resolvedPromptBody ?? "")
            }
            .keyboardShortcut("c", modifiers: .command)
            Button(String(localized: "quickAction.raw.copyDirect",
                          defaultValue: "Copy system instructions",
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
            VStack(alignment: .leading, spacing: 4) {
                sectionHeader(title: "Template", flag: "")
                if let selectedTemplate,
                   let planTemplate = plan?.template,
                   selectedTemplate.id != planTemplate.id {
                    Text("Selection and composed plan disagree.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                monoBlock(effectiveTemplate.name, empty: "—")
            }
        }
    }

    @ViewBuilder
    private var promptBlock: some View {
        if plan?.resolvedPromptBody?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            VStack(alignment: .leading, spacing: 4) {
                sectionHeader(
                    title: "First message",
                    flag: promptStatus.shortLabel
                )
                Text(promptStatus.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                monoBlock(plan?.resolvedPromptBody, empty: "")
            }
        }
    }

    @ViewBuilder
    private var authoredSystemPromptBlock: some View {
        if plan?.resolvedUserSystemPrompt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            VStack(alignment: .leading, spacing: 4) {
                sectionHeader(
                    title: "System instructions",
                    flag: systemStatus.shortLabel
                )
                Text(systemStatus.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                monoBlock(plan?.resolvedUserSystemPrompt, empty: "")
            }
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

    private func sectionHeader(title: String, flag: String) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.headline)
            if !flag.isEmpty {
                Text(flag)
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.accentColor.opacity(0.18))
                    .foregroundStyle(Color.accentColor)
                    .cornerRadius(3)
            }
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

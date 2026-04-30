// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct AgentPromptDocument: Identifiable, Equatable, Hashable {
    enum Kind: String, Codable, CaseIterable {
        case systemPromptTemplate = "system-prompt-template"
        case bridgeSourcePrompt = "bridge-source-prompt"
        case bridgeTargetPrompt = "bridge-target-prompt"
        case forkHandoffPrompt = "fork-handoff-prompt"
        case abilityCreatorPrompt = "ability-creator-prompt"
        case abilityRefinerPrompt = "ability-refiner-prompt"
        case systemAbilityDefaultTemplate = "system-ability-default-template"
        case systemAbilityCreatorPrompt = "system-ability-creator-prompt"

        var folderName: String {
            switch self {
            case .systemPromptTemplate: return "system"
            case .bridgeSourcePrompt, .bridgeTargetPrompt: return "bridge"
            case .forkHandoffPrompt: return "fork"
            case .abilityCreatorPrompt, .abilityRefinerPrompt: return "abilities"
            case .systemAbilityDefaultTemplate, .systemAbilityCreatorPrompt: return "system-abilities"
            }
        }
    }

    enum Scope: String, Codable {
        case builtin
        case project
    }

    struct Metadata: Equatable, Hashable {
        let label: String
        let value: String
    }

    let id: String
    let title: String
    let kind: Kind
    let subtitle: String
    let body: String
    let scope: Scope
    let sourceURL: URL?
    let metadata: [Metadata]
}

extension AgentPromptDocument.Kind {
    var displayLabel: String {
        switch self {
        case .systemPromptTemplate: return "system"
        case .bridgeSourcePrompt: return "bridge source"
        case .bridgeTargetPrompt: return "bridge target"
        case .forkHandoffPrompt: return "fork"
        case .abilityCreatorPrompt: return "ability creator"
        case .abilityRefinerPrompt: return "ability refiner"
        case .systemAbilityDefaultTemplate: return "system ability"
        case .systemAbilityCreatorPrompt: return "system ability creator"
        }
    }

    var usageLabel: String {
        switch self {
        case .systemPromptTemplate:
            return "Reusable system prompt"
        case .bridgeSourcePrompt:
            return "Bridge handoff prompt"
        case .bridgeTargetPrompt:
            return "Bridge target system prompt"
        case .forkHandoffPrompt:
            return "Fork handoff prompt"
        case .abilityCreatorPrompt:
            return "Meta-prompt for ability creation"
        case .abilityRefinerPrompt:
            return "Meta-prompt for ability refinement"
        case .systemAbilityDefaultTemplate:
            return "Default system-ability body"
        case .systemAbilityCreatorPrompt:
            return "Meta-prompt for system-ability creation"
        }
    }

    var isInternalFacing: Bool {
        switch self {
        case .systemPromptTemplate:
            return false
        case .bridgeSourcePrompt,
             .bridgeTargetPrompt,
             .forkHandoffPrompt,
             .abilityCreatorPrompt,
             .abilityRefinerPrompt,
             .systemAbilityDefaultTemplate,
             .systemAbilityCreatorPrompt:
            return true
        }
    }

    var canBackSystemPrompt: Bool {
        switch self {
        case .systemPromptTemplate, .bridgeTargetPrompt:
            return true
        case .bridgeSourcePrompt,
             .forkHandoffPrompt,
             .abilityCreatorPrompt,
             .abilityRefinerPrompt,
             .systemAbilityDefaultTemplate,
             .systemAbilityCreatorPrompt:
            return false
        }
    }

    var canBackPromptBody: Bool {
        switch self {
        case .systemPromptTemplate, .bridgeTargetPrompt:
            return false
        case .bridgeSourcePrompt,
             .forkHandoffPrompt,
             .abilityCreatorPrompt,
             .abilityRefinerPrompt,
             .systemAbilityDefaultTemplate,
             .systemAbilityCreatorPrompt:
            return true
        }
    }
}

extension AgentPromptDocument.Scope {
    var displayLabel: String {
        switch self {
        case .builtin: return "builtin"
        case .project: return "project"
        }
    }
}

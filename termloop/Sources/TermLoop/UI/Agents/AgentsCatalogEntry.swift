// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct AgentsCatalogEntry: Identifiable, Hashable {
    enum Section: String, CaseIterable, Identifiable {
        case templates
        case systemPrompts
        case bridge
        case fork
        case abilities
        case systemAbilities
        case runtimeFragments

        var id: String { rawValue }

        var title: String {
            switch self {
            case .templates: return "Templates"
            case .systemPrompts: return "System Instructions"
            case .bridge: return "Bridge Prompts"
            case .fork: return "Fork Prompts"
            case .abilities: return "Project Rules"
            case .systemAbilities: return "System Rules"
            case .runtimeFragments: return "Runtime"
            }
        }

        var shortTitle: String {
            switch self {
            case .templates: return "Templates"
            case .systemPrompts: return "System"
            case .bridge: return "Bridge"
            case .fork: return "Fork"
            case .abilities: return "Rules"
            case .systemAbilities: return "System"
            case .runtimeFragments: return "Runtime"
            }
        }
    }

    struct Metadata: Hashable {
        let label: String
        let value: String
    }

    enum Scope: String, Hashable {
        case builtin
        case user
        case project
        case runtime
        case placeholder

        var label: String {
            switch self {
            case .builtin: return "BUILT-IN"
            case .user: return "USER"
            case .project: return "PROJECT"
            case .runtime: return "RUNTIME"
            case .placeholder: return "EMPTY"
            }
        }
    }

    let id: String
    let section: Section
    let title: String
    let subtitle: String
    let body: String
    let kindLabel: String
    let scope: Scope
    let metadata: [Metadata]
    let isEditableHint: Bool
    let promptDocument: AgentPromptDocument?
    let template: AgentTemplate?

    var searchBlob: String {
        ([title, subtitle, body, kindLabel] + metadata.map { "\($0.label) \($0.value)" })
            .joined(separator: "\n")
    }

    static func == (lhs: AgentsCatalogEntry, rhs: AgentsCatalogEntry) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

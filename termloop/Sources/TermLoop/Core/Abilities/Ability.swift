// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Project-scoped AI ability. Stored as a bundle under
/// `<projectRoot>/.termloop/abilities/<slug>/` with an `ability.json`
/// manifest plus editable `payload/*.md` sections.
struct Ability: Identifiable, Hashable {
    /// Slug derived from the bundle directory. Acts as the stable id.
    let id: String
    var name: String
    var description: String
    var activation: AbilityActivation
    /// Optional domain-expert prompt shipped by the starter; lives in the bundle
    /// as `prompt-customizer.md`. Used when the user runs "Customize with agent"
    /// — the launched Claude session is briefed by this prompt instead of the
    /// generic ability creator. Falls back to the generic creator when nil.
    var customizerPromptBody: String? = nil
    /// Ordered, editable payload sections sent to agents when the ability is
    /// active. Files live under `payload/*.md`; `ability.json` still owns tool
    /// availability and other non-prompt config.
    var payloadBlocks: [AbilityPayloadBlock] = []
    var tags: [String] = []
    var items: [AbilityItem] = []
    /// TermLoop built-in MCP tool bindings this ability ships. Each binding
    /// names a tool from `TermLoopMCPServer`'s registry plus a per-project
    /// `enabled` flag the user can flip in the detail page. Implementations +
    /// schemas live centrally; the bundle only decides which to surface.
    var mcpTools: [AbilityMCPToolBinding] = []
    var enabledMCPToolNames: [String] {
        mcpTools.filter { $0.enabled }.map { $0.name }
    }
    let metadataFilePath: URL

    var requiredMCPs: [AbilityMCPRequirement] {
        items.compactMap { item in
            guard case .requiredMCP(let requirement) = item else { return nil }
            return requirement
        }
    }

    var requiredCLIs: [AbilityCLIRequirement] {
        items.compactMap { item in
            guard case .requiredCLI(let requirement) = item else { return nil }
            return requirement
        }
    }

    var requiredSkillIDs: [String] {
        items.compactMap { item in
            guard case .requiredSkill(let id) = item else { return nil }
            return id
        }
    }

    var itemSummaryFragments: [String] {
        var fragments: [String] = []
        if !requiredMCPs.isEmpty {
            fragments.append(fragment(count: requiredMCPs.count, singular: "required MCP"))
        }
        if !requiredCLIs.isEmpty {
            fragments.append(fragment(count: requiredCLIs.count, singular: "required CLI"))
        }
        if !requiredSkillIDs.isEmpty {
            fragments.append(fragment(count: requiredSkillIDs.count, singular: "required skill"))
        }
        return fragments
    }

    var catalogSections: [AbilityCatalogSection] {
        let values = requiredMCPs.map { "MCP: \($0.title)" }
            + requiredCLIs.map { "CLI: \($0.title)" }
            + requiredSkillIDs.map { "Skill: \(humanizeIdentifier($0))" }
        return values.isEmpty ? [] : [.init(title: "Requirements", values: values)]
    }

    private func fragment(count: Int, singular: String) -> String {
        count == 1 ? "1 \(singular)" : "\(count) \(singular)s"
    }

    private func humanizeIdentifier(_ value: String) -> String {
        value
            .replacingOccurrences(of: ".", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { token in
                let lower = token.lowercased()
                if ["git", "jira", "mcp", "cmux"].contains(lower) {
                    return lower.uppercased()
                }
                if lower == "pr" {
                    return "PR"
                }
                return lower.prefix(1).uppercased() + lower.dropFirst()
            }
            .joined(separator: " ")
    }
}

struct AbilityCatalogSection: Hashable {
    var title: String
    var values: [String]
}

struct AbilityPayloadBlock: Identifiable, Hashable {
    let id: String
    var title: String
    var description: String
    var enabled: Bool
    var body: String
    var fileURL: URL
    /// Optional internal link to a TermLoop MCP tool. The UI still presents
    /// this as a normal payload block; the link lets per-run disables and
    /// skill-file footers follow the right tool.
    var mcpToolName: String? = nil
    var includeInSkillFooter: Bool = false

    var trimmedBody: String {
        body.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum AbilityAgentFamily: String, Codable, CaseIterable, Hashable {
    case claude
    case codex
    case gemini

    var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex CLI"
        case .gemini: return "Gemini"
        }
    }

    /// Short label used in MCP per-agent breakdowns to point the user at
    /// the actual config file the agent reads. Stays in sync with what
    /// `MCPDiscovery` parses.
    var configFileLabel: String {
        switch self {
        case .claude: return "~/.claude.json"
        case .codex: return "~/.codex/config.toml"
        case .gemini: return "~/.gemini/settings.json"
        }
    }
}

struct AbilityMCPRequirement: Hashable, Codable {
    var id: String
    var title: String
    var requiredFor: [AbilityAgentFamily]
    var installHint: String?
    /// Other server names that satisfy this requirement (e.g. an
    /// `atlassian` requirement satisfied by a registered `jira-mcp`
    /// or `mcp-atlassian` entry). Discovery looks the canonical id up
    /// first, then walks aliases — so renames and ecosystem variations
    /// don't trigger false "missing" badges.
    var aliases: [String]?

    /// All server names this requirement accepts, canonical id first.
    var matchableIds: [String] {
        [id] + (aliases ?? [])
    }
}

struct AbilityCLIRequirement: Hashable, Codable {
    var command: String
    var title: String
    var required: Bool
    var verificationArgs: [String]
    var installHint: String?
}

enum AbilityItem: Hashable, Codable {
    case requiredMCP(AbilityMCPRequirement)
    case requiredCLI(AbilityCLIRequirement)
    case requiredSkill(String)

    private enum CodingKeys: String, CodingKey {
        case type, value, required, title, id, requiredFor, installHint, command, verificationArgs, aliases
    }

    private enum Kind: String, Codable {
        case requiredMCP, requiredCLI, requiredSkill
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Kind.self, forKey: .type) {
        case .requiredMCP:
            self = .requiredMCP(
                AbilityMCPRequirement(
                    id: try c.decode(String.self, forKey: .id),
                    title: try c.decode(String.self, forKey: .title),
                    requiredFor: try c.decode([AbilityAgentFamily].self, forKey: .requiredFor),
                    installHint: try c.decodeIfPresent(String.self, forKey: .installHint),
                    aliases: try c.decodeIfPresent([String].self, forKey: .aliases)
                )
            )
        case .requiredCLI:
            self = .requiredCLI(
                AbilityCLIRequirement(
                    command: try c.decode(String.self, forKey: .command),
                    title: try c.decode(String.self, forKey: .title),
                    required: try c.decodeIfPresent(Bool.self, forKey: .required) ?? true,
                    verificationArgs: try c.decodeIfPresent([String].self, forKey: .verificationArgs) ?? [],
                    installHint: try c.decodeIfPresent(String.self, forKey: .installHint)
                )
            )
        case .requiredSkill:
            self = .requiredSkill(try c.decode(String.self, forKey: .value))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .requiredMCP(let v):
            try c.encode(Kind.requiredMCP, forKey: .type)
            try c.encode(v.id, forKey: .id)
            try c.encode(v.title, forKey: .title)
            try c.encode(v.requiredFor, forKey: .requiredFor)
            try c.encodeIfPresent(v.installHint, forKey: .installHint)
            try c.encodeIfPresent(v.aliases, forKey: .aliases)
        case .requiredCLI(let v):
            try c.encode(Kind.requiredCLI, forKey: .type)
            try c.encode(v.command, forKey: .command)
            try c.encode(v.title, forKey: .title)
            try c.encode(v.required, forKey: .required)
            try c.encode(v.verificationArgs, forKey: .verificationArgs)
            try c.encodeIfPresent(v.installHint, forKey: .installHint)
        case .requiredSkill(let v):
            try c.encode(Kind.requiredSkill, forKey: .type)
            try c.encode(v, forKey: .value)
        }
    }
}

/// When an ability's content is surfaced to the agent.
enum AbilityActivation: String, Codable, CaseIterable, Hashable {
    /// Body injected into every agent run in this project.
    case always
    /// Body injected only when the run's workspace is a worktree.
    case worktree
    /// Name + description listed so the AI can load it on demand.
    case listed
    /// Hidden entirely from the AI.
    case off
}

/// Per-ability binding to one of TermLoop's built-in MCP tools. Bundle ships
/// the recommended set with `enabled: true`; the user can flip individual
/// entries in the ability detail page. JSON is forgiving — a bare string like
/// `"set_run_targets"` decodes as `{ name: "...", enabled: true }`.
struct AbilityMCPToolBinding: Hashable, Codable {
    var name: String
    var enabled: Bool

    init(name: String, enabled: Bool = true) {
        self.name = name
        self.enabled = enabled
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(),
           let name = try? single.decode(String.self) {
            self.name = name
            self.enabled = true
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }

    private enum CodingKeys: String, CodingKey { case name, enabled }
}

/// Disk-shipped starter the user can install into their project from the
/// Abilities panel. Sourced from
/// `Sources/TermLoop/Core/Templates/starters/<slug>/`. TermLoop only reads
/// these — they are not auto-seeded into a project.
struct AbilityStarter: Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let activation: AbilityActivation
    let tags: [String]
    let bundleDirectoryURL: URL
}

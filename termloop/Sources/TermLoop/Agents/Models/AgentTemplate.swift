// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct AgentTemplate: Equatable {
    enum Scope: String, Codable, Equatable {
        case workspace, folder, root
    }
    /// Maps directly to Claude CLI's `--permission-mode` values. Legacy
    /// `auto` / `ask` aliases are kept so older templates still load.
    enum PermissionMode: String, Codable, Equatable {
        case auto                          // alias, maps to bypassPermissions
        case ask                           // alias, maps to default
        case acceptEdits
        case bypassPermissions
        case `default`
        case dontAsk
        case plan
    }
    enum Lifecycle: String, Codable, Equatable { case detached, appBound = "app-bound" }
    enum Logging: String, Codable, Equatable { case file, memory, history }
    enum Model: String, Codable, Equatable { case opus, sonnet, `default` }
    enum Cleanup: String, Codable, Equatable {
        case none
        case removeWorktree = "remove-worktree"
        case promote
    }
    enum Trigger: String, Codable, Equatable {
        case manual
        case onWorkspaceClose = "on_workspace_close"
    }
    enum Source: String, Codable, Equatable { case builtin, user, project }

    let id: String
    let name: String
    let description: String
    let icon: String
    let scope: Scope
    let permissionMode: PermissionMode
    let lifecycle: Lifecycle
    let logging: Logging
    let triggers: [Trigger]
    let defaultAttach: Bool
    let model: Model
    let cleanup: Cleanup
    let variables: [String]
    let timeoutSeconds: Int
    /// Optional reusable prompt document id. When present, composer resolves
    /// this before falling back to `body`.
    let promptDocumentId: String?
    /// Optional reusable system-prompt document id. Unlike `body`, this feeds
    /// the per-session system-instruction channel.
    let systemPromptDocumentId: String?
    /// Legacy inline prompt body. This now represents the user/task prompt,
    /// not the session system prompt.
    let body: String
    let sourceURL: URL
    let source: Source

    enum ParseError: Swift.Error, CustomStringConvertible {
        case missingField(String)
        case invalidValue(field: String, value: String)
        case frontmatterError(String)

        var description: String {
            switch self {
            case .missingField(let f): return "template: missing field '\(f)'"
            case .invalidValue(let f, let v): return "template: invalid value for '\(f)': \(v)"
            case .frontmatterError(let m): return "template: \(m)"
            }
        }
    }

    static func load(from url: URL, source: Source) throws -> AgentTemplate {
        let text = try String(contentsOf: url, encoding: .utf8)
        return try parse(text: text, sourceURL: url, source: source)
    }

    static func parse(text: String, sourceURL: URL, source: Source) throws -> AgentTemplate {
        let parsed: FrontmatterParser.Result
        do { parsed = try FrontmatterParser.parse(text) }
        catch { throw ParseError.frontmatterError(String(describing: error)) }
        let fm = parsed.frontmatter
        guard let id = fm["id"] as? String, !id.isEmpty else {
            throw ParseError.missingField("id")
        }
        guard let name = fm["name"] as? String, !name.isEmpty else {
            throw ParseError.missingField("name")
        }
        let description = (fm["description"] as? String) ?? ""
        let icon = (fm["icon"] as? String) ?? ""
        let scope: Scope = try parseEnum(fm, field: "scope", default: .workspace)
        let permissionMode: PermissionMode = try parseEnum(fm, field: "permissionMode", default: .ask)
        let lifecycle: Lifecycle = try parseEnum(fm, field: "lifecycle", default: .detached)
        let logging: Logging = try parseEnum(fm, field: "logging", default: .file)
        let model: Model = try parseEnum(fm, field: "model", default: .default)
        let cleanup: Cleanup = try parseEnum(fm, field: "cleanup", default: .none)
        let triggers = try parseTriggerList(fm["triggers"])
        let defaultAttach = (fm["defaultAttach"] as? Bool) ?? false
        let variables = (fm["variables"] as? [String]) ?? []
        let timeoutSeconds = (fm["timeoutSeconds"] as? Int) ?? 600
        let promptDocumentId = (fm["promptDocumentId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let systemPromptDocumentId = (fm["systemPromptDocumentId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return AgentTemplate(
            id: id, name: name, description: description, icon: icon,
            scope: scope, permissionMode: permissionMode,
            lifecycle: lifecycle, logging: logging, triggers: triggers,
            defaultAttach: defaultAttach, model: model, cleanup: cleanup,
            variables: variables, timeoutSeconds: timeoutSeconds,
            promptDocumentId: promptDocumentId?.isEmpty == false ? promptDocumentId : nil,
            systemPromptDocumentId: systemPromptDocumentId?.isEmpty == false ? systemPromptDocumentId : nil,
            body: parsed.body, sourceURL: sourceURL, source: source
        )
    }

    private static func parseEnum<E: RawRepresentable>(
        _ fm: [String: Any], field: String, default def: E
    ) throws -> E where E.RawValue == String {
        guard let raw = fm[field] as? String else { return def }
        guard let e = E(rawValue: raw) else {
            throw ParseError.invalidValue(field: field, value: raw)
        }
        return e
    }

    private static func parseTriggerList(_ raw: Any?) throws -> [Trigger] {
        guard let arr = raw as? [String] else { return [.manual] }
        return try arr.map { s in
            guard let t = Trigger(rawValue: s) else {
                throw ParseError.invalidValue(field: "triggers", value: s)
            }
            return t
        }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// TermLoop-owned v2 socket namespace for `agent.*` methods. Dispatched from
/// `TermLoopSocketCommands.handle` when the method has the `agent.` prefix.
@MainActor
enum AgentSocketCommands {
    /// Methods that TCP (mobile) clients are allowed to call.
    static let tcpAllowed: Set<String> = [
        "agent.template.list", "agent.template.get"
    ]

    /// Dispatch an `agent.*` method. Returns `nil` for methods outside the
    /// namespace; the caller should fall through to other dispatchers.
    static func handle(method: String, params: [String: Any]) -> TerminalController.V2CallResult? {
        switch method {
        case "agent.template.list":  return templateList(params)
        case "agent.template.get":   return templateGet(params)
        case "agent.template.reload": return templateReload(params)
        default: return nil
        }
    }

    // MARK: Templates

    static func templateList(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let summaries = AgentTemplateStore.shared.templates.map { t -> [String: Any] in
            [
                "id": t.id, "name": t.name, "description": t.description,
                "icon": t.icon, "scope": t.scope.rawValue,
                "triggers": t.triggers.map(\.rawValue),
                "permissionMode": t.permissionMode.rawValue,
                "defaultAttach": t.defaultAttach,
                "source": t.source.rawValue,
                "sourcePath": t.sourceURL.path
            ]
        }
        return .ok(["templates": summaries])
    }

    static func templateGet(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let id = params["id"] as? String, !id.isEmpty else {
            return .err(code: "invalid_params", message: "missing id", data: nil)
        }
        guard let t = AgentTemplateStore.shared.template(id: id) else {
            return .err(code: "AGENT_TEMPLATE_NOT_FOUND", message: id, data: nil)
        }
        return .ok([
            "id": t.id, "name": t.name, "body": t.body,
            "scope": t.scope.rawValue, "triggers": t.triggers.map(\.rawValue),
            "permissionMode": t.permissionMode.rawValue,
            "lifecycle": t.lifecycle.rawValue, "logging": t.logging.rawValue,
            "defaultAttach": t.defaultAttach, "model": t.model.rawValue,
            "cleanup": t.cleanup.rawValue, "variables": t.variables,
            "timeoutSeconds": t.timeoutSeconds,
            "source": t.source.rawValue, "sourcePath": t.sourceURL.path
        ])
    }

    static func templateReload(_ params: [String: Any]) -> TerminalController.V2CallResult {
        AgentEngine.shared.bootstrap(builtinBundleDir: BuiltinTemplates.bundleDir)
        return .ok(["reloaded": true, "count": AgentTemplateStore.shared.templates.count])
    }
}

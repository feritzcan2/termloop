// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
enum TermLoopDevServerSocketCommands {
    static func handle(
        method: String,
        params: [String: Any],
        isTcpClient: Bool
    ) -> TerminalController.V2CallResult? {
        switch method {
        case "devservers.profiles.list":   return profilesList(params)
        case "devservers.profiles.upsert": return profilesUpsert(params, isTcpClient: isTcpClient)
        case "devservers.profiles.delete": return profilesDelete(params, isTcpClient: isTcpClient)
        case "devservers.profiles.save_and_test": return profilesSaveAndTest(params, isTcpClient: isTcpClient)
        case "devservers.start":           return start(params)
        case "devservers.stop":            return stop(params)
        case "devservers.restart":         return restart(params)
        case "devservers.runs.list":       return runsList(params)
        case "devservers.logs":            return logs(params)
        case "devservers.open_url":        return openURL(params)
        case "devservers.preview.inspect": return previewInspect(params)
        default:                            return nil
        }
    }

    private static func profilesList(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let resolved = resolveProfileStore(params)
        guard case .success(let store) = resolved else {
            if case .failure(let error) = resolved { return error }
            return .err(code: "store_unavailable", message: "Could not load dev server profiles", data: nil)
        }
        if let loadError = store.loadError {
            return .err(code: "store_unavailable", message: loadError.localizedDescription, data: nil)
        }
        return .ok([
            "project_id": store.projectId.uuidString,
            "defaults": defaultsPayload(store.defaults),
            "profiles": store.profiles.map(profilePayload(_:)),
            "profile_file_path": store.profileFileURL().path
        ])
    }

    private static func profilesUpsert(
        _ params: [String: Any],
        isTcpClient: Bool
    ) -> TerminalController.V2CallResult {
        guard !isTcpClient else {
            return .err(code: "forbidden", message: "Profile mutation requires a local Unix socket", data: nil)
        }
        let resolved = resolveProfileStore(params)
        guard case .success(let store) = resolved else {
            if case .failure(let error) = resolved { return error }
            return .err(code: "store_unavailable", message: "Could not load dev server profiles", data: nil)
        }
        if let loadError = store.loadError {
            return .err(code: "store_unavailable", message: loadError.localizedDescription, data: nil)
        }
        guard let rawProfile = params["profile"] as? [String: Any] else {
            return .err(code: "invalid_params", message: "Missing profile", data: nil)
        }
        do {
            let profile = try decodeProfile(rawProfile)
            try store.upsert(profile)
            return .ok(["profile": profilePayload(profile)])
        } catch let error as DevServerProfileError {
            return .err(code: "invalid_params", message: error.localizedDescription, data: nil)
        } catch let error as DevServerProfileStoreError {
            return .err(code: "store_unavailable", message: error.localizedDescription, data: nil)
        } catch {
            return .err(code: "invalid_params", message: error.localizedDescription, data: nil)
        }
    }

    private static func profilesDelete(
        _ params: [String: Any],
        isTcpClient: Bool
    ) -> TerminalController.V2CallResult {
        guard !isTcpClient else {
            return .err(code: "forbidden", message: "Profile mutation requires a local Unix socket", data: nil)
        }
        let resolved = resolveProfileStore(params)
        guard case .success(let store) = resolved else {
            if case .failure(let error) = resolved { return error }
            return .err(code: "store_unavailable", message: "Could not load dev server profiles", data: nil)
        }
        if let loadError = store.loadError {
            return .err(code: "store_unavailable", message: loadError.localizedDescription, data: nil)
        }
        guard let profileId = nonEmptyString(params, "profile_id") else {
            return .err(code: "invalid_params", message: "Missing profile_id", data: nil)
        }
        do {
            for run in DevServerRunStore.shared.snapshots(projectId: store.projectId)
                where run.key.profileId == profileId && run.isActive {
                _ = try? DevServerRunCoordinator.shared.stop(runId: run.runId)
            }
            try store.delete(profileId: profileId)
            return .ok(["profile_id": profileId, "deleted": true])
        } catch {
            return .err(code: "store_unavailable", message: error.localizedDescription, data: nil)
        }
    }

    private static func profilesSaveAndTest(
        _ params: [String: Any],
        isTcpClient: Bool
    ) -> TerminalController.V2CallResult {
        guard !isTcpClient else {
            return .err(code: "forbidden", message: "Profile mutation requires a local Unix socket", data: nil)
        }
        guard let taskId = uuid(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        let resolved = resolveProfileStore(params)
        guard case .success(let store) = resolved else {
            if case .failure(let error) = resolved { return error }
            return .err(code: "store_unavailable", message: "Could not load dev server profiles", data: nil)
        }
        if let loadError = store.loadError {
            return .err(code: "store_unavailable", message: loadError.localizedDescription, data: nil)
        }
        guard let rawProfile = params["profile"] as? [String: Any] else {
            return .err(code: "invalid_params", message: "Missing profile", data: nil)
        }
        do {
            let profile = try decodeProfile(rawProfile)
            try store.upsert(profile)
            let snapshot = try DevServerRunCoordinator.shared.start(
                projectId: store.projectId,
                taskId: taskId,
                profileId: profile.id,
                restart: true,
                openOnURL: (params["open_on_url"] as? Bool) ?? true
            )
            return .ok([
                "profile": profilePayload(profile),
                "run": runPayload(snapshot),
                "test": saveAndTestPayload(snapshot)
            ])
        } catch let error as DevServerProfileError {
            return .err(code: "invalid_params", message: error.localizedDescription, data: nil)
        } catch let error as DevServerProfileStoreError {
            return .err(code: "store_unavailable", message: error.localizedDescription, data: nil)
        } catch let error as DevServerRunError {
            return runErrorToV2(error)
        } catch {
            return .err(code: "invalid_params", message: error.localizedDescription, data: nil)
        }
    }

    private static func start(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let taskId = uuid(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        guard let profileId = nonEmptyString(params, "profile_id") else {
            return .err(code: "invalid_params", message: "Missing profile_id", data: nil)
        }
        do {
            let snapshot = try DevServerRunCoordinator.shared.start(
                projectId: uuid(params, "project_id"),
                taskId: taskId,
                profileId: profileId,
                restart: (params["restart"] as? Bool) == true,
                openOnURL: (params["open_on_url"] as? Bool) == true
            )
            return .ok(["run": runPayload(snapshot)])
        } catch {
            return runErrorToV2(error)
        }
    }

    private static func stop(_ params: [String: Any]) -> TerminalController.V2CallResult {
        do {
            let snapshot: DevServerRunSnapshot
            if let runId = uuid(params, "run_id") {
                snapshot = try DevServerRunCoordinator.shared.stop(runId: runId)
            } else {
                guard uuid(params, "project_id") != nil || ProjectStore.shared.activeProjectId != nil else {
                    return .err(code: "no_project", message: "No active project", data: nil)
                }
                guard let key = keyFromParams(params) else {
                    return .err(
                        code: "invalid_params",
                        message: "Missing run_id or project_id/task_id/profile_id key",
                        data: nil
                    )
                }
                guard let active = DevServerRunStore.shared.activeSnapshot(for: key) else {
                    return .err(code: "run_not_found", message: "No active run for key", data: nil)
                }
                snapshot = try DevServerRunCoordinator.shared.stop(runId: active.runId)
            }
            return .ok(["run": runPayload(snapshot)])
        } catch {
            return runErrorToV2(error)
        }
    }

    private static func restart(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let taskId = uuid(params, "task_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid task_id", data: nil)
        }
        guard let profileId = nonEmptyString(params, "profile_id") else {
            return .err(code: "invalid_params", message: "Missing profile_id", data: nil)
        }
        do {
            let snapshot = try DevServerRunCoordinator.shared.restart(
                projectId: uuid(params, "project_id"),
                taskId: taskId,
                profileId: profileId,
                openOnURL: (params["open_on_url"] as? Bool) == true
            )
            return .ok(["run": runPayload(snapshot)])
        } catch {
            return runErrorToV2(error)
        }
    }

    private static func runsList(_ params: [String: Any]) -> TerminalController.V2CallResult {
        let projectId = uuid(params, "project_id")
        let taskId = uuid(params, "task_id")
        let includeLogs = (params["include_logs"] as? Bool) == true
        let runs = DevServerRunStore.shared.snapshots(projectId: projectId, taskId: taskId).map { snapshot in
            var payload = runPayload(snapshot)
            if includeLogs {
                payload["logs"] = DevServerRunStore.shared.logs(runId: snapshot.runId).map(logPayload(_:))
            }
            return payload
        }
        return .ok(["runs": runs])
    }

    private static func logs(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let runId = uuid(params, "run_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid run_id", data: nil)
        }
        guard DevServerRunStore.shared.snapshot(runId: runId) != nil else {
            return .err(code: "run_not_found", message: "Run not found", data: nil)
        }
        let afterSequence = max(0, params["after_sequence"] as? Int ?? 0)
        let limit = params["limit"] as? Int ?? 200
        return .ok([
            "run_id": runId.uuidString,
            "logs": DevServerRunStore.shared.logs(runId: runId, afterSequence: afterSequence, limit: limit).map(logPayload(_:))
        ])
    }

    private static func openURL(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let runId = uuid(params, "run_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid run_id", data: nil)
        }
        guard let snapshot = DevServerRunStore.shared.snapshot(runId: runId) else {
            return .err(code: "run_not_found", message: "Run not found", data: nil)
        }
        let rawURL = nonEmptyString(params, "url") ?? snapshot.latestURL
        guard let rawURL,
              let normalized = DevServerURLDetector.normalize(rawURL),
              let url = URL(string: normalized) else {
            return .err(code: "invalid_params", message: "Missing or invalid URL", data: nil)
        }
        guard let opener = DevServerRunCoordinator.shared.onOpenURL else {
            return .err(code: "store_unavailable", message: "Browser router unavailable", data: nil)
        }
        let opened = opener(snapshot, url, (params["focus"] as? Bool) == true)
        return .ok(["run_id": runId.uuidString, "url": normalized, "opened": opened])
    }

    private static func previewInspect(_ params: [String: Any]) -> TerminalController.V2CallResult {
        guard let runId = uuid(params, "run_id") else {
            return .err(code: "invalid_params", message: "Missing or invalid run_id", data: nil)
        }
        guard let snapshot = DevServerRunStore.shared.snapshot(runId: runId) else {
            return .err(code: "run_not_found", message: "Run not found", data: nil)
        }
        guard let context = DevServerBrowserInspector.context(for: snapshot) else {
            return .err(
                code: "unsupported",
                message: "No matching TermLoop browser preview is available for this run",
                data: [
                    "run_id": runId.uuidString,
                    "supported_methods": DevServerBrowserInspector.supportedMethods
                ]
            )
        }
        return .ok(["run_id": runId.uuidString, "browser": context])
    }

    private enum ProfileStoreResolution {
        case success(DevServerProfileStore)
        case failure(TerminalController.V2CallResult)
    }

    private static func resolveProfileStore(_ params: [String: Any]) -> ProfileStoreResolution {
        let projectId: UUID
        if let explicit = uuid(params, "project_id") {
            projectId = explicit
        } else if let active = ProjectStore.shared.activeProjectId {
            projectId = active
        } else {
            return .failure(.err(code: "no_project", message: "No active project", data: nil))
        }
        guard let store = DevServerProfileStoreProvider.shared.store(for: projectId) else {
            return .failure(.err(code: "store_unavailable", message: "Could not load dev server profiles", data: nil))
        }
        return .success(store)
    }

    private static func keyFromParams(_ params: [String: Any]) -> DevServerRunKey? {
        let projectId: UUID
        if let explicit = uuid(params, "project_id") {
            projectId = explicit
        } else if let active = ProjectStore.shared.activeProjectId {
            projectId = active
        } else {
            return nil
        }
        guard let taskId = uuid(params, "task_id"),
              let profileId = nonEmptyString(params, "profile_id") else {
            return nil
        }
        return DevServerRunKey(projectId: projectId, taskId: taskId, profileId: profileId)
    }

    private static func decodeProfile(_ raw: [String: Any]) throws -> DevServerProfile {
        guard let id = nonEmptyString(raw, "id") else {
            throw SocketProfileDecodeError("Missing profile.id")
        }
        guard let name = nonEmptyString(raw, "name") else {
            throw SocketProfileDecodeError("Missing profile.name")
        }
        guard let command = nonEmptyString(raw, "command") else {
            throw SocketProfileDecodeError("Missing profile.command")
        }
        let rawKind = nonEmptyString(raw, "kind") ?? RunProfileKind.devServer.rawValue
        guard let kind = RunProfileKind(rawValue: rawKind) else {
            throw SocketProfileDecodeError("Unsupported profile.kind")
        }

        let urlDetection = dict(raw, "url_detection", "urlDetection")
        let presentation = dict(raw, "presentation")
        return try DevServerProfile(
            id: id,
            name: name,
            kind: kind,
            command: command,
            workingDirectory: nonEmptyString(raw, "working_directory", "workingDirectory") ?? ".",
            env: try stringDictionary(raw["env"]),
            setupCommand: nonEmptyString(raw, "setup_command", "setupCommand"),
            cleanupCommand: nonEmptyString(raw, "cleanup_command", "cleanupCommand"),
            setupPolicy: setupPolicy(raw),
            urlDetection: DevServerURLDetection(
                autoDetect: bool(urlDetection, "auto_detect", "autoDetect") ?? true,
                fallbackUrls: stringArray(urlDetection, "fallback_urls", "fallbackUrls"),
                readyRegexes: stringArray(urlDetection, "ready_regexes", "readyRegexes")
            ),
            presentation: DevServerPresentation(
                autoOpenFirstUrl: bool(presentation, "auto_open_first_url", "autoOpenFirstUrl")
            ),
            extensions: try jsonObject(raw["extensions"])
        )
    }

    static func runPayload(_ snapshot: DevServerRunSnapshot) -> [String: Any] {
        DevServerRunStore.payload(snapshot: snapshot)
    }

    private static func logPayload(_ line: DevServerLogLine) -> [String: Any] {
        [
            "run_id": line.runId.uuidString,
            "sequence": line.sequence,
            "stream": line.stream.rawValue,
            "text": line.text,
            "timestamp": line.timestamp.timeIntervalSince1970
        ]
    }

    private static func profilePayload(_ profile: DevServerProfile) -> [String: Any] {
        [
            "id": profile.id,
            "name": profile.name,
            "kind": profile.kind.rawValue,
            "command": profile.command,
            "working_directory": profile.workingDirectory,
            "env": profile.env,
            "setup_command": profile.setupCommand as Any? ?? NSNull(),
            "cleanup_command": profile.cleanupCommand as Any? ?? NSNull(),
            "setup_policy": profile.setupPolicy.rawValue,
            "setup_config_hash": DevServerSetupStateStore.configHash(for: profile),
            "url_detection": [
                "auto_detect": profile.urlDetection.autoDetect,
                "fallback_urls": profile.urlDetection.fallbackUrls,
                "ready_regexes": profile.urlDetection.readyRegexes
            ],
            "presentation": [
                "auto_open_first_url": profile.presentation.autoOpenFirstUrl as Any? ?? NSNull()
            ],
            "extensions": jsonPayload(.object(profile.extensions))
        ]
    }

    private static func defaultsPayload(_ defaults: DevServerDefaults) -> [String: Any] {
        [
            "auto_open_first_url": defaults.autoOpenFirstUrl,
            "log_line_limit": defaults.logLineLimit
        ]
    }

    private static func saveAndTestPayload(_ snapshot: DevServerRunSnapshot) -> [String: Any] {
        let status: String
        if snapshot.latestURL != nil {
            status = "ready"
        } else if snapshot.phase == .failed {
            status = "failed"
        } else if snapshot.phase == .exited {
            status = "exited"
        } else if snapshot.phase == .settingUp {
            status = "setup_running"
        } else if snapshot.phase == .starting {
            status = "starting"
        } else {
            status = "waiting_for_url"
        }
        return [
            "status": status,
            "phase": snapshot.phase.rawValue,
            "url": snapshot.latestURL as Any? ?? NSNull(),
            "error_message": snapshot.errorMessage as Any? ?? NSNull(),
            "run_id": snapshot.runId.uuidString,
            "follow_events": ["devserver.url", "devserver.status", "devserver.log"]
        ]
    }

    private static func runErrorToV2(_ error: Error) -> TerminalController.V2CallResult {
        if let runError = error as? DevServerRunError {
            return .err(code: runError.code, message: runError.localizedDescription, data: nil)
        }
        return .err(code: "internal_error", message: error.localizedDescription, data: nil)
    }

    private static func rawString(_ params: [String: Any], _ key: String) -> String? {
        params[key] as? String
    }

    private static func nonEmptyString(_ params: [String: Any], _ keys: String...) -> String? {
        guard let raw = keys.lazy.compactMap({ rawString(params, $0) }).first?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return nil
        }
        return raw
    }

    private static func uuid(_ params: [String: Any], _ key: String) -> UUID? {
        guard let raw = nonEmptyString(params, key) else { return nil }
        return UUID(uuidString: raw)
    }

    private static func dict(_ params: [String: Any], _ keys: String...) -> [String: Any] {
        keys.lazy.compactMap { params[$0] as? [String: Any] }.first ?? [:]
    }

    private static func bool(_ params: [String: Any], _ keys: String...) -> Bool? {
        keys.lazy.compactMap { params[$0] as? Bool }.first
    }

    private static func stringArray(_ params: [String: Any], _ keys: String...) -> [String] {
        keys.lazy.compactMap { params[$0] as? [String] }.first ?? []
    }

    private static func stringDictionary(_ raw: Any?) throws -> [String: String] {
        guard let raw else { return [:] }
        guard let dictionary = raw as? [String: Any] else {
            throw SocketProfileDecodeError("profile.env must be an object")
        }
        var result: [String: String] = [:]
        for (key, value) in dictionary {
            guard let string = value as? String else {
                throw SocketProfileDecodeError("profile.env values must be strings")
            }
            result[key] = string
        }
        return result
    }

    private static func setupPolicy(_ raw: [String: Any]) -> DevServerSetupPolicy {
        let value = nonEmptyString(raw, "setup_policy", "setupPolicy")
            ?? DevServerSetupPolicy.oncePerWorktreeProfileConfig.rawValue
        return DevServerSetupPolicy(rawValue: value) ?? .oncePerWorktreeProfileConfig
    }

    private static func jsonObject(_ raw: Any?) throws -> [String: JSONValue] {
        guard let raw else { return [:] }
        guard let dictionary = raw as? [String: Any] else {
            throw SocketProfileDecodeError("profile.extensions must be an object")
        }
        guard case .object(let object) = jsonValue(dictionary) else {
            throw SocketProfileDecodeError("profile.extensions must contain JSON-compatible values")
        }
        return object
    }

    private static func jsonValue(_ raw: Any) -> JSONValue? {
        switch raw {
        case is NSNull:
            return .null
        case let value as Bool:
            return .bool(value)
        case let value as String:
            return .string(value)
        case let value as Int:
            return .number(Double(value))
        case let value as Double:
            return .number(value)
        case let value as NSNumber:
            return .number(value.doubleValue)
        case let values as [Any]:
            var array: [JSONValue] = []
            for value in values {
                guard let json = jsonValue(value) else { return nil }
                array.append(json)
            }
            return .array(array)
        case let object as [String: Any]:
            var result: [String: JSONValue] = [:]
            for (key, value) in object {
                guard let json = jsonValue(value) else { return nil }
                result[key] = json
            }
            return .object(result)
        default:
            return nil
        }
    }

    private static func jsonPayload(_ value: JSONValue) -> Any {
        switch value {
        case .string(let string):
            return string
        case .number(let number):
            return number
        case .bool(let bool):
            return bool
        case .object(let object):
            return object.mapValues { jsonPayload($0) }
        case .array(let array):
            return array.map { jsonPayload($0) }
        case .null:
            return NSNull()
        }
    }

    private struct SocketProfileDecodeError: LocalizedError {
        let errorDescription: String?

        init(_ message: String) {
            self.errorDescription = message
        }
    }
}

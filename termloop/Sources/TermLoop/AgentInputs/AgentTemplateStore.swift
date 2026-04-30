// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import CoreServices
import Foundation
import os

/// Truth owner for the template catalog (builtin + user + project precedence,
/// hot-reload via FSEvents, load-error tracking).
@MainActor
final class AgentTemplateStore: ObservableObject {
    struct LoadError: Equatable {
        let path: String
        let message: String
    }

    static let shared = AgentTemplateStore()

    @Published private(set) var templates: [AgentTemplate] = []
    @Published private(set) var loadErrors: [LoadError] = []

    private let logger = Logger(subsystem: "ai.termloop", category: "template-store")
    private var stream: FSEventStreamRef?
    private var latestBuiltin: URL?
    private var latestUser: URL?
    private var latestProject: URL?
    private var reloadWorkItem: DispatchWorkItem?

    func template(id: String) -> AgentTemplate? {
        templates.first { $0.id == id }
    }

    func startWatching(builtinDir: URL?, userDir: URL?, projectDir: URL?) {
        latestBuiltin = builtinDir
        latestUser = userDir
        latestProject = projectDir

        reloadSynchronously(builtinDir: builtinDir, userDir: userDir, projectDir: projectDir)
        stopWatching()

        let paths = [userDir, projectDir].compactMap { $0?.path }
        guard !paths.isEmpty else { return }

        let callback: FSEventStreamCallback = { _, clientInfo, _, _, _, _ in
            guard let info = clientInfo else { return }
            let store = Unmanaged<AgentTemplateStore>.fromOpaque(info).takeUnretainedValue()
            Task { @MainActor in store.scheduleReload() }
        }
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            paths as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.2,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
        ) else { return }
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
        FSEventStreamStart(stream)
        self.stream = stream
    }

    func reloadSynchronously(builtinDir: URL?, userDir: URL?, projectDir: URL?) {
        var merged: [String: AgentTemplate] = [:]
        var errors: [LoadError] = []

        func ingest(_ dir: URL?, source: AgentTemplate.Source) {
            guard let dir, FileManager.default.fileExists(atPath: dir.path) else { return }
            guard let files = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil
            ) else { return }
            for file in files where file.pathExtension == "md" {
                do {
                    let tpl = try AgentTemplate.load(from: file, source: source)
                    merged[tpl.id] = tpl
                } catch {
                    errors.append(LoadError(path: file.path, message: String(describing: error)))
                    logger.error(
                        "template load failed: \(file.lastPathComponent, privacy: .public) — \(String(describing: error), privacy: .public)"
                    )
                }
            }
        }

        ingest(builtinDir, source: .builtin)
        ingest(userDir, source: .user)
        ingest(projectDir, source: .project)

        templates = merged.values.sorted { $0.name < $1.name }
        loadErrors = errors
        latestBuiltin = builtinDir
        latestUser = userDir
        latestProject = projectDir
    }

    func stopWatching() {
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
        stream = nil
        reloadWorkItem?.cancel()
        reloadWorkItem = nil
    }

    private func scheduleReload() {
        reloadWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            Task { @MainActor in
                self.reloadSynchronously(
                    builtinDir: self.latestBuiltin,
                    userDir: self.latestUser,
                    projectDir: self.latestProject
                )
            }
        }
        reloadWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
    }
}

extension AgentTemplateStore {
    static func projectTemplatesDir(projectFolderPath: String?) -> URL? {
        guard let projectFolderPath else { return nil }
        return AgentPaths.projectLocalTemplatesDir(near: URL(fileURLWithPath: projectFolderPath, isDirectory: true))
    }

    func duplicateTemplateToProject(id: String, projectFolderPath: String) throws {
        guard let template = templates.first(where: { $0.id == id && $0.source != .project }) else {
            throw NSError(domain: "AgentTemplateStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "Template not found."])
        }
        try saveProjectTemplate(
            template,
            projectFolderPath: projectFolderPath,
            name: template.name,
            description: template.description,
            model: template.model,
            permissionMode: template.permissionMode,
            lifecycle: template.lifecycle,
            scope: template.scope,
            promptDocumentId: template.promptDocumentId,
            systemPromptDocumentId: template.systemPromptDocumentId,
            body: template.body
        )
    }

    func duplicateBuiltInToProject(id: String, projectFolderPath: String) throws {
        try duplicateTemplateToProject(id: id, projectFolderPath: projectFolderPath)
    }

    @discardableResult
    func createProjectTemplate(projectFolderPath: String, name: String) throws -> AgentTemplate {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = trimmed.isEmpty ? "New Template" : trimmed
        let id = uniqueProjectTemplateID(name: resolvedName)
        let url = try projectTemplateURL(id: id, projectFolderPath: projectFolderPath)
        let body = ""
        let text = serializeTemplate(
            id: id,
            name: resolvedName,
            description: "",
            model: .default,
            permissionMode: .bypassPermissions,
            lifecycle: .detached,
            scope: .workspace,
            promptDocumentId: nil,
            systemPromptDocumentId: nil,
            body: body
        )
        try text.write(to: url, atomically: true, encoding: .utf8)
        reloadSynchronously(builtinDir: latestBuiltin, userDir: latestUser, projectDir: latestProject)
        guard let created = templates.first(where: { $0.id == id }) else {
            throw NSError(domain: "AgentTemplateStore", code: 2, userInfo: [NSLocalizedDescriptionKey: "Created template not found after save."])
        }
        return created
    }

    func saveProjectTemplate(
        _ template: AgentTemplate,
        projectFolderPath: String,
        name: String,
        description: String,
        model: AgentTemplate.Model,
        permissionMode: AgentTemplate.PermissionMode,
        lifecycle: AgentTemplate.Lifecycle,
        scope: AgentTemplate.Scope,
        promptDocumentId: String? = nil,
        systemPromptDocumentId: String? = nil,
        body: String
    ) throws {
        let url = try projectTemplateURL(id: template.id, projectFolderPath: projectFolderPath)
        let text = serializeTemplate(
            id: template.id,
            name: name,
            description: description,
            model: model,
            permissionMode: permissionMode,
            lifecycle: lifecycle,
            scope: scope,
            promptDocumentId: promptDocumentId,
            systemPromptDocumentId: systemPromptDocumentId,
            body: body
        )
        try text.write(to: url, atomically: true, encoding: .utf8)
        reloadSynchronously(builtinDir: latestBuiltin, userDir: latestUser, projectDir: latestProject)
    }

    func deleteProjectTemplate(_ template: AgentTemplate) throws {
        guard template.source == .project else { return }
        try FileManager.default.removeItem(at: template.sourceURL)
        reloadSynchronously(builtinDir: latestBuiltin, userDir: latestUser, projectDir: latestProject)
    }

    private func uniqueProjectTemplateID(name: String) -> String {
        let base = slugify(name)
        var candidate = base
        var idx = 2
        while templates.contains(where: { $0.id == candidate }) {
            candidate = "\(base)-\(idx)"
            idx += 1
        }
        return candidate
    }

    private func projectTemplateURL(id: String, projectFolderPath: String) throws -> URL {
        guard let dir = Self.projectTemplatesDir(projectFolderPath: projectFolderPath) else {
            throw NSError(domain: "AgentTemplateStore", code: 3, userInfo: [NSLocalizedDescriptionKey: "Project templates directory is unavailable."])
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(id).md")
    }

    private func slugify(_ text: String) -> String {
        let lowered = text.lowercased()
        let components = lowered.components(separatedBy: CharacterSet.alphanumerics.inverted)
        return components.filter { !$0.isEmpty }.joined(separator: "-")
    }

    private func serializeTemplate(
        id: String,
        name: String,
        description: String,
        model: AgentTemplate.Model,
        permissionMode: AgentTemplate.PermissionMode,
        lifecycle: AgentTemplate.Lifecycle,
        scope: AgentTemplate.Scope,
        promptDocumentId: String? = nil,
        systemPromptDocumentId: String? = nil,
        body: String
    ) -> String {
        let promptDocumentLine = yamlLine(key: "promptDocumentId", value: promptDocumentId)
        let systemPromptDocumentLine = yamlLine(key: "systemPromptDocumentId", value: systemPromptDocumentId)
        return [
            "---",
            "id: \(id)",
            "name: \"\(escapeYAML(name))\"",
            "description: \"\(escapeYAML(description))\"",
            "scope: \(scope.rawValue)",
            "permissionMode: \(permissionMode.rawValue)",
            "lifecycle: \(lifecycle.rawValue)",
            "logging: file",
            "triggers:",
            "  - manual",
            "defaultAttach: false",
            "model: \(model.rawValue)",
            "cleanup: none",
            "variables: []",
            "timeoutSeconds: 600",
            promptDocumentLine,
            systemPromptDocumentLine,
            "---",
            body.trimmingCharacters(in: .whitespacesAndNewlines),
            ""
        ].joined(separator: "\n")
    }

    private func escapeYAML(_ value: String) -> String {
        value.replacingOccurrences(of: "\"", with: "\\\"")
    }

    private func yamlLine(key: String, value: String?) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return "\(key):" }
        return "\(key): \"\(escapeYAML(trimmed))\""
    }
}

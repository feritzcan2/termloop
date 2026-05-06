// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation
import SwiftUI

/// Errors emitted by `ProjectStore` mutations. Shown to the user via UI
/// surfaces, so the `errorDescription` values are localized.
enum ProjectStoreError: Error, LocalizedError {
    case invalidName
    case duplicateName(String)
    case folderNotFound(String)
    case folderNotDirectory(String)
    case notFound(UUID)
    case cannotDeleteLast

    var errorDescription: String? {
        switch self {
        case .invalidName:
            return String(
                localized: "project.error.invalidName",
                defaultValue: "Project name cannot be empty.", table: "TermLoop"
            )
        case .duplicateName(let name):
            return String(
                localized: "project.error.duplicateName",
                defaultValue: "A project named \"\(name)\" already exists.", table: "TermLoop"
            )
        case .folderNotFound(let path):
            return String(
                localized: "project.error.folderNotFound",
                defaultValue: "Folder not found: \(path)", table: "TermLoop"
            )
        case .folderNotDirectory(let path):
            return String(
                localized: "project.error.folderNotDirectory",
                defaultValue: "Path is not a directory: \(path)", table: "TermLoop"
            )
        case .notFound:
            return String(
                localized: "project.error.notFound",
                defaultValue: "Project not found.", table: "TermLoop"
            )
        case .cannotDeleteLast:
            return String(
                localized: "project.error.cannotDeleteLast",
                defaultValue: "Cannot delete the last remaining project.", table: "TermLoop"
            )
        }
    }
}

/// App-level observable catalog of projects. Projects span windows, so a
/// single shared instance is used across the app. Callers mutate the store
/// with validated inputs; the store broadcasts changes via `@Published` and
/// invokes `onMutation` so the session persistence coordinator can save.
@MainActor
final class ProjectStore: ObservableObject {
    static let shared = ProjectStore()

    @Published private(set) var projects: [Project] = []
    @Published private(set) var activeProjectId: UUID?
    @Published private(set) var openProjectIds: [UUID] = []

    /// Fired after any successful mutation (create/rename/delete/setActive/
    /// open/close/updateFolder). The coordinator wires this up to a session
    /// save so project changes persist between launches.
    var onMutation: (() -> Void)?

    private init() {}

    // MARK: - Bootstrap / Persistence

    /// Rehydrates the catalog from a persisted snapshot. If the snapshot has
    /// no projects (legacy session or fresh install), the catalog stays empty
    /// and the sidebar shows the "+ Add Project" empty state — the user
    /// explicitly creates their first project instead of getting a silent
    /// auto-default. Returns the active project id when one exists.
    @discardableResult
    func bootstrap(from persisted: [SessionProjectSnapshot]?) -> UUID? {
        let decoded = (persisted ?? []).compactMap { $0.project }
        guard !decoded.isEmpty else {
            self.projects = []
            self.activeProjectId = nil
            self.openProjectIds = []
            return nil
        }
        self.projects = decoded
        let firstId = decoded[0].id
        self.activeProjectId = firstId
        self.openProjectIds = [firstId]
        return firstId
    }

    /// Codable mirror of the in-memory catalog for the sidecar snapshot.
    var sessionSnapshot: [SessionProjectSnapshot] {
        projects.map { SessionProjectSnapshot($0) }
    }

    /// Rehydrates the catalog from a sidecar snapshot. When the restored list
    /// is empty the catalog stays empty — the sidebar surfaces an "+ Add
    /// Project" empty state so the user creates their first project
    /// explicitly instead of getting an auto-default.
    func restoreFromSidecar(
        projects restored: [SessionProjectSnapshot],
        activeProjectId: UUID?,
        openProjectIds: [UUID]
    ) {
        let decoded = restored.compactMap { $0.project }
        if decoded.isEmpty {
            self.projects = []
            self.activeProjectId = nil
            self.openProjectIds = []
            return
        }
        self.projects = decoded
        let validIds = Set(decoded.map { $0.id })
        if let activeId = activeProjectId, validIds.contains(activeId) {
            self.activeProjectId = activeId
        } else {
            self.activeProjectId = decoded.first?.id
        }
        let filteredOpen = openProjectIds.filter { validIds.contains($0) }
        if filteredOpen.isEmpty {
            self.openProjectIds = [self.activeProjectId].compactMap { $0 }
        } else {
            self.openProjectIds = filteredOpen
        }
    }

    // MARK: - Lookup

    func project(id: UUID) -> Project? {
        projects.first { $0.id == id }
    }

    /// Best-effort project resolution for an arbitrary cwd / worktree path.
    /// Chooses the longest matching project-root prefix so nested checkouts
    /// resolve deterministically.
    func project(containingPath path: String?) -> Project? {
        let normalized = normalize(path ?? "")
        guard !normalized.isEmpty else { return nil }

        var bestMatch: Project?
        var bestLength = -1

        for project in projects {
            let root = normalize(project.folderPath)
            guard normalized == root || normalized.hasPrefix(root + "/") else { continue }
            if root.count > bestLength {
                bestMatch = project
                bestLength = root.count
            }
        }
        return bestMatch
    }

    /// The id that tags workspaces without an explicit project (legacy
    /// snapshots or new workspaces when no project is active).
    var fallbackProjectId: UUID? {
        activeProjectId ?? projects.first?.id
    }

    // MARK: - Mutations

    @discardableResult
    func create(name: String, folderPath: String) throws -> Project {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { throw ProjectStoreError.invalidName }
        let normalizedPath = normalize(folderPath)
        try validateFolder(normalizedPath)
        if projects.contains(where: { $0.name.caseInsensitiveCompare(trimmedName) == .orderedSame }) {
            throw ProjectStoreError.duplicateName(trimmedName)
        }
        let project = Project(name: trimmedName, folderPath: normalizedPath)
        projects.append(project)
        if !openProjectIds.contains(project.id) {
            openProjectIds.append(project.id)
        }
        activeProjectId = project.id
        onMutation?()
        return project
    }

    func rename(id: UUID, newName: String) throws {
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ProjectStoreError.invalidName }
        guard let index = projects.firstIndex(where: { $0.id == id }) else {
            throw ProjectStoreError.notFound(id)
        }
        if projects.contains(where: { $0.id != id && $0.name.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            throw ProjectStoreError.duplicateName(trimmed)
        }
        projects[index].name = trimmed
        onMutation?()
    }

    func updateFolder(id: UUID, newPath: String) throws {
        let normalizedPath = normalize(newPath)
        try validateFolder(normalizedPath)
        guard let index = projects.firstIndex(where: { $0.id == id }) else {
            throw ProjectStoreError.notFound(id)
        }
        projects[index].folderPath = normalizedPath
        onMutation?()
    }

    /// Sets the default terminal-agent for new workspaces in this project.
    /// Pass `nil` to inherit from the global setting.
    func setDefaultTerminalAgent(_ agentId: String?, project id: UUID) {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        guard projects[index].defaultTerminalAgentId != agentId else { return }
        projects[index].defaultTerminalAgentId = agentId
        onMutation?()
    }

    /// Binds a Claude credential profile id to this project. At launch the
    /// runner resolves the id to a Keychain-stored token and injects it as
    /// `CLAUDE_CODE_OAUTH_TOKEN`. Pass `nil` to fall back to the user's
    /// `~/.claude/` login.
    func setClaudeCredentialProfileId(_ profileId: String?, project id: UUID) {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        guard projects[index].claudeCredentialProfileId != profileId else { return }
        projects[index].claudeCredentialProfileId = profileId
        // Workspace stamps would otherwise pin existing workspaces to their
        // prior profile (resolver precedence: stamp > project default), so
        // a "change default" gesture would silently no-op for them. Already
        // -running `claude` processes still hold the old token; they need
        // a workspace re-launch to pick up the new binding.
        let metadataStore = WorkspaceMetadataStore.shared
        for workspaceId in metadataStore.workspaceIds(inProject: id)
        where metadataStore.resolvedClaudeCredentialProfileId(for: workspaceId) != nil {
            metadataStore.setResolvedClaudeCredentialProfileId(nil, for: workspaceId)
        }
        onMutation?()
    }

    func setWorktreeOpenTarget(_ target: WorktreeOpenTarget?, project id: UUID) {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        guard projects[index].worktreeOpenTarget != target else { return }
        projects[index].worktreeOpenTarget = target
        onMutation?()
    }

    /// Removes a project from the catalog. Callers are responsible for
    /// handling workspaces that referenced the deleted project (either
    /// reassigning them to another project or closing them) before calling
    /// this. The store refuses to delete the last remaining project so
    /// workspaces always have a valid owner.
    func delete(id: UUID) throws {
        guard projects.count > 1 else { throw ProjectStoreError.cannotDeleteLast }
        guard let index = projects.firstIndex(where: { $0.id == id }) else {
            throw ProjectStoreError.notFound(id)
        }
        projects.remove(at: index)
        TaskBoardStoreProvider.shared.remove(projectId: id)
        openProjectIds.removeAll { $0 == id }
        if activeProjectId == id {
            activeProjectId = projects.first?.id
        }
        onMutation?()
    }

    func setActive(id: UUID) throws {
        guard projects.contains(where: { $0.id == id }) else {
            throw ProjectStoreError.notFound(id)
        }
        if activeProjectId == id {
            if !openProjectIds.contains(id) {
                openProjectIds.append(id)
                onMutation?()
            }
            return
        }
        activeProjectId = id
        if !openProjectIds.contains(id) {
            openProjectIds.append(id)
        }
        onMutation?()
    }

    func open(id: UUID) throws {
        guard projects.contains(where: { $0.id == id }) else {
            throw ProjectStoreError.notFound(id)
        }
        if !openProjectIds.contains(id) {
            openProjectIds.append(id)
            onMutation?()
        }
    }

    func close(id: UUID) {
        guard openProjectIds.contains(id) else { return }
        openProjectIds.removeAll { $0 == id }
        if activeProjectId == id {
            activeProjectId = openProjectIds.last ?? projects.first?.id
        }
        onMutation?()
    }

    // MARK: - Helpers

    private func normalize(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let expanded = (trimmed as NSString).expandingTildeInPath
        return (expanded as NSString).standardizingPath
    }

    private func validateFolder(_ path: String) throws {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
        if !exists { throw ProjectStoreError.folderNotFound(path) }
        if !isDirectory.boolValue { throw ProjectStoreError.folderNotDirectory(path) }
    }

    // MARK: - Shared UI helpers

    /// `UserDefaults` / `@AppStorage` key remembering the last directory the
    /// user picked when creating/opening a project. Shared between the
    /// onboarding empty state and the create-project sheet so both surfaces
    /// land in the same starting folder.
    static let lastParentDirectoryDefaultsKey = "termLoop.lastProjectParentDir"

    /// First existing folder among the conventional dev locations, falling
    /// back to `~/Projects` when none exist. Used as the initial directory
    /// for project pickers when no last-parent has been remembered yet.
    static func defaultParentDirectory() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        for name in ["Projects", "Developer", "Documents"] {
            let url = home.appendingPathComponent(name, isDirectory: true)
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
                return url.path
            }
        }
        return home.appendingPathComponent("Projects", isDirectory: true).path
    }

    /// Returns `candidate` if no project has that name (case-insensitive),
    /// otherwise appends ` 2`, ` 3`, … until a free name is found.
    func uniqueProjectName(from candidate: String) -> String {
        var name = candidate
        var suffix = 2
        while projects.contains(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
            name = "\(candidate) \(suffix)"
            suffix += 1
        }
        return name
    }

    /// Presents the standard project-error alert. Used by every surface that
    /// calls `create(_:folderPath:)` so the message phrasing stays consistent.
    static func presentError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = String(
            localized: "project.error.title",
            defaultValue: "Project Error", table: "TermLoop"
        )
        alert.informativeText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        alert.alertStyle = .warning
        alert.runModal()
    }
}

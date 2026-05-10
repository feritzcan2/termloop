// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation
import UniformTypeIdentifiers

@MainActor
final class WorktreeRepairCoordinator {
    static let shared = WorktreeRepairCoordinator()

    private struct SwitchPreflight {
        let isClean: Bool
        let changes: [SidebarGitChangeItem]?
    }

    private struct OpenApplicationChoice {
        let url: URL?
        let bundleIdentifier: String?
        let displayName: String?

        static let systemDefault = OpenApplicationChoice(
            url: nil,
            bundleIdentifier: nil,
            displayName: nil
        )
    }

    private init() {}

    func refreshStatus(
        group: WorktreeAgentsGroup,
        sourceWorkspace: Workspace?,
        onRefresh: @escaping () -> Void
    ) {
        do {
            let project = try resolveProject(
                projectId: sourceWorkspace?.projectId ?? group.projectId,
                fallbackWorkspaceIds: group.workspaces.map(\.id)
            )
            WorktreeRegistry.shared.refresh(
                projectFolder: project.folderPath,
                reason: "panel.contextMenu"
            ) { result in
                onRefresh()
                if case .failure(let error) = result {
                    self.presentError(
                        title: String(
                            localized: "worktreeRepair.refresh.errorTitle",
                            defaultValue: "Worktree refresh failed",
                            table: "TermLoop"
                        ),
                        message: self.displayMessage(for: error)
                    )
                }
            }
        } catch {
            presentError(
                title: String(
                    localized: "worktreeRepair.refresh.errorTitle",
                    defaultValue: "Worktree refresh failed",
                    table: "TermLoop"
                ),
                message: displayMessage(for: error)
            )
        }
    }

    func reveal(path rawPath: String) {
        let path = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }
        let url = URL(fileURLWithPath: path)
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) {
            if isDirectory.boolValue {
                NSWorkspace.shared.open(url)
            } else {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            return
        }

        let parent = url.deletingLastPathComponent()
        if FileManager.default.fileExists(atPath: parent.path) {
            NSWorkspace.shared.open(parent)
        }
    }

    func openFolder(path rawPath: String) {
        let path = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true))
    }

    func copyPath(_ rawPath: String) {
        let path = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
    }

    func openConfiguredTarget(projectId: UUID?, worktreePath rawWorktreePath: String) {
        do {
            let project = try resolveProject(projectId: projectId, fallbackWorkspaceIds: [])
            guard let target = project.worktreeOpenTarget else {
                configureOpenTarget(projectId: project.id, worktreePath: rawWorktreePath)
                return
            }
            guard let targetURL = try resolveOpenTargetURL(
                target,
                worktreePath: rawWorktreePath
            ) else { return }
            open(targetURL: targetURL, target: target)
        } catch {
            presentError(
                title: String(
                    localized: "worktreeOpenTarget.open.errorTitle",
                    defaultValue: "Could not open worktree target",
                    table: "TermLoop"
                ),
                message: displayMessage(for: error)
            )
        }
    }

    func configureOpenTarget(projectId: UUID?, worktreePath rawWorktreePath: String) {
        do {
            let project = try resolveProject(projectId: projectId, fallbackWorkspaceIds: [])
            let worktreeURL = URL(fileURLWithPath: rawWorktreePath)
                .standardizedFileURL
            guard let targetURL = try chooseOpenTargetURL(worktreeURL: worktreeURL) else {
                return
            }
            let relativePath = try relativeOpenTargetPath(
                targetURL: targetURL,
                worktreeURL: worktreeURL
            )
            guard let appChoice = chooseOpenTargetApplication() else { return }
            ProjectStore.shared.setWorktreeOpenTarget(
                WorktreeOpenTarget(
                    relativePath: relativePath,
                    applicationBundleIdentifier: appChoice.bundleIdentifier,
                    applicationURLPath: appChoice.url?.path,
                    applicationDisplayName: appChoice.displayName
                ),
                project: project.id
            )
            openConfiguredTarget(projectId: project.id, worktreePath: rawWorktreePath)
        } catch {
            presentError(
                title: String(
                    localized: "worktreeOpenTarget.configure.errorTitle",
                    defaultValue: "Could not configure open target",
                    table: "TermLoop"
                ),
                message: displayMessage(for: error)
            )
        }
    }

    func clearOpenTarget(projectId: UUID?) {
        do {
            let project = try resolveProject(projectId: projectId, fallbackWorkspaceIds: [])
            ProjectStore.shared.setWorktreeOpenTarget(nil, project: project.id)
        } catch {
            presentError(
                title: String(
                    localized: "worktreeOpenTarget.clear.errorTitle",
                    defaultValue: "Could not clear open target",
                    table: "TermLoop"
                ),
                message: displayMessage(for: error)
            )
        }
    }

    func switchToExpectedBranch(
        group: WorktreeAgentsGroup,
        sourceWorkspace: Workspace?,
        onRefresh: @escaping () -> Void
    ) {
        do {
            let project = try resolveProject(
                projectId: sourceWorkspace?.projectId ?? group.projectId,
                fallbackWorkspaceIds: group.workspaces.map(\.id)
            )
            let expectedBranch = try singleExpectedBranch(for: group)
            let path = try requiredWorktreePath(for: group)
            let runningWorkspaceIds = runningWorkspaceIds(in: group.workspaces)
            guard runningWorkspaceIds.isEmpty else {
                throw WorktreeError.invalidParams(
                    reason: "Stop running agents in this worktree before switching Git branches."
                )
            }

            runBackground {
                Result<SwitchPreflight, Error> {
                    let changes = WorktreeLocalChangesProvider.fetchChangedFiles(directory: path)
                    let isClean: Bool
                    if let changes {
                        isClean = changes.isEmpty
                    } else {
                        isClean = try GitWorktreeService().isClean(worktreePath: path)
                    }
                    return SwitchPreflight(isClean: isClean, changes: changes)
                }
            } completion: { preflightResult in
                switch preflightResult {
                case .failure(let error):
                    self.presentError(
                        title: String(
                            localized: "worktreeRepair.switch.errorTitle",
                            defaultValue: "Worktree switch failed",
                            table: "TermLoop"
                        ),
                        message: self.displayMessage(for: error)
                    )
                case .success(let preflight):
                    guard preflight.isClean else {
                        self.presentSwitchDirtyBlocked(
                            expectedBranch: expectedBranch,
                            path: path,
                            changes: preflight.changes
                        )
                        return
                    }
                    guard self.confirmSwitch(expectedBranch: expectedBranch, path: path) else { return }

                    self.runGitMutation(projectFolder: project.folderPath) {
                        let service = GitWorktreeService()
                        guard try service.isClean(worktreePath: path) else {
                            throw WorktreeError.dirtyWorktree(path: path)
                        }
                        try service.switchBranch(worktreePath: path, branch: expectedBranch)
                        return try service.list(in: project.folderPath)
                    } completion: { result in
                        self.handleRegistryMutationResult(
                            result,
                            projectFolder: project.folderPath,
                            onRefresh: onRefresh,
                            errorTitle: String(
                                localized: "worktreeRepair.switch.errorTitle",
                                defaultValue: "Worktree switch failed",
                                table: "TermLoop"
                            )
                        )
                    }
                }
            }
        } catch {
            presentError(
                title: String(
                    localized: "worktreeRepair.switch.errorTitle",
                    defaultValue: "Worktree switch failed",
                    table: "TermLoop"
                ),
                message: displayMessage(for: error)
            )
        }
    }

    func acceptObservedBranch(
        group: WorktreeAgentsGroup,
        onRefresh: @escaping () -> Void
    ) {
        do {
            guard let observedBranch = group.observedRef?.branchName,
                  !observedBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw WorktreeError.invalidParams(
                    reason: "Git HEAD is detached; TermLoop can only adopt a named branch."
                )
            }
            let path = try requiredWorktreePath(for: group)
            guard confirmAcceptObservedBranch(observedBranch, path: path) else { return }
            let workspaceIds = group.workspaces.map(\.id)

            runBackground {
                (try? GitWorktreeService().headRevision(worktreePath: path))
            } completion: { baselineHead in
                for workspaceId in workspaceIds {
                    WorkspaceMetadataStore.shared.adoptWorktreeBranch(
                        observedBranch,
                        worktreePath: path,
                        baselineHead: baselineHead,
                        forWorkspaceId: workspaceId
                    )
                }
                onRefresh()
            }
        } catch {
            presentError(
                title: String(
                    localized: "worktreeRepair.acceptObserved.errorTitle",
                    defaultValue: "Update expected branch failed",
                    table: "TermLoop"
                ),
                message: displayMessage(for: error)
            )
        }
    }

    func detachGroupFromWorktree(
        group: WorktreeAgentsGroup,
        onRefresh: @escaping () -> Void
    ) {
        do {
            let runningWorkspaceIds = runningWorkspaceIds(in: group.workspaces)
            guard runningWorkspaceIds.isEmpty else {
                throw WorktreeError.invalidParams(
                    reason: "Stop running agents in this worktree before detaching it."
                )
            }
            guard confirmDetach(group: group) else { return }
            for workspace in group.workspaces {
                _ = try WorktreeCoordinator.shared.detach(workspace: workspace, prune: .keep)
            }
            onRefresh()
        } catch {
            presentError(
                title: String(
                    localized: "worktreeRepair.detach.errorTitle",
                    defaultValue: "Detach failed",
                    table: "TermLoop"
                ),
                message: displayMessage(for: error)
            )
        }
    }

    func repairRegistration(
        group: WorktreeAgentsGroup,
        sourceWorkspace: Workspace?,
        onRefresh: @escaping () -> Void
    ) {
        do {
            let path = try requiredWorktreePath(for: group)
            let project = try resolveProject(
                projectId: sourceWorkspace?.projectId ?? group.projectId,
                fallbackWorkspaceIds: group.workspaces.map(\.id)
            )
            guard confirmRepair(path: path) else { return }
            let workspaceIds = group.workspaces.map(\.id)

            runGitMutation(projectFolder: project.folderPath) {
                let service = GitWorktreeService()
                try service.repair(folder: project.folderPath, paths: [path])
                return try service.list(in: project.folderPath)
            } completion: { result in
                switch result {
                case .success(let entries):
                    WorktreeRegistry.shared.record(projectFolder: project.folderPath, entries: entries)
                    if let repaired = entries.first(where: { WorktreeResolver.normalizePath($0.path) == path }) {
                        for workspaceId in workspaceIds {
                            WorkspaceMetadataStore.shared.setWorktreePath(
                                repaired.path,
                                forWorkspaceId: workspaceId
                            )
                        }
                    }
                    onRefresh()
                case .failure(let error):
                    self.presentError(
                        title: String(
                            localized: "worktreeRepair.registration.errorTitle",
                            defaultValue: "Worktree repair failed",
                            table: "TermLoop"
                        ),
                        message: self.displayMessage(for: error)
                    )
                }
            }
        } catch {
            presentError(
                title: String(
                    localized: "worktreeRepair.registration.errorTitle",
                    defaultValue: "Worktree repair failed",
                    table: "TermLoop"
                ),
                message: displayMessage(for: error)
            )
        }
    }

    func pruneStaleRegistrations(
        group: WorktreeAgentsGroup,
        sourceWorkspace: Workspace?,
        onRefresh: @escaping () -> Void
    ) {
        do {
            let project = try resolveProject(
                projectId: sourceWorkspace?.projectId ?? group.projectId,
                fallbackWorkspaceIds: group.workspaces.map(\.id)
            )
            guard confirmPrune(projectName: project.name) else { return }

            runGitMutation(projectFolder: project.folderPath) {
                let service = GitWorktreeService()
                try service.prune(folder: project.folderPath)
                return try service.list(in: project.folderPath)
            } completion: { result in
                self.handleRegistryMutationResult(
                    result,
                    projectFolder: project.folderPath,
                    onRefresh: onRefresh,
                    errorTitle: String(
                        localized: "worktreeRepair.prune.errorTitle",
                        defaultValue: "Worktree prune failed",
                        table: "TermLoop"
                    )
                )
            }
        } catch {
            presentError(
                title: String(
                    localized: "worktreeRepair.prune.errorTitle",
                    defaultValue: "Worktree prune failed",
                    table: "TermLoop"
                ),
                message: displayMessage(for: error)
            )
        }
    }

    private func resolveProject(
        projectId: UUID?,
        fallbackWorkspaceIds: [UUID]
    ) throws -> Project {
        let resolvedProjectId = projectId
            ?? fallbackWorkspaceIds.compactMap { workspaceId in
                let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
                return metadata.projectId ?? AppDelegate.shared?.workspaceFor(tabId: workspaceId)?.projectId
            }.first
        guard let resolvedProjectId,
              let project = ProjectStore.shared.project(id: resolvedProjectId) else {
            throw WorktreeError.notFound(what: "project for worktree repair")
        }
        return project
    }

    private func runningWorkspaceIds(in workspaces: [Workspace]) -> [UUID] {
        workspaces.compactMap { workspace in
            TerminalAgentActivityStore.shared.isRunning(forWorkspace: workspace) ? workspace.id : nil
        }
    }

    private func singleExpectedBranch(for group: WorktreeAgentsGroup) throws -> String {
        guard group.expectedBranches.count == 1,
              let expectedBranch = group.expectedBranches.first?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              !expectedBranch.isEmpty else {
            throw WorktreeError.invalidParams(
                reason: "This worktree group has mixed expected branches."
            )
        }
        return expectedBranch
    }

    private func requiredWorktreePath(for group: WorktreeAgentsGroup) throws -> String {
        guard let path = WorktreeResolver.normalizePath(group.worktreePath) else {
            throw WorktreeError.invalidParams(reason: "worktree path is empty")
        }
        return path
    }

    private func chooseOpenTargetURL(worktreeURL: URL) throws -> URL? {
        let panel = NSOpenPanel()
        panel.title = String(
            localized: "worktreeOpenTarget.targetPanel.title",
            defaultValue: "Choose Worktree Open Target",
            table: "TermLoop"
        )
        panel.message = String(
            localized: "worktreeOpenTarget.targetPanel.message",
            defaultValue: "Choose the file or folder TermLoop should open for every worktree in this project. The path is saved relative to the worktree.",
            table: "TermLoop"
        )
        panel.prompt = String(
            localized: "worktreeOpenTarget.targetPanel.prompt",
            defaultValue: "Choose Target",
            table: "TermLoop"
        )
        panel.directoryURL = worktreeURL
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false

        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        return url.standardizedFileURL
    }

    private func chooseOpenTargetApplication() -> OpenApplicationChoice? {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = String(
            localized: "worktreeOpenTarget.appChoice.title",
            defaultValue: "Which app should open this target?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeOpenTarget.appChoice.body",
            defaultValue: "Use the system default app, or choose a specific app such as Rider, Xcode, VS Code, or Cursor.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "worktreeOpenTarget.appChoice.default",
            defaultValue: "Use Default App",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "worktreeOpenTarget.appChoice.choose",
            defaultValue: "Choose App…",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            return .systemDefault
        case .alertSecondButtonReturn:
            return chooseApplicationBundle()
        default:
            return nil
        }
    }

    private func chooseApplicationBundle() -> OpenApplicationChoice? {
        let panel = NSOpenPanel()
        panel.title = String(
            localized: "worktreeOpenTarget.appPanel.title",
            defaultValue: "Choose Application",
            table: "TermLoop"
        )
        panel.prompt = String(
            localized: "worktreeOpenTarget.appPanel.prompt",
            defaultValue: "Choose App",
            table: "TermLoop"
        )
        panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.applicationBundle]

        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        let bundle = Bundle(url: url)
        let displayName = bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? url.deletingPathExtension().lastPathComponent
        return OpenApplicationChoice(
            url: url.standardizedFileURL,
            bundleIdentifier: bundle?.bundleIdentifier,
            displayName: displayName
        )
    }

    private func relativeOpenTargetPath(
        targetURL: URL,
        worktreeURL: URL
    ) throws -> String {
        let root = worktreeURL.standardizedFileURL.path
        let target = targetURL.standardizedFileURL.path
        if target == root { return "." }
        guard target.hasPrefix(root + "/") else {
            throw WorktreeError.invalidParams(
                reason: "Choose a file or folder inside the worktree."
            )
        }
        let relative = String(target.dropFirst(root.count + 1))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !relative.isEmpty, !relative.hasPrefix("/") else {
            throw WorktreeError.invalidParams(reason: "invalid open target path")
        }
        return relative
    }

    private func resolveOpenTargetURL(
        _ target: WorktreeOpenTarget,
        worktreePath rawWorktreePath: String
    ) throws -> URL? {
        let worktreeURL = URL(fileURLWithPath: rawWorktreePath)
            .standardizedFileURL
        let trimmedRelative = target.relativePath
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let relativePath = trimmedRelative.isEmpty ? "." : trimmedRelative
        let targetURL = relativePath == "."
            ? worktreeURL
            : worktreeURL.appendingPathComponent(relativePath)
        if FileManager.default.fileExists(atPath: targetURL.path) {
            return targetURL
        }

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "worktreeOpenTarget.missing.title",
            defaultValue: "Open target not found",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeOpenTarget.missing.body",
            defaultValue: "TermLoop could not find \(relativePath) in this worktree.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "worktreeOpenTarget.missing.openFolder",
            defaultValue: "Open Folder",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            return worktreeURL
        default:
            return nil
        }
    }

    private func open(targetURL: URL, target: WorktreeOpenTarget) {
        if let bundleId = target.applicationBundleIdentifier,
           let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
            open(targetURL: targetURL, applicationURL: appURL)
            return
        }
        if let appPath = target.applicationURLPath,
           FileManager.default.fileExists(atPath: appPath) {
            open(targetURL: targetURL, applicationURL: URL(fileURLWithPath: appPath))
            return
        }
        NSWorkspace.shared.open(targetURL)
    }

    private func open(targetURL: URL, applicationURL: URL) {
        let configuration = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.open(
            [targetURL],
            withApplicationAt: applicationURL,
            configuration: configuration
        )
    }

    private func runGitMutation(
        projectFolder: String,
        operation: @escaping () throws -> [GitWorktreeService.ListEntry],
        completion: @escaping (Result<[GitWorktreeService.ListEntry], Error>) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result: Result<[GitWorktreeService.ListEntry], Error>
            do {
                result = .success(try operation())
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async {
                completion(result)
            }
        }
    }

    private func runBackground<T>(
        operation: @escaping () -> T,
        completion: @escaping (T) -> Void
    ) {
        DispatchQueue.global(qos: .utility).async {
            let value = operation()
            DispatchQueue.main.async {
                completion(value)
            }
        }
    }

    private func handleRegistryMutationResult(
        _ result: Result<[GitWorktreeService.ListEntry], Error>,
        projectFolder: String,
        onRefresh: () -> Void,
        errorTitle: String
    ) {
        switch result {
        case .success(let entries):
            WorktreeRegistry.shared.record(projectFolder: projectFolder, entries: entries)
            onRefresh()
        case .failure(let error):
            presentError(title: errorTitle, message: displayMessage(for: error))
        }
    }

    private func confirmSwitch(expectedBranch: String, path: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "worktreeRepair.switch.confirmTitle",
            defaultValue: "Switch Git back to expected branch?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeRepair.switch.confirmBody",
            defaultValue: "TermLoop will run git switch \(expectedBranch) in:\n\(path)\n\nIf the worktree has local changes, the switch will be blocked so nothing is lost.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "worktreeRepair.switch.confirmButton",
            defaultValue: "Switch Branch",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func presentSwitchDirtyBlocked(
        expectedBranch: String,
        path: String,
        changes: [SidebarGitChangeItem]?
    ) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "worktreeRepair.switch.dirtyTitle",
            defaultValue: "Worktree has local changes",
            table: "TermLoop"
        )

        let changeLines: [String]
        if let changes, !changes.isEmpty {
            let prefix = changes.prefix(8).map { change in
                "• \(change.status.rawValue) \(change.path)"
            }
            let remaining = changes.count - prefix.count
            changeLines = Array(prefix) + (remaining > 0 ? ["• …and \(remaining) more"] : [])
        } else {
            changeLines = []
        }

        let body = String(
            localized: "worktreeRepair.switch.dirtyBody",
            defaultValue: "TermLoop did not run git switch \(expectedBranch), because switching a dirty checkout can fail or hide uncommitted work. Commit, stash, or clean these changes first, then retry.",
            table: "TermLoop"
        )
        let pathLine = String(
            localized: "worktreeRepair.switch.dirtyPath",
            defaultValue: "Worktree path:\n\(path)",
            table: "TermLoop"
        )
        alert.informativeText = ([body, pathLine] + changeLines)
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
        alert.addButton(withTitle: String(
            localized: "worktreeRepair.switch.revealButton",
            defaultValue: "Reveal Worktree",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        if alert.runModal() == .alertFirstButtonReturn {
            reveal(path: path)
        }
    }

    private func confirmAcceptObservedBranch(_ observedBranch: String, path: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = String(
            localized: "worktreeRepair.acceptObserved.confirmTitle",
            defaultValue: "Use current Git branch as expected?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeRepair.acceptObserved.confirmBody",
            defaultValue: "TermLoop will update this workspace's expected branch to \(observedBranch) for:\n\(path)\n\nRemote item bindings, agent session state, and worktree path metadata are preserved.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "worktreeRepair.acceptObserved.confirmButton",
            defaultValue: "Use Current Branch",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func confirmDetach(group: WorktreeAgentsGroup) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "worktreeRepair.detach.confirmTitle",
            defaultValue: "Detach from worktree?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeRepair.detach.confirmBody",
            defaultValue: "TermLoop will move \(group.workspaces.count) workspace(s) back to the project root and keep the worktree on disk. Git branches and files are not deleted.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "worktreeRepair.detach.confirmButton",
            defaultValue: "Detach",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func confirmRepair(path: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = String(
            localized: "worktreeRepair.registration.confirmTitle",
            defaultValue: "Repair Git worktree registration?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeRepair.registration.confirmBody",
            defaultValue: "TermLoop will run git worktree repair for:\n\(path)\n\nNo TermLoop product state will be deleted.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "worktreeRepair.registration.confirmButton",
            defaultValue: "Repair",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func confirmPrune(projectName: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "worktreeRepair.prune.confirmTitle",
            defaultValue: "Prune stale Git worktree registrations?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeRepair.prune.confirmBody",
            defaultValue: "TermLoop will run git worktree prune for \(projectName). This updates Git's stale registrations only; TermLoop workspace metadata is preserved.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "worktreeRepair.prune.confirmButton",
            defaultValue: "Prune",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func presentError(title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }

    private func displayMessage(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

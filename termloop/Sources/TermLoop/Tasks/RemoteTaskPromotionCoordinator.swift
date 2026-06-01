// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
public enum RemoteTaskPromotionCoordinator {
    public typealias ProgressHandler = @MainActor @Sendable (RemoteTaskPromotionStatus, String) -> Void

    public enum PromotionError: LocalizedError, Sendable {
        case draftNotFound(UUID)
        case projectNotFound(UUID)
        case storeUnavailable(UUID)
        case sourceWorkspaceMissing(UUID)
        case sourceProjectMismatch(expected: UUID, actual: UUID?)
        case sourceSessionMissing(UUID)
        case sourceAgentUnsupported(String)
        case sourceAgentBusy(String)
        case remoteDisabled
        case remoteContainerMissing
        case remoteCLIUnavailable(String)
        case remoteMissingAfterCreate(UUID)
        case taskMissingAfterCreate(UUID)

        public var errorDescription: String? {
            switch self {
            case .draftNotFound(let id):
                return "Remote task promotion draft not found: \(id.uuidString)"
            case .projectNotFound(let id):
                return "Project not found for remote task promotion: \(id.uuidString)"
            case .storeUnavailable(let id):
                return "Task board store unavailable for project: \(id.uuidString)"
            case .sourceWorkspaceMissing(let id):
                return "The source agent workspace is no longer open: \(id.uuidString)"
            case .sourceProjectMismatch(let expected, let actual):
                return "The source workspace no longer belongs to this project. Expected \(expected.uuidString), got \(actual?.uuidString ?? "none")."
            case .sourceSessionMissing(let id):
                return "The source workspace has no resumable agent session: \(id.uuidString)"
            case .sourceAgentUnsupported(let agentId):
                return "The source agent cannot be resumed in a worktree: \(agentId)"
            case .sourceAgentBusy(let agentId):
                return "Wait for the source \(agentId) agent to finish, then retry."
            case .remoteDisabled:
                return "Remote work items are disabled."
            case .remoteContainerMissing:
                return "Remote work item project/repository is not configured."
            case .remoteCLIUnavailable(let message):
                return message
            case .remoteMissingAfterCreate(let taskId):
                return "Created local task has no remote work item reference: \(taskId.uuidString)"
            case .taskMissingAfterCreate(let taskId):
                return "Created local task is missing from the task board: \(taskId.uuidString)"
            }
        }
    }

    @discardableResult
    public static func confirm(
        promotionId: UUID,
        projectId: UUID,
        progress: ProgressHandler? = nil
    ) async throws -> RemoteTaskPromotionDraft {
        guard let project = ProjectStore.shared.project(id: projectId) else {
            throw PromotionError.projectNotFound(projectId)
        }
        guard let store = TaskBoardStoreProvider.shared.store(for: projectId) else {
            throw PromotionError.storeUnavailable(projectId)
        }
        let draftStore = RemoteTaskPromotionDraftStoreProvider.shared.store(
            projectId: projectId,
            projectRoot: URL(fileURLWithPath: project.folderPath, isDirectory: true)
        )
        guard var draft = draftStore.draft(id: promotionId) else {
            throw PromotionError.draftNotFound(promotionId)
        }
        if draft.shouldCreateWorktreeAndAttachAgent {
            _ = try sourceWorkspaceReadyForMigration(
                draft.sourceWorkspaceId,
                expectedProjectId: draft.projectId
            )
        }

        let remoteSync = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: store)
        let settings = remoteSync.settings
        guard settings.isEnabled else { throw PromotionError.remoteDisabled }
        guard let container = settings.container?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !container.isEmpty else {
            throw PromotionError.remoteContainerMissing
        }
        let cliStatus = await remoteSync.refreshCLIStatus(for: settings.provider)
        guard cliStatus.isAvailable else {
            throw PromotionError.remoteCLIUnavailable(
                remoteSync.cliSetupHint(for: settings.provider)
            )
        }

        progress?(.creatingRemote, String(
            localized: "tasks.remotePromotion.progress.creatingRemote",
            defaultValue: "Creating remote task…",
            table: "TermLoop"
        ))
        draft.status = .creatingRemote
        draft.errorMessage = nil
        draft = try draftStore.upsert(draft)

        let taskAndReference: (task: TaskRecord, reference: RemoteWorkItemReference)
        if let existing = existingRemoteTask(for: draft, in: store) {
            taskAndReference = existing
        } else if let reference = draft.remoteWorkItem {
            do {
                let taskId = try await remoteSync.materializeRemoteWorkItemAsync(reference: reference)
                guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
                    throw PromotionError.taskMissingAfterCreate(taskId)
                }
                taskAndReference = (task, reference)
            } catch {
                try? draftStore.update(id: draft.id) {
                    $0.status = .failed
                    $0.remoteWorkItem = reference
                    $0.errorMessage = error.localizedDescription
                }
                progress?(.failed, error.localizedDescription)
                throw error
            }
        } else {
            let taskId: UUID
            do {
                if draft.shouldCreateWorktreeAndAttachAgent {
                    _ = try sourceWorkspaceReadyForMigration(
                        draft.sourceWorkspaceId,
                        expectedProjectId: draft.projectId
                    )
                }
                taskId = try await remoteSync.createRemoteWorkItemAsync(
                    title: draft.title,
                    bodyMarkdown: bodyMarkdown(for: draft),
                    issueType: draft.issueType,
                    assignToMe: draft.assignToMe,
                    onRemoteCreated: { reference in
                        try? draftStore.update(id: draft.id) {
                            $0.remoteWorkItem = reference
                        }
                    }
                )
            } catch {
                try? draftStore.update(id: draft.id) {
                    $0.status = .failed
                    $0.errorMessage = error.localizedDescription
                }
                progress?(.failed, error.localizedDescription)
                throw error
            }

            guard let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }) else {
                let failure = PromotionError.taskMissingAfterCreate(taskId)
                try? draftStore.update(id: draft.id) {
                    $0.status = .failed
                    $0.taskId = taskId
                    $0.errorMessage = failure.localizedDescription
                }
                progress?(.failed, failure.localizedDescription)
                throw failure
            }
            guard let reference = task.remoteWorkItem else {
                let failure = PromotionError.remoteMissingAfterCreate(taskId)
                try? draftStore.update(id: draft.id) {
                    $0.status = .failed
                    $0.taskId = taskId
                    $0.errorMessage = failure.localizedDescription
                }
                progress?(.failed, failure.localizedDescription)
                throw failure
            }
            taskAndReference = (task, reference)
        }

        progress?(.remoteCreated, String(
            localized: "tasks.remotePromotion.progress.remoteCreated",
            defaultValue: "Remote task created.",
            table: "TermLoop"
        ))
        try draftStore.update(id: draft.id) {
            $0.status = .remoteCreated
            $0.taskId = taskAndReference.task.id
            $0.remoteWorkItem = taskAndReference.reference
            $0.errorMessage = nil
        }

        guard draft.shouldCreateWorktreeAndAttachAgent else {
            try draftStore.update(id: draft.id) {
                $0.status = .ready
                $0.taskId = taskAndReference.task.id
                $0.remoteWorkItem = taskAndReference.reference
                $0.targetWorkspaceId = nil
                $0.worktreePath = nil
                $0.errorMessage = nil
            }
            progress?(.ready, String(
                localized: "tasks.remotePromotion.progress.readyTaskOnly",
                defaultValue: "Ready. Remote and local tasks were created.",
                table: "TermLoop"
            ))
            return draftStore.draft(id: draft.id) ?? draft
        }

        do {
            let workspace = try sourceWorkspaceReadyForMigration(
                draft.sourceWorkspaceId,
                expectedProjectId: draft.projectId
            )
            progress?(.bindingWorktree, String(
                localized: "tasks.remotePromotion.progress.bindingWorktree",
                defaultValue: "Creating and binding worktree…",
                table: "TermLoop"
            ))
            try draftStore.update(id: draft.id) {
                $0.status = .bindingWorktree
                $0.errorMessage = nil
            }
            let result = try await bindCallingWorkspaceToWorktree(
                draft: draft,
                task: taskAndReference.task,
                reference: taskAndReference.reference,
                sourceWorkspace: workspace,
                store: store,
                progress: progress
            )
            try draftStore.update(id: draft.id) {
                $0.status = .ready
                $0.taskId = taskAndReference.task.id
                $0.remoteWorkItem = taskAndReference.reference
                $0.targetWorkspaceId = result.workspaceId
                $0.worktreePath = result.worktreePath
                $0.errorMessage = nil
            }
            progress?(.ready, String(
                localized: "tasks.remotePromotion.progress.ready",
                defaultValue: "Ready. The source agent was moved into the worktree.",
                table: "TermLoop"
            ))
        } catch {
            try? draftStore.update(id: draft.id) {
                $0.status = .failed
                $0.errorMessage = error.localizedDescription
            }
            progress?(.failed, error.localizedDescription)
            throw error
        }

        return draftStore.draft(id: draft.id) ?? draft
    }

    private struct PreparedWorktree {
        let branch: String
        let path: String
        let baselineHead: String?
        let createdWorktree: Bool
    }

    private static func existingRemoteTask(
        for draft: RemoteTaskPromotionDraft,
        in store: TaskBoardStore
    ) -> (task: TaskRecord, reference: RemoteWorkItemReference)? {
        guard let taskId = draft.taskId,
              let task = store.fileSnapshot().tasks.first(where: { $0.id == taskId }),
              task.archivedAt == nil,
              let reference = task.remoteWorkItem else {
            return nil
        }
        return (task, reference)
    }

    private static func bindCallingWorkspaceToWorktree(
        draft: RemoteTaskPromotionDraft,
        task: TaskRecord,
        reference: RemoteWorkItemReference,
        sourceWorkspace: Workspace,
        store: TaskBoardStore,
        progress: ProgressHandler?
    ) async throws -> TaskWorktreeProvisionResult {
        let prepared = try prepareWorktree(
            projectRoot: store.projectRoot,
            branch: branchName(for: draft, reference: reference, title: task.title)
        )
        progress?(.launchingAgent, String(
            localized: "tasks.remotePromotion.progress.movingAgent",
            defaultValue: "Moving source agent into the worktree…",
            table: "TermLoop"
        ))
        let attach = try WorktreeCoordinator.shared.migrateWorkspaceToPreparedWorktree(
            workspace: sourceWorkspace,
            branch: prepared.branch,
            path: prepared.path,
            baselineHead: prepared.baselineHead
        )
        let lifecycle = TaskLifecycleCoordinator.makeForProject(store: store)
        try lifecycle.bindExistingWorktree(
            taskId: task.id,
            workspaceId: attach.workspaceId,
            branch: attach.branch,
            worktreePath: attach.path,
            ownsWorktree: prepared.createdWorktree
        )
        WorktreeProjectionStore.shared.refresh(projectFolder: store.projectRoot.path, reason: "tasks.remotePromotion")
        return TaskWorktreeProvisionResult(
            workspaceId: attach.workspaceId,
            branch: attach.branch,
            worktreePath: attach.path,
            createdWorktree: prepared.createdWorktree
        )
    }

    private static func prepareWorktree(projectRoot: URL, branch: String) throws -> PreparedWorktree {
        let projectPath = projectRoot.path
        guard let path = WorktreeResolver.path(projectFolder: projectPath, branch: branch) else {
            throw TaskLifecycleError.provisionFailed("Could not resolve worktree path.")
        }
        let service = GitWorktreeService()
        if let existing = try service.existingUsableWorktree(in: projectPath, branch: branch) {
            return PreparedWorktree(
                branch: branch,
                path: existing.path,
                baselineHead: try? service.headRevision(worktreePath: existing.path),
                createdWorktree: false
            )
        }
        let branchExists = try service.branches(in: projectPath)
            .contains { $0.name == branch }
        if branchExists {
            try service.add(folder: projectPath, path: path, branch: branch)
        } else {
            try service.addCreatingBranch(
                folder: projectPath,
                path: path,
                branch: branch,
                baseRef: "HEAD"
            )
        }
        return PreparedWorktree(
            branch: branch,
            path: path,
            baselineHead: try? service.headRevision(worktreePath: path),
            createdWorktree: true
        )
    }

    private static func sourceWorkspaceReadyForMigration(
        _ workspaceId: UUID,
        expectedProjectId: UUID
    ) throws -> Workspace {
        guard let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
            throw PromotionError.sourceWorkspaceMissing(workspaceId)
        }
        let actualProjectId = WorkspaceMetadataStore.shared.projectId(forWorkspaceId: workspaceId)
            ?? ProjectStore.shared.project(containingPath: workspace.currentDirectory)?.id
        guard actualProjectId == expectedProjectId else {
            throw PromotionError.sourceProjectMismatch(
                expected: expectedProjectId,
                actual: actualProjectId
            )
        }
        guard let reference = WorkspaceSessionReferenceResolver.resolve(for: workspace) else {
            throw PromotionError.sourceSessionMissing(workspaceId)
        }
        guard TerminalAgentRunner.supportsResume(agentId: reference.agentId) else {
            throw PromotionError.sourceAgentUnsupported(reference.agentId)
        }
        guard !TerminalAgentActivityStore.shared.isAgentRunning(
            forWorkspace: workspace,
            agentId: reference.agentId
        ) else {
            throw PromotionError.sourceAgentBusy(reference.agentId)
        }
        return workspace
    }

    static func bodyMarkdown(for draft: RemoteTaskPromotionDraft) -> String {
        draft.descriptionMarkdown.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func suggestedBranchName(title: String) -> String {
        let slug = titleSlug(title)
        return slug.isEmpty ? "task/\(UUID().uuidString.prefix(4))" : "task/\(slug)"
    }

    static func branchName(
        for draft: RemoteTaskPromotionDraft,
        reference: RemoteWorkItemReference,
        title: String
    ) -> String {
        let configured = draft.branchName?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return configured.isEmpty ? branchHint(reference: reference, title: title) : configured
    }

    private static func branchHint(reference: RemoteWorkItemReference, title: String) -> String {
        let key = reference.key.trimmingCharacters(in: .whitespacesAndNewlines)
        let slug = titleSlug(title)
        if key.isEmpty { return slug }
        if slug.isEmpty { return key }
        return "\(key)-\(slug)"
    }

    private static func titleSlug(_ value: String) -> String {
        let scalars = value.lowercased().unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) ? Character(scalar) : "-"
        }
        return String(scalars)
            .split(separator: "-", omittingEmptySubsequences: true)
            .prefix(8)
            .joined(separator: "-")
    }
}

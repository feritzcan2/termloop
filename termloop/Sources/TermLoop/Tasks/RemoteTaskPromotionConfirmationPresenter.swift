// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import Foundation
import SwiftUI

@MainActor
enum RemoteTaskPromotionConfirmationPresenter {
    static func present(
        draft: RemoteTaskPromotionDraft,
        store: RemoteTaskPromotionDraftStore
    ) -> Bool {
        guard let parent = NSApp.keyWindow
            ?? NSApp.mainWindow
            ?? NSApp.windows.first(where: { $0.isVisible }) else {
            try? store.update(id: draft.id) {
                $0.status = .failed
                $0.errorMessage = String(
                    localized: "tasks.remotePromotion.confirm.noWindow",
                    defaultValue: "Could not show the remote task confirmation sheet.",
                    table: "TermLoop"
                )
            }
            return false
        }

        let model = RemoteTaskPromotionSheetModel(draft: draft, store: store)
        let controller = NSHostingController(rootView: RemoteTaskPromotionSheet(model: model))
        let sheet = NSWindow(contentViewController: controller)
        sheet.styleMask = [.titled]
        sheet.title = String(
            localized: "tasks.remotePromotion.confirm.windowTitle",
            defaultValue: "Remote Task",
            table: "TermLoop"
        )
        sheet.isReleasedWhenClosed = false
        sheet.setContentSize(NSSize(width: 620, height: 680))
        model.close = { [weak parent, weak sheet] in
            guard let parent, let sheet else { return }
            parent.endSheet(sheet)
        }
        parent.beginSheet(sheet)
        return true
    }
}

@MainActor
private final class RemoteTaskPromotionSheetModel: ObservableObject {
    private static let customIssueTypeTag = "__termloop_custom_issue_type__"

    @Published var title: String
    @Published var descriptionMarkdown: String
    @Published var issueTypeOptions: [TaskRemoteIssueTypeOption] = []
    @Published var isLoadingIssueTypes = false
    @Published var issueTypeMessage: String?
    @Published var selectedIssueType = ""
    @Published var customIssueType = ""
    @Published var shouldCreateWorktreeAndAttachAgent: Bool
    @Published var status: RemoteTaskPromotionStatus
    @Published var statusText: String
    @Published var isWorking = false
    @Published var errorMessage: String?
    @Published var remoteKey: String?
    @Published var remoteURL: String?

    let providerLabel: String
    let container: String
    let promotionId: UUID
    let projectId: UUID
    let provider: RemoteWorkItemProviderId

    var close: (() -> Void)?

    private let store: RemoteTaskPromotionDraftStore
    private let remoteSync: TaskRemoteSyncCoordinator?
    private var remoteSyncCancellable: AnyCancellable?

    init(draft: RemoteTaskPromotionDraft, store: RemoteTaskPromotionDraftStore) {
        self.title = draft.title
        self.descriptionMarkdown = draft.descriptionMarkdown
        self.customIssueType = draft.issueType ?? ""
        self.shouldCreateWorktreeAndAttachAgent = draft.shouldCreateWorktreeAndAttachAgent
        self.status = draft.status
        self.statusText = Self.text(
            for: draft.status,
            shouldCreateWorktreeAndAttachAgent: draft.shouldCreateWorktreeAndAttachAgent
        )
        self.provider = draft.provider
        self.providerLabel = draft.provider.displayLabel
        self.container = draft.container
        self.promotionId = draft.id
        self.projectId = draft.projectId
        self.errorMessage = draft.errorMessage
        self.remoteKey = draft.remoteWorkItem?.key
        self.remoteURL = draft.remoteWorkItem?.url
        self.store = store
        if let taskStore = TaskBoardStoreProvider.shared.store(for: draft.projectId) {
            let coordinator = TaskRemoteSyncCoordinatorProvider.shared.coordinator(for: taskStore)
            self.remoteSync = coordinator
            self.remoteSyncCancellable = coordinator.objectWillChange.sink { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.refreshIssueTypeState()
                }
            }
            refreshIssueTypeState()
        } else {
            self.remoteSync = nil
        }
        ensureIssueTypeSelection()
    }

    var canCreate: Bool {
        guard !isWorking,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !descriptionMarkdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        guard provider == .jira else { return true }
        return selectedIssueTypeForCreate != nil
    }

    var showsIssueTypePicker: Bool { provider == .jira }

    var selectableIssueTypes: [TaskRemoteIssueTypeOption] {
        let nonSubtaskTypes = issueTypeOptions.filter { !$0.isSubtask }
        return nonSubtaskTypes.isEmpty ? issueTypeOptions : nonSubtaskTypes
    }

    var isCustomIssueTypeSelected: Bool {
        selectedIssueType == Self.customIssueTypeTag || selectableIssueTypes.isEmpty
    }

    var selectedIssueTypeForCreate: String? {
        guard provider == .jira else { return nil }
        if isCustomIssueTypeSelected {
            let value = customIssueType.trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }
        let value = selectedIssueType.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    var customIssueTypeTag: String { Self.customIssueTypeTag }

    func onAppear() {
        guard provider == .jira else { return }
        remoteSync?.loadIssueTypeOptionsIfNeeded()
        refreshIssueTypeState()
    }

    func cancel() {
        guard !isWorking else { return }
        if status == .ready {
            close?()
            return
        }
        try? store.update(id: promotionId) {
            $0.status = .cancelled
        }
        close?()
    }

    func create() {
        guard canCreate else { return }
        isWorking = true
        errorMessage = nil
        status = .awaitingConfirmation
        statusText = Self.text(for: .awaitingConfirmation)

        Task { @MainActor in
            do {
                try store.update(id: promotionId) {
                    $0.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    $0.descriptionMarkdown = descriptionMarkdown.trimmingCharacters(in: .whitespacesAndNewlines)
                    $0.issueType = selectedIssueTypeForCreate
                    $0.shouldCreateWorktreeAndAttachAgent = shouldCreateWorktreeAndAttachAgent
                    $0.errorMessage = nil
                }
                _ = try await RemoteTaskPromotionCoordinator.confirm(
                    promotionId: promotionId,
                    projectId: projectId,
                    progress: { [weak self] status, text in
                        self?.status = status
                        self?.statusText = text
                        self?.syncDraftStateIntoView()
                    }
                )
                syncDraftStateIntoView(updateStatus: true)
                isWorking = false
            } catch {
                syncDraftStateIntoView(updateStatus: true)
                isWorking = false
                status = .failed
                statusText = Self.text(for: .failed)
                errorMessage = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }

    func refreshIssueTypeState() {
        guard let remoteSync else { return }
        issueTypeOptions = remoteSync.issueTypeOptions
        isLoadingIssueTypes = remoteSync.isLoadingIssueTypes
        issueTypeMessage = remoteSync.issueTypeOptionsMessage
        ensureIssueTypeSelection()
    }

    func ensureIssueTypeSelection() {
        guard provider == .jira else { return }
        guard !selectableIssueTypes.isEmpty else {
            selectedIssueType = Self.customIssueTypeTag
            return
        }
        if selectedIssueType == Self.customIssueTypeTag,
           !customIssueType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return
        }
        if selectableIssueTypes.contains(where: { $0.name == selectedIssueType }) {
            return
        }
        if let existing = store.draft(id: promotionId)?.issueType,
           selectableIssueTypes.contains(where: { $0.name == existing }) {
            selectedIssueType = existing
            return
        }
        selectedIssueType = defaultIssueTypeName(in: selectableIssueTypes)
    }

    private func syncDraftStateIntoView(updateStatus: Bool = false) {
        guard let draft = store.draft(id: promotionId) else { return }
        if updateStatus {
            status = draft.status
            statusText = Self.text(
                for: draft.status,
                shouldCreateWorktreeAndAttachAgent: draft.shouldCreateWorktreeAndAttachAgent
            )
        }
        remoteKey = draft.remoteWorkItem?.key
        remoteURL = draft.remoteWorkItem?.url
        if let error = draft.errorMessage, !error.isEmpty {
            errorMessage = error
        }
    }

    private func defaultIssueTypeName(in issueTypes: [TaskRemoteIssueTypeOption]) -> String {
        let preferredNames = ["Task", "Story", "Bug", "Feature Request"]
        for preferredName in preferredNames {
            if let match = issueTypes.first(where: { $0.name.caseInsensitiveCompare(preferredName) == .orderedSame }) {
                return match.name
            }
        }
        return issueTypes[0].name
    }

    private static func text(
        for status: RemoteTaskPromotionStatus,
        shouldCreateWorktreeAndAttachAgent: Bool = true
    ) -> String {
        switch status {
        case .drafted, .awaitingConfirmation:
            return String(
                localized: "tasks.remotePromotion.progress.awaitingConfirmation",
                defaultValue: "Review the draft, then create the remote task.",
                table: "TermLoop"
            )
        case .creatingRemote:
            return String(
                localized: "tasks.remotePromotion.progress.creatingRemote",
                defaultValue: "Creating remote task…",
                table: "TermLoop"
            )
        case .remoteCreated:
            return String(
                localized: "tasks.remotePromotion.progress.remoteCreated",
                defaultValue: "Remote task created.",
                table: "TermLoop"
            )
        case .bindingWorktree:
            return String(
                localized: "tasks.remotePromotion.progress.bindingWorktree",
                defaultValue: "Creating and binding worktree…",
                table: "TermLoop"
            )
        case .launchingAgent:
            return String(
                localized: "tasks.remotePromotion.progress.movingAgent",
                defaultValue: "Moving source agent into the worktree…",
                table: "TermLoop"
            )
        case .ready:
            if !shouldCreateWorktreeAndAttachAgent {
                return String(
                    localized: "tasks.remotePromotion.progress.readyTaskOnly",
                    defaultValue: "Ready. Remote and local tasks were created.",
                    table: "TermLoop"
                )
            }
            return String(
                localized: "tasks.remotePromotion.progress.ready",
                defaultValue: "Ready. The source agent was moved into the worktree.",
                table: "TermLoop"
            )
        case .failed:
            return String(
                localized: "tasks.remotePromotion.progress.failed",
                defaultValue: "Promotion failed.",
                table: "TermLoop"
            )
        case .cancelled:
            return String(
                localized: "tasks.remotePromotion.progress.cancelled",
                defaultValue: "Promotion cancelled.",
                table: "TermLoop"
            )
        }
    }
}

private struct RemoteTaskPromotionSheet: View {
    @ObservedObject var model: RemoteTaskPromotionSheetModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            fields
            progress
            actions
        }
        .padding(24)
        .frame(width: 620, height: 640, alignment: .topLeading)
        .onAppear { model.onAppear() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(String(
                localized: "tasks.remotePromotion.confirm.title",
                defaultValue: "Create remote task?",
                table: "TermLoop"
            ))
            .font(.title2.weight(.semibold))
            Text("\(model.providerLabel) \(model.container)")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(String(
                localized: "tasks.remotePromotion.confirm.titlePlaceholder",
                defaultValue: "Title",
                table: "TermLoop"
            ), text: $model.title)
            .textFieldStyle(.roundedBorder)
            .disabled(model.isWorking)

            if model.showsIssueTypePicker {
                issueTypeSection
            }

            Toggle(isOn: $model.shouldCreateWorktreeAndAttachAgent) {
                Text(String(
                    localized: "tasks.remotePromotion.confirm.attachWorktree",
                    defaultValue: "Automatically create worktree and attach current agent.",
                    table: "TermLoop"
                ))
                .font(.callout)
            }
            .toggleStyle(.checkbox)
            .disabled(model.isWorking)

            VStack(alignment: .leading, spacing: 6) {
                Text(String(
                    localized: "tasks.remotePromotion.confirm.description",
                    defaultValue: "Description",
                    table: "TermLoop"
                ))
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                TextEditor(text: $model.descriptionMarkdown)
                    .font(.body)
                    .frame(height: 180)
                    .scrollContentBackground(.hidden)
                    .background(Color(nsColor: .textBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(Color(nsColor: .separatorColor))
                    )
                    .disabled(model.isWorking)
            }
        }
    }

    @ViewBuilder
    private var issueTypeSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(String(
                localized: "tasks.remoteCreate.field.type",
                defaultValue: "Type",
                table: "TermLoop"
            ))
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)

            if !model.selectableIssueTypes.isEmpty {
                Picker(
                    String(localized: "tasks.remoteCreate.field.type",
                           defaultValue: "Type",
                           table: "TermLoop"),
                    selection: $model.selectedIssueType
                ) {
                    ForEach(model.selectableIssueTypes) { issueType in
                        Text(issueType.name).tag(issueType.name)
                    }
                    Text(String(localized: "tasks.remoteCreate.field.type.custom",
                                defaultValue: "Custom…",
                                table: "TermLoop"))
                        .tag(model.customIssueTypeTag)
                }
                .labelsHidden()
                .disabled(model.isWorking)
            } else if model.isLoadingIssueTypes {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(String(localized: "tasks.remoteCreate.issueType.loading",
                                defaultValue: "Loading Jira issue types…",
                                table: "TermLoop"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if model.isCustomIssueTypeSelected {
                TextField(String(localized: "tasks.remoteCreate.field.type.placeholder",
                                 defaultValue: "Task, Story, Bug…",
                                 table: "TermLoop"),
                          text: $model.customIssueType)
                    .textFieldStyle(.roundedBorder)
                    .disabled(model.isWorking)
            }

            if let message = model.issueTypeMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
               !message.isEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(model.selectableIssueTypes.isEmpty ? .red : .secondary)
                    .textSelection(.enabled)
                    .lineLimit(3)
            }
        }
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if model.isWorking {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(model.statusText)
                    .font(.callout)
                    .foregroundStyle(model.status == .failed ? .red : .secondary)
            }
            if let error = model.errorMessage, !error.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(String(
                        localized: "tasks.remotePromotion.error.title",
                        defaultValue: "Promotion failed",
                        table: "TermLoop"
                    ))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.red)
                    ScrollView {
                        Text(error)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(maxHeight: 110)
                    .background(Color.red.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color.red.opacity(0.20), lineWidth: 1)
                    )
                    if model.remoteKey != nil {
                        Text(String(
                            localized: "tasks.remotePromotion.error.remotePreserved",
                            defaultValue: "The remote item was created and will be reused when you retry.",
                            table: "TermLoop"
                        ))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
            }
            if let key = model.remoteKey, !key.isEmpty {
                HStack(spacing: 6) {
                    Text(String(
                        localized: "tasks.remotePromotion.remote.createdLabel",
                        defaultValue: "Remote item:",
                        table: "TermLoop"
                    ))
                    .font(.callout.weight(.medium))
                    if let rawURL = model.remoteURL,
                       let url = URL(string: rawURL) {
                        Link(key, destination: url)
                            .font(.callout)
                    } else {
                        Text(key)
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var actions: some View {
        HStack {
            Spacer()
            Button(model.status == .ready
                ? String(localized: "common.done", defaultValue: "Done", table: "TermLoop")
                : String(localized: "common.cancel", defaultValue: "Cancel", table: "TermLoop")
            ) {
                model.cancel()
            }
            .disabled(model.isWorking)

            if model.status != .ready {
                Button(String(
                    localized: "tasks.remotePromotion.confirm.create",
                    defaultValue: "Create",
                    table: "TermLoop"
                )) {
                    model.create()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canCreate)
            }
        }
    }
}

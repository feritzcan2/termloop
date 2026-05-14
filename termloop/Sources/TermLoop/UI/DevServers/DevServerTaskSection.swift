// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct DevServerTaskSection: View {
    let snapshot: TaskDetailSnapshot
    let projectId: UUID

    @ObservedObject private var provider = DevServerProfileStoreProvider.shared

    var body: some View {
        if let store = provider.store(for: projectId) {
            DevServerTaskSectionContent(snapshot: snapshot, projectId: projectId, profileStore: store)
        }
    }
}

private struct DevServerTaskSectionContent: View {
    let snapshot: TaskDetailSnapshot
    let projectId: UUID
    @ObservedObject var profileStore: DevServerProfileStore
    @ObservedObject private var runStore = DevServerRunStore.shared
    @State private var errorMessage: String?
    @State private var shownLogRunId: UUID?
    @State private var showDraftEditor = false
    @State private var draft = DevServerProfileDraft.newProfile()
    @State private var pendingDeleteProfileId: String?
    @State private var pendingSaveAndTestRunId: UUID?
    @State private var saveAndTestState: DevServerSaveAndTestState?
    @State private var timedOutSaveAndTestRunIds = Set<UUID>()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if profileStore.loadError != nil || !profileStore.profiles.isEmpty {
                headerActions
            }
            if let loadError = profileStore.loadError {
                messageCard(
                    icon: "exclamationmark.triangle",
                    title: String(localized: "devservers.sidebar.loadFailed", defaultValue: "Could not read dev server profiles", table: "TermLoop"),
                    detail: loadError.localizedDescription
                )
            } else if profileStore.profiles.isEmpty {
                emptyState
            } else {
                if !hasWorktreeBinding {
                    worktreeRequiredCard
                }
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(profileStore.profiles) { profile in
                        profileRow(profile)
                    }
                }
            }
            if profileStore.loadError == nil, showDraftEditor || !profileStore.profiles.isEmpty {
                draftEditor
            }
            if let run = pendingSaveAndTestRun {
                saveAndTestResult(run)
            } else if saveAndTestState == .saving {
                saveAndTestSavingResult
            }
            if let errorMessage {
                messageCard(
                    icon: "exclamationmark.triangle",
                    title: String(localized: "devservers.sidebar.actionFailed", defaultValue: "Dev server action failed", table: "TermLoop"),
                    detail: errorMessage
                )
            }
        }
        .onAppear { DevServerBrowserRouter.install() }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "server.rack")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 4) {
                    Text(String(localized: "devservers.sidebar.empty.title", defaultValue: "No dev server profiles", table: "TermLoop"))
                        .font(.system(size: 13, weight: .semibold))
                    Text(String(localized: "devservers.sidebar.empty.detail", defaultValue: "Create or edit .termloop/devservers.json to add project run profiles.", table: "TermLoop"))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: 7) {
                Button {
                    openProfileGenerator()
                } label: {
                    Label(
                        String(localized: "devservers.agent.generateProfile", defaultValue: "Generate run profiles with agent", table: "TermLoop"),
                        systemImage: "sparkles"
                    )
                }
                .buttonStyle(.borderedProminent)

                Button {
                    beginCreate()
                } label: {
                    Label(
                        String(localized: "devservers.editor.newProfile", defaultValue: "New profile", table: "TermLoop"),
                        systemImage: "plus"
                    )
                }
                .buttonStyle(.bordered)

                Spacer(minLength: 0)

                Button {
                    refreshProfiles()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .help(String(localized: "devservers.sidebar.refresh", defaultValue: "Refresh", table: "TermLoop"))

                Button {
                    openProfileFile()
                } label: {
                    Image(systemName: "doc.text")
                }
                .buttonStyle(.bordered)
                .help(String(localized: "devservers.sidebar.empty.openConfig", defaultValue: "Open config", table: "TermLoop"))
            }
            .controlSize(.small)
            .font(.system(size: 11, weight: .medium))
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.58))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var headerActions: some View {
        HStack(spacing: 7) {
            Button {
                openProfileGenerator()
            } label: {
                Label(
                    String(localized: "devservers.agent.generateButton", defaultValue: "Generate", table: "TermLoop"),
                    systemImage: "sparkles"
                )
            }
            .buttonStyle(.bordered)
            .help(String(localized: "devservers.agent.generateProfile", defaultValue: "Generate run profiles with agent", table: "TermLoop"))

            Button {
                beginCreate()
            } label: {
                Label(
                    String(localized: "devservers.editor.newProfile", defaultValue: "New profile", table: "TermLoop"),
                    systemImage: "plus"
                )
            }
            .buttonStyle(.bordered)
            .disabled(profileStore.loadError != nil)

            Spacer(minLength: 0)

            Button {
                refreshProfiles()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .help(String(localized: "devservers.sidebar.refresh", defaultValue: "Refresh", table: "TermLoop"))

            Button {
                openProfileFile()
            } label: {
                Image(systemName: "doc.text")
            }
            .buttonStyle(.bordered)
            .help(String(localized: "devservers.sidebar.empty.openConfig", defaultValue: "Open config", table: "TermLoop"))
        }
        .font(.system(size: 11, weight: .medium))
        .controlSize(.small)
    }

    private var worktreeRequiredCard: some View {
        messageCard(
            icon: "point.3.connected.trianglepath.dotted",
            title: String(localized: "devservers.error.taskNotBound", defaultValue: "Task is not bound to a worktree", table: "TermLoop"),
            detail: String(localized: "devservers.sidebar.worktreeRequired.detail", defaultValue: "Create or bind a worktree before starting or testing profiles.", table: "TermLoop")
        )
    }

    private func profileRow(_ profile: DevServerProfile) -> some View {
        let runs = runs(for: profile)
        let current = runs.first
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                statusDot(current?.phase ?? .idle)
                    .padding(.top, 6)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 5) {
                        Text(profile.name)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        phasePill(current?.phase ?? .idle)
                        kindPill(profile.kind)
                    }
                    Text(commandPreview(profile))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer(minLength: 8)
                controls(profile: profile, current: current)
            }
            if let current, let url = current.latestURL {
                profileURLButton(url, run: current)
            }
            if let errorLine = projectedErrorLine(current) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(errorLine)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
                .font(.system(size: 10))
                .foregroundStyle(.orange)
            }
            if pendingDeleteProfileId == profile.id {
                deleteConfirmationRow(profile)
            }
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.56))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    @ViewBuilder
    private func controls(profile: DevServerProfile, current: DevServerRunSnapshot?) -> some View {
        HStack(spacing: 6) {
            if let current, current.isActive {
                Button(String(localized: "devservers.sidebar.stop", defaultValue: "Stop", table: "TermLoop")) {
                    stop(current)
                }
                .buttonStyle(.bordered)

                logsButton(current)
                profileMoreMenu(profile: profile, current: current)
            } else {
                Button {
                    start(profile)
                } label: {
                    Label(
                        String(localized: "devservers.sidebar.start", defaultValue: "Start", table: "TermLoop"),
                        systemImage: "play.fill"
                    )
                }
                .buttonStyle(.borderedProminent)
                .disabled(!hasWorktreeBinding)

                if let current {
                    logsButton(current)
                }
                profileMoreMenu(profile: profile, current: current)
            }
        }
        .font(.system(size: 11, weight: .medium))
        .controlSize(.small)
    }

    private func profileMoreMenu(profile: DevServerProfile, current: DevServerRunSnapshot?) -> some View {
        Menu {
            Button(String(localized: "devservers.sidebar.edit", defaultValue: "Edit", table: "TermLoop")) {
                beginEdit(profile)
            }
            if current?.isActive == true {
                Button(String(localized: "devservers.sidebar.restart", defaultValue: "Restart", table: "TermLoop")) {
                    restart(profile)
                }
            }
            Divider()
            Button(role: .destructive) {
                deleteProfileRow(profile)
            } label: {
                Text(rowDeleteTitle(for: profile))
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .frame(width: 24)
    }

    private func profileURLButton(_ url: String, run: DevServerRunSnapshot) -> some View {
        Button {
            openURL(run: run, rawURL: url)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "safari")
                Text(url)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .font(.system(size: 11, weight: .medium))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.accentColor)
        .help(String(localized: "devservers.sidebar.openURL.help", defaultValue: "Open in TermLoop Browser", table: "TermLoop"))
    }

    private func deleteConfirmationRow(_ profile: DevServerProfile) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "trash")
            Text(String(localized: "devservers.sidebar.deleteConfirm.detail", defaultValue: "Delete this profile from devservers.json?", table: "TermLoop"))
                .lineLimit(2)
            Spacer(minLength: 0)
            Button(String(localized: "devservers.sidebar.cancel", defaultValue: "Cancel", table: "TermLoop")) {
                pendingDeleteProfileId = nil
            }
            .buttonStyle(.borderless)
            Button(String(localized: "devservers.editor.confirmDelete", defaultValue: "Confirm delete", table: "TermLoop")) {
                deleteProfileRow(profile)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.red)
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    @ViewBuilder
    private var draftEditor: some View {
        DisclosureGroup(
            isExpanded: $showDraftEditor,
            content: {
                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 8) {
                        TextField(
                            String(localized: "devservers.editor.id", defaultValue: "Profile id", table: "TermLoop"),
                            text: $draft.id
                        )
                        Picker("", selection: $draft.kind) {
                            ForEach(RunProfileKind.allCases) { kind in
                                Text(kind.localizedLabel).tag(kind)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 128)
                    }
                    TextField(
                        String(localized: "devservers.editor.name", defaultValue: "Name", table: "TermLoop"),
                        text: $draft.name
                    )
                    TextField(
                        String(localized: "devservers.editor.command", defaultValue: "Command", table: "TermLoop"),
                        text: $draft.command
                    )
                    TextField(
                        String(localized: "devservers.editor.cwd", defaultValue: "Working directory", table: "TermLoop"),
                        text: $draft.workingDirectory
                    )

                    editablePairs(
                        title: String(localized: "devservers.editor.env", defaultValue: "Environment", table: "TermLoop"),
                        rows: $draft.envRows,
                        addTitle: String(localized: "devservers.editor.addEnv", defaultValue: "Add env", table: "TermLoop")
                    )

                    editableStrings(
                        title: String(localized: "devservers.editor.fallbackUrls", defaultValue: "Fallback URLs", table: "TermLoop"),
                        rows: $draft.fallbackURLRows,
                        addTitle: String(localized: "devservers.editor.addFallbackUrl", defaultValue: "Add URL", table: "TermLoop")
                    )

                    TextField(
                        String(localized: "devservers.editor.setup", defaultValue: "Setup command (optional)", table: "TermLoop"),
                        text: $draft.setupCommand
                    )
                    TextField(
                        String(localized: "devservers.editor.cleanup", defaultValue: "Cleanup command (optional)", table: "TermLoop"),
                        text: $draft.cleanupCommand
                    )
                    HStack(spacing: 8) {
                        Picker(
                            String(localized: "devservers.editor.setupPolicy", defaultValue: "Setup policy", table: "TermLoop"),
                            selection: $draft.setupPolicy
                        ) {
                            ForEach(DevServerSetupPolicy.allCases) { policy in
                                Text(policy.localizedLabel).tag(policy)
                            }
                        }
                        .frame(maxWidth: 190)

                        Toggle(
                            String(localized: "devservers.editor.autoOpen", defaultValue: "Auto-open URL", table: "TermLoop"),
                            isOn: Binding(
                                get: { draft.autoOpenFirstURL },
                                set: { value in
                                    draft.autoOpenFirstURL = value
                                    draft.usesProjectAutoOpenDefault = false
                                }
                            )
                        )
                    }
                    if draft.usesProjectAutoOpenDefault {
                        Text(String(localized: "devservers.editor.autoOpenDefault", defaultValue: "Auto-open uses the project default.", table: "TermLoop"))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    } else {
                        Button(String(localized: "devservers.editor.useProjectDefault", defaultValue: "Use project default", table: "TermLoop")) {
                            draft.usesProjectAutoOpenDefault = true
                        }
                        .buttonStyle(.borderless)
                        .font(.system(size: 10))
                    }

                    if let validation = draft.validationMessage {
                        Text(validation)
                            .font(.system(size: 10))
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack(spacing: 8) {
                        Button(String(localized: "devservers.editor.save", defaultValue: "Save", table: "TermLoop")) {
                            saveDraft(startAfterSave: false)
                        }
                        .buttonStyle(.bordered)

                        Button(String(localized: "devservers.editor.saveAndTest", defaultValue: "Save & Test", table: "TermLoop")) {
                            saveDraft(startAfterSave: true)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!hasWorktreeBinding)

                        if draft.originalId != nil {
                            Button(deleteButtonTitle) {
                                deleteDraftProfile()
                            }
                            .buttonStyle(.bordered)
                            .foregroundStyle(.red)
                        }

                        Spacer()
                    }
                    .font(.system(size: 11, weight: .medium))
                    .controlSize(.small)
                }
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11))
                .padding(.top, 6)
            },
            label: {
                Text(editorTitle)
                    .font(.system(size: 12, weight: .semibold))
            }
        )
        .padding(.vertical, 8)
        .padding(.horizontal, 9)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.40))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func editablePairs(
        title: String,
        rows: Binding<[EditableEnvironmentRow]>,
        addTitle: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            ForEach(rows) { $row in
                HStack(spacing: 5) {
                    TextField(String(localized: "devservers.editor.envKey", defaultValue: "KEY", table: "TermLoop"), text: $row.key)
                    TextField(String(localized: "devservers.editor.envValue", defaultValue: "value", table: "TermLoop"), text: $row.value)
                    Button {
                        draft.envRows.removeAll { $0.id == row.id }
                    } label: {
                        Image(systemName: "xmark.circle")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
            }
            Button(addTitle) {
                draft.envRows.append(EditableEnvironmentRow(key: "", value: ""))
            }
            .buttonStyle(.borderless)
        }
    }

    private func editableStrings(
        title: String,
        rows: Binding<[EditableStringRow]>,
        addTitle: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            ForEach(rows) { $row in
                HStack(spacing: 5) {
                    TextField(
                        String(localized: "devservers.editor.fallbackPlaceholder", defaultValue: "http://localhost:5173", table: "TermLoop"),
                        text: $row.value
                    )
                    Button {
                        draft.fallbackURLRows.removeAll { $0.id == row.id }
                    } label: {
                        Image(systemName: "xmark.circle")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
            }
            Button(addTitle) {
                draft.fallbackURLRows.append(EditableStringRow(value: ""))
            }
            .buttonStyle(.borderless)
        }
    }

    private func logsButton(_ run: DevServerRunSnapshot) -> some View {
        Button(String(localized: "devservers.sidebar.logs", defaultValue: "Logs", table: "TermLoop")) {
            shownLogRunId = run.runId
        }
        .font(.system(size: 11, weight: .medium))
        .buttonStyle(.borderless)
        .popover(isPresented: Binding(
            get: { shownLogRunId == run.runId },
            set: { isShown in shownLogRunId = isShown ? run.runId : nil }
        )) {
            DevServerLogPopover(
                run: run,
                lines: runStore.logs(runId: run.runId, limit: 300)
            )
        }
    }

    private var pendingSaveAndTestRun: DevServerRunSnapshot? {
        _ = runStore.version
        guard let pendingSaveAndTestRunId else { return nil }
        return runStore.snapshot(runId: pendingSaveAndTestRunId)
    }

    private var saveAndTestSavingResult: some View {
        HStack(spacing: 6) {
            Image(systemName: "hourglass")
            Text(String(localized: "devservers.editor.test.saving", defaultValue: "Saving profile…", table: "TermLoop"))
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
        .padding(.horizontal, 9)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.40))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func saveAndTestResult(_ run: DevServerRunSnapshot) -> some View {
        let status = saveAndTestDisplayStatus(run)
        let detail: String
        let color: Color
        if let url = run.latestURL {
            detail = String(
                localized: "devservers.editor.test.ready",
                defaultValue: "Test ready: \(url)",
                table: "TermLoop"
            )
            color = Color(red: 0.30, green: 0.78, blue: 0.36)
        } else if timedOutSaveAndTestRunIds.contains(run.runId), run.isActive {
            detail = String(
                localized: "devservers.editor.test.timedOut",
                defaultValue: "Timed out waiting for a URL. The run is still active.",
                table: "TermLoop"
            )
            color = .orange
        } else if run.phase == .failed {
            detail = String(
                localized: "devservers.editor.test.failed",
                defaultValue: "Test failed: \(projectedErrorLine(run) ?? run.phase.localizedLabel)",
                table: "TermLoop"
            )
            color = .red
        } else if run.phase == .exited {
            detail = String(
                localized: "devservers.editor.test.exited",
                defaultValue: "Test exited before a URL was detected.",
                table: "TermLoop"
            )
            color = .orange
        } else if status == .saving {
            detail = String(localized: "devservers.editor.test.saving", defaultValue: "Saving profile…", table: "TermLoop")
            color = .secondary
        } else if run.phase == .settingUp {
            detail = String(localized: "devservers.editor.test.setupRunning", defaultValue: "Setup running…", table: "TermLoop")
            color = .orange
        } else if run.phase == .starting {
            detail = String(localized: "devservers.editor.test.starting", defaultValue: "Starting run…", table: "TermLoop")
            color = .orange
        } else {
            detail = String(
                localized: "devservers.editor.test.waiting",
                defaultValue: "Waiting for a localhost URL…",
                table: "TermLoop"
            )
            color = .secondary
        }

        let iconName = run.latestURL != nil
            ? "checkmark.circle"
            : (run.phase == .failed ? "exclamationmark.triangle" : "hourglass")
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: iconName)
                    .foregroundStyle(color)
                Text(detail)
                    .lineLimit(2)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                if let url = run.latestURL {
                    Button(String(localized: "devservers.sidebar.openURL", defaultValue: "Open", table: "TermLoop")) {
                        openURL(run: run, rawURL: url)
                    }
                    .buttonStyle(.borderless)
                }
                logsButton(run)
            }
        }
        .font(.system(size: 11))
        .padding(.vertical, 6)
        .padding(.horizontal, 9)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.40))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func saveAndTestDisplayStatus(_ run: DevServerRunSnapshot) -> DevServerSaveAndTestState {
        if let saveAndTestState, saveAndTestState == .saving { return .saving }
        if run.latestURL != nil { return .ready }
        if timedOutSaveAndTestRunIds.contains(run.runId), run.isActive { return .timedOut }
        switch run.phase {
        case .settingUp: return .setupRunning
        case .starting: return .starting
        case .running, .stopping, .idle: return .waitingForURL
        case .failed: return .failed
        case .exited: return .exitedBeforeURL
        }
    }

    private func runs(for profile: DevServerProfile) -> [DevServerRunSnapshot] {
        _ = runStore.version
        return runStore.snapshots(projectId: projectId, taskId: snapshot.id)
            .filter { $0.key.profileId == profile.id }
            .sorted { lhs, rhs in
                if lhs.isActive != rhs.isActive { return lhs.isActive }
                return lhs.updatedAt > rhs.updatedAt
            }
    }

    private var hasWorktreeBinding: Bool {
        snapshot.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    private var editorTitle: String {
        if draft.originalId == nil {
            return String(localized: "devservers.editor.addProfile", defaultValue: "Add profile", table: "TermLoop")
        }
        return String(localized: "devservers.editor.editProfile", defaultValue: "Edit profile", table: "TermLoop")
    }

    private var deleteButtonTitle: String {
        if pendingDeleteProfileId == draft.originalId {
            return String(localized: "devservers.editor.confirmDelete", defaultValue: "Confirm delete", table: "TermLoop")
        }
        return String(localized: "devservers.editor.delete", defaultValue: "Delete", table: "TermLoop")
    }

    private func rowDeleteTitle(for profile: DevServerProfile) -> String {
        if pendingDeleteProfileId == profile.id {
            return String(localized: "devservers.editor.confirmDelete", defaultValue: "Confirm delete", table: "TermLoop")
        }
        return String(localized: "devservers.editor.delete", defaultValue: "Delete", table: "TermLoop")
    }

    private func start(_ profile: DevServerProfile) {
        runAction {
            _ = try DevServerRunCoordinator.shared.start(
                projectId: projectId,
                taskId: snapshot.id,
                profileId: profile.id,
                openOnURL: profile.presentation.autoOpenFirstUrl ?? profileStore.defaults.autoOpenFirstUrl
            )
        }
    }

    private func restart(_ profile: DevServerProfile) {
        runAction {
            _ = try DevServerRunCoordinator.shared.restart(
                projectId: projectId,
                taskId: snapshot.id,
                profileId: profile.id,
                openOnURL: profile.presentation.autoOpenFirstUrl ?? profileStore.defaults.autoOpenFirstUrl
            )
        }
    }

    private func refreshProfiles() {
        errorMessage = nil
        pendingDeleteProfileId = nil
        profileStore.loadOrCreate()
    }

    private func beginCreate() {
        pendingDeleteProfileId = nil
        errorMessage = nil
        draft = .newProfile()
        showDraftEditor = true
    }

    private func beginEdit(_ profile: DevServerProfile) {
        pendingDeleteProfileId = nil
        errorMessage = nil
        draft = DevServerProfileDraft(profile: profile)
        showDraftEditor = true
    }

    private func saveDraft(startAfterSave: Bool) {
        runAction {
            saveAndTestState = startAfterSave ? .saving : nil
            if !startAfterSave {
                pendingSaveAndTestRunId = nil
                timedOutSaveAndTestRunIds.removeAll()
            }
            if let loadError = profileStore.loadError {
                throw loadError
            }
            let profile = try draft.makeProfile()
            try profileStore.upsert(profile)
            if let originalId = draft.originalId, originalId != profile.id {
                stopRuns(profileId: originalId)
                try profileStore.delete(profileId: originalId)
            }
            draft = DevServerProfileDraft(profile: profile)
            if startAfterSave {
                let run = try DevServerRunCoordinator.shared.start(
                    projectId: projectId,
                    taskId: snapshot.id,
                    profileId: profile.id,
                    restart: true,
                    openOnURL: true
                )
                pendingSaveAndTestRunId = run.runId
                saveAndTestState = saveAndTestDisplayStatus(run)
                scheduleSaveAndTestTimeout(runId: run.runId)
            } else {
                saveAndTestState = nil
            }
        }
    }

    private func deleteDraftProfile() {
        guard let profileId = draft.originalId else { return }
        guard pendingDeleteProfileId == profileId else {
            pendingDeleteProfileId = profileId
            return
        }
        runAction {
            if let loadError = profileStore.loadError { throw loadError }
            stopRuns(profileId: profileId)
            try profileStore.delete(profileId: profileId)
            pendingDeleteProfileId = nil
            pendingSaveAndTestRunId = nil
            saveAndTestState = nil
            draft = .newProfile()
            showDraftEditor = !profileStore.profiles.isEmpty
        }
    }

    private func deleteProfileRow(_ profile: DevServerProfile) {
        guard pendingDeleteProfileId == profile.id else {
            pendingDeleteProfileId = profile.id
            return
        }
        runAction {
            if let loadError = profileStore.loadError { throw loadError }
            stopRuns(profileId: profile.id)
            try profileStore.delete(profileId: profile.id)
            pendingDeleteProfileId = nil
            if draft.originalId == profile.id {
                draft = .newProfile()
                showDraftEditor = false
            }
        }
    }

    private func stop(_ run: DevServerRunSnapshot) {
        runAction { _ = try DevServerRunCoordinator.shared.stop(runId: run.runId) }
    }

    private func stopRuns(profileId: String) {
        for run in runStore.snapshots(projectId: projectId, taskId: snapshot.id)
            where run.key.profileId == profileId && run.isActive {
            _ = try? DevServerRunCoordinator.shared.stop(runId: run.runId)
        }
    }

    private func openURL(run: DevServerRunSnapshot?, rawURL: String) {
        guard let run,
              let normalized = DevServerURLDetector.normalize(rawURL),
              let url = URL(string: normalized) else { return }
        _ = DevServerBrowserRouter.open(snapshot: run, url: url, focus: true)
    }

    private func projectedErrorLine(_ run: DevServerRunSnapshot?) -> String? {
        guard let run else { return nil }
        if run.phase == .failed, let errorMessage = run.errorMessage {
            return errorMessage
        }
        return run.recentErrorLines.last
    }

    private func scheduleSaveAndTestTimeout(runId: UUID) {
        _Concurrency.Task {
            try? await _Concurrency.Task.sleep(nanoseconds: 45_000_000_000)
            await MainActor.run {
                guard pendingSaveAndTestRunId == runId,
                      let run = runStore.snapshot(runId: runId),
                      run.latestURL == nil,
                      run.isActive else {
                    return
                }
                timedOutSaveAndTestRunIds.insert(runId)
                saveAndTestState = .timedOut
            }
        }
    }

    private func runAction(_ action: () throws -> Void) {
        do {
            errorMessage = nil
            try action()
        } catch {
            saveAndTestState = nil
            errorMessage = error.localizedDescription
        }
    }

    private func openProfileFile() {
        do {
            if !FileManager.default.fileExists(atPath: profileStore.profileFileURL().path) {
                try profileStore.saveNow()
            }
            NSWorkspace.shared.open(profileStore.profileFileURL())
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func openProfileGenerator() {
        QuickActionController.shared.present(
            prefill: QuickActionPresentationRequest(
                initialSurface: .run,
                composition: .template(id: "devserver-profile-generator"),
                systemPromptDocumentId: "system.template.devserver-profile-generator",
                advancedTitle: String(
                    localized: "devservers.agent.workspaceTitle",
                    defaultValue: "Generate dev server profile",
                    table: "TermLoop"
                ),
                launchSource: .quickAction,
                reasonTag: "devservers.profileGenerator",
                projectId: projectId,
                runTarget: .projectRoot(projectId),
                openAdvanced: true,
                onLaunchedWorkspace: { workspace in
                    WorkspaceMetadataStore.shared.setProjectId(projectId, forWorkspaceId: workspace.id)
                    WorkspaceMetadataStore.shared.setLastUserPromptAt(Date(), forWorkspaceId: workspace.id)
                    TerminalAgentActivityStore.shared.refreshPresentations(forWorkspaceIds: [workspace.id])
                    TermLoopHooks.saveCriticalAgentRestoreStateSync()
                }
            )
        )
    }

    private func commandPreview(_ profile: DevServerProfile) -> String {
        let cwd = profile.workingDirectory == "."
            ? String(localized: "devservers.sidebar.cwdRoot", defaultValue: "worktree", table: "TermLoop")
            : profile.workingDirectory
        return "\(cwd) $ \(profile.command)"
    }

    private func phasePill(_ phase: DevServerRunPhase) -> some View {
        Text(phase.localizedLabel.uppercased())
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(color(for: phase))
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(color(for: phase).opacity(0.14))
            .clipShape(Capsule())
    }

    private func kindPill(_ kind: RunProfileKind) -> some View {
        Text(kind.localizedLabel)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Color.secondary.opacity(0.12))
            .clipShape(Capsule())
    }

    private func statusDot(_ phase: DevServerRunPhase) -> some View {
        Circle()
            .fill(color(for: phase))
            .frame(width: 7, height: 7)
    }

    private func color(for phase: DevServerRunPhase) -> Color {
        switch phase {
        case .running: return Color(red: 0.30, green: 0.78, blue: 0.36)
        case .starting, .settingUp, .stopping: return .orange
        case .failed: return Color(red: 0.92, green: 0.36, blue: 0.31)
        case .idle, .exited: return .secondary.opacity(0.7)
        }
    }

    private func messageCard(
        icon: String,
        title: String,
        detail: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                Spacer(minLength: 0)
            }
            Text(detail)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.system(size: 11, weight: .medium))
                    .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.56))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private enum DevServerSaveAndTestState: Equatable {
    case saving
    case setupRunning
    case starting
    case waitingForURL
    case ready
    case failed
    case exitedBeforeURL
    case timedOut
}

private struct EditableEnvironmentRow: Identifiable, Equatable {
    var id = UUID()
    var key: String
    var value: String
}

private struct EditableStringRow: Identifiable, Equatable {
    var id = UUID()
    var value: String
}

private struct DevServerProfileDraft: Equatable {
    var originalId: String?
    var id: String
    var name: String
    var kind: RunProfileKind
    var command: String
    var workingDirectory: String
    var envRows: [EditableEnvironmentRow]
    var fallbackURLRows: [EditableStringRow]
    var setupCommand: String
    var cleanupCommand: String
    var setupPolicy: DevServerSetupPolicy
    var autoOpenFirstURL: Bool
    var usesProjectAutoOpenDefault: Bool
    var autoDetectURLs: Bool
    var readyRegexes: [String]
    var extensions: [String: JSONValue]

    static func newProfile() -> DevServerProfileDraft {
        DevServerProfileDraft(
            originalId: nil,
            id: "web",
            name: "Web",
            kind: .devServer,
            command: "",
            workingDirectory: ".",
            envRows: [],
            fallbackURLRows: [],
            setupCommand: "",
            cleanupCommand: "",
            setupPolicy: .oncePerWorktreeProfileConfig,
            autoOpenFirstURL: true,
            usesProjectAutoOpenDefault: false,
            autoDetectURLs: true,
            readyRegexes: [],
            extensions: [:]
        )
    }

    init(profile: DevServerProfile) {
        self.originalId = profile.id
        self.id = profile.id
        self.name = profile.name
        self.kind = profile.kind
        self.command = profile.command
        self.workingDirectory = profile.workingDirectory
        self.envRows = profile.env
            .sorted { $0.key < $1.key }
            .map { EditableEnvironmentRow(key: $0.key, value: $0.value) }
        self.fallbackURLRows = profile.urlDetection.fallbackUrls.map { EditableStringRow(value: $0) }
        self.setupCommand = profile.setupCommand ?? ""
        self.cleanupCommand = profile.cleanupCommand ?? ""
        self.setupPolicy = profile.setupPolicy
        self.autoOpenFirstURL = profile.presentation.autoOpenFirstUrl ?? false
        self.usesProjectAutoOpenDefault = profile.presentation.autoOpenFirstUrl == nil
        self.autoDetectURLs = profile.urlDetection.autoDetect
        self.readyRegexes = profile.urlDetection.readyRegexes
        self.extensions = profile.extensions
    }

    private init(
        originalId: String?,
        id: String,
        name: String,
        kind: RunProfileKind,
        command: String,
        workingDirectory: String,
        envRows: [EditableEnvironmentRow],
        fallbackURLRows: [EditableStringRow],
        setupCommand: String,
        cleanupCommand: String,
        setupPolicy: DevServerSetupPolicy,
        autoOpenFirstURL: Bool,
        usesProjectAutoOpenDefault: Bool,
        autoDetectURLs: Bool,
        readyRegexes: [String],
        extensions: [String: JSONValue]
    ) {
        self.originalId = originalId
        self.id = id
        self.name = name
        self.kind = kind
        self.command = command
        self.workingDirectory = workingDirectory
        self.envRows = envRows
        self.fallbackURLRows = fallbackURLRows
        self.setupCommand = setupCommand
        self.cleanupCommand = cleanupCommand
        self.setupPolicy = setupPolicy
        self.autoOpenFirstURL = autoOpenFirstURL
        self.usesProjectAutoOpenDefault = usesProjectAutoOpenDefault
        self.autoDetectURLs = autoDetectURLs
        self.readyRegexes = readyRegexes
        self.extensions = extensions
    }

    var validationMessage: String? {
        if !DevServerProfile.isValidId(DevServerProfile.normalizedId(id)) {
            return String(
                localized: "devservers.error.invalidProfileId",
                defaultValue: "Profile id must contain letters, numbers, dot, underscore, or dash.",
                table: "TermLoop"
            )
        }
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "devservers.error.invalidName", defaultValue: "Profile name cannot be empty.", table: "TermLoop")
        }
        if command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "devservers.error.invalidCommand", defaultValue: "Profile command cannot be empty.", table: "TermLoop")
        }
        if workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "devservers.error.invalidWorkingDirectory", defaultValue: "Working directory cannot be empty.", table: "TermLoop")
        }
        if fallbackURLRows.contains(where: { row in
            let raw = row.value.trimmingCharacters(in: .whitespacesAndNewlines)
            return !raw.isEmpty && DevServerURLDetector.normalize(raw) == nil
        }) {
            return String(
                localized: "devservers.error.invalidFallbackURL",
                defaultValue: "Fallback URLs must be localhost HTTP URLs.",
                table: "TermLoop"
            )
        }
        return nil
    }

    func makeProfile() throws -> DevServerProfile {
        if let validationMessage {
            throw DevServerProfileDraftError(validationMessage)
        }
        var env: [String: String] = [:]
        for row in envRows {
            let key = row.key.trimmingCharacters(in: .whitespacesAndNewlines)
            let value = row.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty, !value.isEmpty else { continue }
            env[key] = value
        }
        let fallbackURLs = fallbackURLRows.compactMap { row -> String? in
            let raw = row.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !raw.isEmpty else { return nil }
            return DevServerURLDetector.normalize(raw)
        }
        return try DevServerProfile(
            id: id,
            name: name,
            kind: kind,
            command: command,
            workingDirectory: workingDirectory,
            env: env,
            setupCommand: setupCommand,
            cleanupCommand: cleanupCommand,
            setupPolicy: setupPolicy,
            urlDetection: DevServerURLDetection(
                autoDetect: autoDetectURLs,
                fallbackUrls: fallbackURLs,
                readyRegexes: readyRegexes
            ),
            presentation: DevServerPresentation(
                autoOpenFirstUrl: usesProjectAutoOpenDefault ? nil : autoOpenFirstURL
            ),
            extensions: extensions
        )
    }
}

private struct DevServerProfileDraftError: LocalizedError {
    let errorDescription: String?

    init(_ message: String) {
        self.errorDescription = message
    }
}

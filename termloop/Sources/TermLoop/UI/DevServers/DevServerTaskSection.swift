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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TaskSidebarSectionTitle(
                String(localized: "devservers.sidebar.title", defaultValue: "Dev Servers", table: "TermLoop")
            )
            if let loadError = profileStore.loadError {
                messageCard(
                    icon: "exclamationmark.triangle",
                    title: String(localized: "devservers.sidebar.loadFailed", defaultValue: "Could not read dev server profiles", table: "TermLoop"),
                    detail: loadError.localizedDescription
                )
            } else if profileStore.profiles.isEmpty {
                emptyState
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(profileStore.profiles) { profile in
                        profileRow(profile)
                    }
                }
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { DevServerBrowserRouter.install() }
    }

    private var emptyState: some View {
        messageCard(
            icon: "server.rack",
            title: String(localized: "devservers.sidebar.empty.title", defaultValue: "No dev server profiles", table: "TermLoop"),
            detail: String(localized: "devservers.sidebar.empty.detail", defaultValue: "Create or edit .termloop/devservers.json to add project run profiles.", table: "TermLoop"),
            actionTitle: String(localized: "devservers.sidebar.empty.openConfig", defaultValue: "Open config", table: "TermLoop"),
            action: openProfileFile
        )
    }

    private func profileRow(_ profile: DevServerProfile) -> some View {
        let runs = runs(for: profile)
        let current = runs.first
        return VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                statusDot(current?.phase ?? .idle)
                VStack(alignment: .leading, spacing: 2) {
                    Text(profile.name)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.primary)
                    Text(commandPreview(profile))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                controls(profile: profile, current: current)
            }
            if let url = current?.latestURL {
                Button {
                    openURL(run: current, rawURL: url)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "safari")
                        Text(url)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .help(String(localized: "devservers.sidebar.openURL.help", defaultValue: "Open in TermLoop Browser", table: "TermLoop"))
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.56))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func controls(profile: DevServerProfile, current: DevServerRunSnapshot?) -> some View {
        HStack(spacing: 5) {
            if let current, current.isActive {
                Button(String(localized: "devservers.sidebar.restart", defaultValue: "Restart", table: "TermLoop")) {
                    restart(profile)
                }
                .font(.system(size: 11, weight: .medium))
                .buttonStyle(.borderless)

                Button(String(localized: "devservers.sidebar.stop", defaultValue: "Stop", table: "TermLoop")) {
                    stop(current)
                }
                .font(.system(size: 11, weight: .medium))
                .buttonStyle(.borderless)

                logsButton(current)
            } else {
                Button(String(localized: "devservers.sidebar.start", defaultValue: "Start", table: "TermLoop")) {
                    start(profile)
                }
                .font(.system(size: 11, weight: .medium))
                .buttonStyle(.borderless)
                .disabled(!hasWorktreeBinding)
                if let current {
                    logsButton(current)
                }
            }
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

    private func stop(_ run: DevServerRunSnapshot) {
        runAction { _ = try DevServerRunCoordinator.shared.stop(runId: run.runId) }
    }

    private func openURL(run: DevServerRunSnapshot?, rawURL: String) {
        guard let run,
              let normalized = DevServerURLDetector.normalize(rawURL),
              let url = URL(string: normalized) else { return }
        _ = DevServerBrowserRouter.open(snapshot: run, url: url, focus: true)
    }

    private func runAction(_ action: () throws -> Void) {
        do {
            errorMessage = nil
            try action()
        } catch {
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

    private func commandPreview(_ profile: DevServerProfile) -> String {
        let cwd = profile.workingDirectory == "."
            ? String(localized: "devservers.sidebar.cwdRoot", defaultValue: "worktree", table: "TermLoop")
            : profile.workingDirectory
        return "\(cwd) $ \(profile.command)"
    }

    private func statusDot(_ phase: DevServerRunPhase) -> some View {
        Circle()
            .fill(color(for: phase))
            .frame(width: 7, height: 7)
    }

    private func color(for phase: DevServerRunPhase) -> Color {
        switch phase {
        case .running: return Color(red: 0.30, green: 0.78, blue: 0.36)
        case .starting, .stopping: return .orange
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

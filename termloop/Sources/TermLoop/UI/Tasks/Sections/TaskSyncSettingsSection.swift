// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct TaskSidebarSettingsButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "gearshape")
                    .font(.system(size: 12, weight: .semibold))
                Text(String(localized: "tasks.sidebar.settings.open",
                            defaultValue: "Task Settings",
                            table: "TermLoop"))
                    .font(.system(size: 12, weight: .medium))
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.secondary)
            }
            .foregroundColor(.secondary)
            .padding(.vertical, 8)
            .padding(.horizontal, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.55))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct TaskSettingsSidebarView: View {
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    settingsCard {
                        TaskJiraSyncSettingsView(remoteSync: remoteSync)
                    }
                    settingsCard {
                        TaskColumnSettingsView(remoteSync: remoteSync)
                    }
                }
                .padding(10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            remoteSync.loadJiraAccountOptionsIfNeeded()
            remoteSync.loadProjectOptionsIfNeeded()
            remoteSync.loadRemoteStatusOptionsIfNeeded()
            remoteSync.syncIfEnabledOnAppear()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 9) {
            Button(action: onBack) {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                    Text(String(localized: "tasks.settings.back",
                                defaultValue: "Back",
                                table: "TermLoop"))
                }
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.accentColor)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 3) {
                Text(String(localized: "tasks.settings.title",
                            defaultValue: "Task Settings",
                            table: "TermLoop"))
                    .font(.system(size: 15, weight: .semibold))
                Text(String(localized: "tasks.settings.subtitle",
                            defaultValue: "Project-level Jira sync and board columns.",
                            table: "TermLoop"))
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func settingsCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.50))
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

private struct TaskJiraSyncSettingsView: View {
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeader(
                title: String(localized: "tasks.settings.jira.title",
                              defaultValue: "Jira sync",
                              table: "TermLoop"),
                subtitle: String(localized: "tasks.settings.jira.subtitle",
                                 defaultValue: "Pull assigned Jira work items into the task backlog.",
                                 table: "TermLoop")
            )

            Toggle(isOn: syncBinding) {
                Text(String(localized: "tasks.settings.syncAssignedToMe",
                            defaultValue: "Sync assigned to me",
                            table: "TermLoop"))
                    .font(.system(size: 12, weight: .medium))
            }
            .toggleStyle(.switch)
            .controlSize(.small)

            if !remoteSync.jiraAccountOptions.isEmpty || remoteSync.isLoadingJiraAccounts {
                VStack(alignment: .leading, spacing: 5) {
                    Text(String(localized: "tasks.settings.jiraAccount",
                                defaultValue: "Jira account",
                                table: "TermLoop"))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.secondary)
                    HStack(spacing: 6) {
                        Picker("", selection: jiraAccountBinding) {
                            Text(String(localized: "tasks.settings.jiraAccount.custom",
                                        defaultValue: "Custom",
                                        table: "TermLoop"))
                                .tag("")
                            ForEach(remoteSync.jiraAccountOptions) { option in
                                Text(option.displayLabel).tag(option.id)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                        .frame(maxWidth: .infinity, alignment: .leading)

                        LoadingIconButton(
                            systemImage: "arrow.clockwise",
                            isLoading: remoteSync.isLoadingJiraAccounts,
                            action: { remoteSync.loadJiraAccountOptions() }
                        )
                    }
                }
            }

            labeledTextField(
                label: String(localized: "tasks.settings.jiraSite",
                              defaultValue: "Jira site",
                              table: "TermLoop"),
                placeholder: String(localized: "tasks.settings.jiraSite.placeholder",
                                    defaultValue: "company.atlassian.net",
                                    table: "TermLoop"),
                text: jiraSiteBinding
            )

            labeledTextField(
                label: String(localized: "tasks.settings.jiraEmail",
                              defaultValue: "Jira email",
                              table: "TermLoop"),
                placeholder: String(localized: "tasks.settings.jiraEmail.placeholder",
                                    defaultValue: "you@company.com",
                                    table: "TermLoop"),
                text: jiraEmailBinding
            )

            VStack(alignment: .leading, spacing: 5) {
                Text(String(localized: "tasks.settings.jiraProject",
                            defaultValue: "Jira project",
                            table: "TermLoop"))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.secondary)
                HStack(spacing: 6) {
                    Picker("", selection: projectBinding) {
                        Text(String(localized: "tasks.settings.jiraProject.all",
                                    defaultValue: "All assigned projects",
                                    table: "TermLoop"))
                            .tag("")
                        ForEach(remoteSync.projectOptions) { option in
                            Text(option.displayLabel).tag(option.key)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)

                    LoadingIconButton(
                        systemImage: "arrow.clockwise",
                        isLoading: remoteSync.isLoadingProjects,
                        action: { remoteSync.loadProjectOptions() }
                    )
                }

                TextField(
                    String(localized: "tasks.settings.jiraProject.key.placeholder",
                           defaultValue: "Project key (optional, e.g. KAN)",
                           table: "TermLoop"),
                    text: projectBinding
                )
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11))
                .help(String(localized: "tasks.settings.jiraProject.key.help",
                             defaultValue: "Use this if your Jira account cannot list projects but JQL works for a known project key.",
                             table: "TermLoop"))
            }

            HStack(spacing: 6) {
                Button(action: { remoteSync.syncAssignedToMe() }) {
                    if remoteSync.isSyncing {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 12, height: 12)
                    } else {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    Text(String(localized: "tasks.settings.syncNow",
                                defaultValue: "Sync now",
                                table: "TermLoop"))
                }
                .disabled(remoteSync.isSyncing)
                Spacer(minLength: 0)
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)

            if let statusText {
                Text(statusText)
                    .font(.system(size: 10))
                    .foregroundColor(statusColor)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var syncBinding: Binding<Bool> {
        Binding(
            get: { remoteSync.settings.syncAssignedToMe },
            set: { remoteSync.setSyncAssignedToMe($0) }
        )
    }

    private var jiraAccountBinding: Binding<String> {
        Binding(
            get: {
                let site = remoteSync.settings.jiraSite ?? ""
                let email = remoteSync.settings.jiraEmail ?? ""
                return remoteSync.jiraAccountOptions.first { option in
                    option.site == site && (option.email ?? "") == email
                }?.id ?? ""
            },
            set: { remoteSync.selectJiraAccount($0) }
        )
    }

    private var projectBinding: Binding<String> {
        Binding(
            get: { remoteSync.settings.container ?? "" },
            set: { remoteSync.setContainer($0) }
        )
    }

    private var jiraSiteBinding: Binding<String> {
        Binding(
            get: { remoteSync.settings.jiraSite ?? "" },
            set: { remoteSync.setJiraSite($0) }
        )
    }

    private var jiraEmailBinding: Binding<String> {
        Binding(
            get: { remoteSync.settings.jiraEmail ?? "" },
            set: { remoteSync.setJiraEmail($0) }
        )
    }

    private var statusText: String? {
        if remoteSync.isSyncing {
            return String(localized: "tasks.settings.syncing",
                          defaultValue: "Syncing assigned work items…",
                          table: "TermLoop")
        }
        if let message = remoteSync.lastMessage, !message.isEmpty { return message }
        let settings = remoteSync.settings
        if let error = settings.lastError, !error.isEmpty { return error }
        if let date = settings.lastSyncedAt {
            return String(localized: "tasks.settings.lastSynced",
                          defaultValue: "Last synced \(date.formatted(date: .abbreviated, time: .shortened))",
                          table: "TermLoop")
        }
        return String(localized: "tasks.settings.notSynced",
                      defaultValue: "Not synced yet.",
                      table: "TermLoop")
    }

    private var statusColor: Color {
        remoteSync.settings.lastError == nil ? .secondary : .red
    }

    private func labeledTextField(label: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11))
        }
    }
}

private struct TaskColumnSettingsView: View {
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 8) {
                sectionHeader(
                    title: String(localized: "tasks.settings.columns.title",
                                  defaultValue: "Columns",
                                  table: "TermLoop"),
                    subtitle: String(localized: "tasks.settings.columns.subtitle",
                                     defaultValue: "Customize the project board. Hidden columns with tasks stay visible until emptied.",
                                     table: "TermLoop")
                )
                Spacer(minLength: 0)
                LoadingIconButton(
                    systemImage: "arrow.clockwise",
                    isLoading: remoteSync.isLoadingStatuses,
                    action: { remoteSync.loadRemoteStatusOptions() }
                )
            }

            Toggle(isOn: remoteColumnMoveBinding) {
                Text(String(localized: "tasks.settings.syncColumnMoves",
                            defaultValue: "Ask to sync board moves to remote",
                            table: "TermLoop"))
                    .font(.system(size: 12, weight: .medium))
            }
            .toggleStyle(.switch)
            .controlSize(.small)

            HStack(spacing: 6) {
                Button(action: presentAddColumnPrompt) {
                    Image(systemName: "plus")
                    Text(String(localized: "tasks.settings.columns.add",
                                defaultValue: "Add column",
                                table: "TermLoop"))
                }

                Button(action: { remoteSync.syncRemoteStatusesToColumns() }) {
                    if remoteSync.isLoadingStatuses {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 12, height: 12)
                    } else {
                        Image(systemName: "rectangle.3.group")
                    }
                    Text(String(localized: "tasks.settings.columns.syncRemoteStatuses",
                                defaultValue: "Sync remote statuses",
                                table: "TermLoop"))
                }
                .disabled(remoteSync.isLoadingStatuses)
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)

            ForEach(remoteSync.settingsVisibleColumns) { column in
                TaskColumnSettingsRow(column: column, remoteSync: remoteSync)
            }
        }
    }

    private var remoteColumnMoveBinding: Binding<Bool> {
        Binding(
            get: { remoteSync.settings.syncColumnMovesToRemote },
            set: { remoteSync.setSyncColumnMovesToRemote($0) }
        )
    }

    private func presentAddColumnPrompt() {
        let alert = NSAlert()
        alert.messageText = String(localized: "tasks.settings.columns.add.prompt.title",
                                   defaultValue: "Add Column",
                                   table: "TermLoop")
        alert.informativeText = String(localized: "tasks.settings.columns.add.prompt.body",
                                       defaultValue: "Name the new task board column.",
                                       table: "TermLoop")
        alert.alertStyle = .informational
        let field = NSTextField(string: "")
        field.placeholderString = String(localized: "tasks.settings.columns.add.placeholder",
                                         defaultValue: "Blocked",
                                         table: "TermLoop")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: String(localized: "tasks.settings.columns.add.confirm",
                                          defaultValue: "Add",
                                          table: "TermLoop"))
        alert.addButton(withTitle: String(localized: "common.cancel",
                                          defaultValue: "Cancel",
                                          table: "TermLoop"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        remoteSync.addColumn(title: field.stringValue)
    }
}

private struct TaskColumnSettingsRow: View {
    let column: TaskColumnSettings
    @ObservedObject var remoteSync: TaskRemoteSyncCoordinator

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(column.columnId.rawValue)
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                if !column.isEnabled {
                    Text(String(localized: "tasks.settings.column.hidden",
                                defaultValue: "hidden",
                                table: "TermLoop"))
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(.orange)
                }
                Spacer(minLength: 0)
                Button(action: { remoteSync.deleteColumn(column.columnId) }) {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .controlSize(.mini)
                .foregroundColor(.secondary)
                .disabled(column.columnId == .backlog)
                .help(deleteHelp)
            }

            TextField(
                String(localized: "tasks.settings.columnTitle.placeholder",
                       defaultValue: "Column title",
                       table: "TermLoop"),
                text: titleBinding
            )
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 11))

            Picker("", selection: remoteStatusBinding) {
                Text(String(localized: "tasks.settings.remoteStatus.none",
                            defaultValue: "No remote sync",
                            table: "TermLoop"))
                    .tag("")
                ForEach(statusChoices, id: \.self) { label in
                    Text(label).tag(label)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .controlSize(.mini)
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(String(localized: "tasks.settings.remoteStatus.help",
                         defaultValue: "Optional. If this status exists remotely, TermLoop asks before syncing it on board moves.",
                         table: "TermLoop"))
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 8)
        .background(Color.white.opacity(0.035))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    private var titleBinding: Binding<String> {
        Binding(
            get: { remoteSync.columnSettings(column.columnId).title },
            set: { remoteSync.setColumnTitle(column.columnId, title: $0) }
        )
    }

    private var remoteStatusBinding: Binding<String> {
        Binding(
            get: { remoteSync.columnSettings(column.columnId).remoteStatusLabel ?? "" },
            set: { remoteSync.setColumnRemoteStatus(column.columnId, status: $0) }
        )
    }

    private var statusChoices: [String] {
        var labels = remoteSync.remoteStatusOptions.map(\.label)
        if let current = column.remoteStatusLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
           !current.isEmpty,
           !labels.contains(where: { $0.compare(current, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }) {
            labels.insert(current, at: 0)
        }
        return labels
    }

    private var deleteHelp: String {
        if column.columnId == .backlog {
            return String(localized: "tasks.settings.column.delete.backlogHelp",
                          defaultValue: "Backlog stays as the safe fallback column.",
                          table: "TermLoop")
        }
        if remoteSync.columnHasActiveTasks(column.columnId) {
            return String(localized: "tasks.settings.column.delete.hasTasksHelp",
                          defaultValue: "Existing tasks stay visible in this column after it is hidden.",
                          table: "TermLoop")
        }
        return String(localized: "tasks.settings.column.delete.help",
                      defaultValue: "Hide this column from the board.",
                      table: "TermLoop")
    }
}

private func sectionHeader(title: String, subtitle: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
        Text(title)
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(.primary)
        Text(subtitle)
            .font(.system(size: 10))
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct LoadingIconButton: View {
    let systemImage: String
    let isLoading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 12, height: 12)
            } else {
                Image(systemName: systemImage)
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.mini)
        .disabled(isLoading)
    }
}

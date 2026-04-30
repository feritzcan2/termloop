// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

@MainActor
struct TermLoopSettingsView: View {
    @AppStorage(SocketControlSettings.tcpPortDefaultsKey)
    private var socketControlTcpPort = Int(SocketControlSettings.tcpPortDefault)
    @AppStorage(SocketControlSettings.tcpBindAllDefaultsKey) private var socketControlTcpBindAll = true
    @AppStorage(TermLoopHooks.claudeAutoRestoreDefaultsKey) private var claudeAutoRestore = true
    @AppStorage(TermLoopHooks.claudeAutoRestoreAskedDefaultsKey) private var claudeAutoRestoreAsked = false
    @AppStorage(SubmoduleInitService.autoInitDefaultsKey) private var autoInitSubmodules = true
    @AppStorage(QuickActionSettings.enabledKey) private var quickActionEnabled = QuickActionSettings.defaultEnabled
    @AppStorage(QuickActionSettings.defaultAgentTemplateIdKey) private var quickActionDefaultTemplateId = ""
    @AppStorage(QuickActionSettings.doubleShiftWindowMsKey) private var quickActionWindowMs = QuickActionSettings.defaultDoubleShiftWindowMs
    @ObservedObject private var templateStore = AgentTemplateStore.shared
    @ObservedObject private var claudeCredentialStore = ClaudeCredentialStore.shared
    @State private var excludedBundlesRefreshTick = 0
    @State private var addingClaudeAccount = false
    @State private var editingClaudeAccount: ClaudeCredentialProfile?
    @State private var deletingClaudeAccount: ClaudeCredentialProfile?
    @State private var azureDevOpsOrganization = ""
    @State private var azureDevOpsPAT = ""
    @State private var gitHostAuthMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                TermLoopSettingsSectionHeader(
                    title: String(
                        localized: "termloop.settings.section.agents",
                        defaultValue: "Agents",
                        table: "TermLoop"
                    )
                )

                TermLoopSettingsCard {
                    TermLoopSettingsCardRow(
                        title: String(
                            localized: "termloop.settings.claudeAutoRestore.label",
                            defaultValue: "Auto-resume Claude sessions on launch",
                            table: "TermLoop"
                        ),
                        subtitle: claudeAutoRestore
                            ? String(
                                localized: "termloop.settings.claudeAutoRestore.subtitleOn",
                                defaultValue: "When the app restores a session, automatically run `claude --resume` in each workspace that had an active Claude session.",
                                table: "TermLoop"
                              )
                            : String(
                                localized: "termloop.settings.claudeAutoRestore.subtitleOff",
                                defaultValue: "Disabled — use the workspace context menu's “Restore Claude Session” to resume manually.",
                                table: "TermLoop"
                              )
                    ) {
                        Toggle("", isOn: $claudeAutoRestore)
                            .labelsHidden()
                            .controlSize(.small)
                            .onChange(of: claudeAutoRestore) { _, _ in
                                // Deliberately setting the toggle counts as
                                // answering the onboarding prompt, so it
                                // doesn't re-appear next launch.
                                claudeAutoRestoreAsked = true
                            }
                    }
                }

                TermLoopSettingsSectionHeader(
                    title: String(
                        localized: "termloop.settings.section.worktrees",
                        defaultValue: "Worktrees",
                        table: "TermLoop"
                    )
                )

                TermLoopSettingsCard {
                    TermLoopSettingsCardRow(
                        title: String(
                            localized: "termloop.settings.autoInitSubmodules.label",
                            defaultValue: "Initialize submodules on new worktrees",
                            table: "TermLoop"
                        ),
                        subtitle: autoInitSubmodules
                            ? String(
                                localized: "termloop.settings.autoInitSubmodules.subtitleOn",
                                defaultValue: "Runs `git submodule update --init --recursive` after creating a worktree so agents see populated submodule directories. Progress appears in the sidebar footer.",
                                table: "TermLoop"
                              )
                            : String(
                                localized: "termloop.settings.autoInitSubmodules.subtitleOff",
                                defaultValue: "Disabled — new worktrees start with empty submodule directories. Useful for repos with very large submodules.",
                                table: "TermLoop"
                              )
                    ) {
                        Toggle("", isOn: $autoInitSubmodules)
                            .labelsHidden()
                            .controlSize(.small)
                    }
                }

                gitHostAuthSection

                TermLoopSettingsSectionHeader(
                    title: String(
                        localized: "termloop.settings.section.tcpBridge",
                        defaultValue: "TCP Bridge",
                        table: "TermLoop"
                    )
                )

                TermLoopSettingsCard {
                    TermLoopSettingsCardRow(
                        title: String(
                            localized: "tcpBridge.port.label",
                            defaultValue: "TCP port",
                            table: "TermLoop"
                        ),
                        subtitle: socketControlTcpPort > 0
                            ? String(
                                localized: "tcpBridge.port.subtitleOn",
                                defaultValue: "Accepting TCP connections on this port. Requires password access mode.",
                                table: "TermLoop"
                              )
                            : String(
                                localized: "tcpBridge.port.subtitleOff",
                                defaultValue: "Leave empty to disable the TCP bridge.",
                                table: "TermLoop"
                              )
                    ) {
                        TextField(
                            String(
                                localized: "tcpBridge.port.placeholder",
                                defaultValue: "e.g. 7878",
                                table: "TermLoop"
                            ),
                            value: $socketControlTcpPort,
                            format: .number
                        )
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 120)
                    }

                    TermLoopSettingsCardDivider()

                    TermLoopSettingsCardRow(
                        title: String(
                            localized: "tcpBridge.bindAll.label",
                            defaultValue: "Bind to all interfaces",
                            table: "TermLoop"
                        ),
                        subtitle: socketControlTcpBindAll
                            ? String(
                                localized: "tcpBridge.bindAll.subtitleOn",
                                defaultValue: "Listening on 0.0.0.0 — reachable from other devices (e.g. Tailscale peers).",
                                table: "TermLoop"
                              )
                            : String(
                                localized: "tcpBridge.bindAll.subtitleOff",
                                defaultValue: "Listening on 127.0.0.1 — local machine only.",
                                table: "TermLoop"
                              )
                    ) {
                        Toggle("", isOn: $socketControlTcpBindAll)
                            .labelsHidden()
                            .controlSize(.small)
                    }

                    TermLoopSettingsCardDivider()

                    TermLoopSettingsCardNote(
                        String(
                            localized: "tcpBridge.hint",
                            defaultValue: "The TCP bridge requires Password access mode. For remote access, prefer a private network such as Tailscale.",
                            table: "TermLoop"
                        )
                    )
                }

                quickActionSection

                claudeAccountsSection
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .sheet(isPresented: $addingClaudeAccount) {
            ClaudeAccountEditorSheet(
                editing: nil,
                isPresented: $addingClaudeAccount
            )
        }
        .sheet(item: $editingClaudeAccount) { profile in
            ClaudeAccountEditorSheet(
                editing: profile,
                isPresented: Binding(
                    get: { editingClaudeAccount != nil },
                    set: { if !$0 { editingClaudeAccount = nil } }
                )
            )
        }
        .confirmationDialog(
            String(
                localized: "claude.account.delete.title",
                defaultValue: "Delete Claude account?",
                table: "TermLoop"
            ),
            isPresented: Binding(
                get: { deletingClaudeAccount != nil },
                set: { if !$0 { deletingClaudeAccount = nil } }
            ),
            presenting: deletingClaudeAccount
        ) { profile in
            Button(
                String(
                    localized: "claude.account.delete.confirm",
                    defaultValue: "Delete",
                    table: "TermLoop"
                ),
                role: .destructive
            ) {
                try? claudeCredentialStore.delete(id: profile.id)
                for project in ProjectStore.shared.projects
                where project.claudeCredentialProfileId == profile.id {
                    ProjectStore.shared.setClaudeCredentialProfileId(nil, project: project.id)
                }
                deletingClaudeAccount = nil
            }
            Button(
                String(
                    localized: "claude.account.delete.cancel",
                    defaultValue: "Cancel",
                    table: "TermLoop"
                ),
                role: .cancel
            ) {
                deletingClaudeAccount = nil
            }
        } message: { profile in
            Text(String(
                localized: "claude.account.delete.message",
                defaultValue: "Removes \"\(profile.displayName)\" from TermLoop. The Keychain token is also deleted. Projects that referenced this account will fall back to your default ~/.claude/ login.",
                table: "TermLoop"
            ))
        }
    }

    // MARK: Claude Accounts

    @ViewBuilder
    private var claudeAccountsSection: some View {
        TermLoopSettingsSectionHeader(
            title: String(
                localized: "termloop.settings.section.claudeAccounts",
                defaultValue: "Claude Accounts",
                table: "TermLoop"
            )
        )

        TermLoopSettingsCard {
            TermLoopSettingsCardNote(
                String(
                    localized: "claude.account.section.note",
                    defaultValue: "Save one or more long-lived tokens from `claude setup-token`, then bind a token to each project (Project → Edit). Each Claude launch in that project authenticates as the bound account, so work and personal logins stay separate.",
                    table: "TermLoop"
                )
            )

            TermLoopSettingsCardDivider()

            if claudeCredentialStore.profiles.isEmpty {
                TermLoopSettingsCardRow(
                    title: String(
                        localized: "claude.account.empty.title",
                        defaultValue: "No accounts yet",
                        table: "TermLoop"
                    ),
                    subtitle: String(
                        localized: "claude.account.empty.subtitle",
                        defaultValue: "Add an account to use a separate Claude login per project.",
                        table: "TermLoop"
                    )
                ) {
                    Button(String(
                        localized: "claude.account.add.button",
                        defaultValue: "Add Account…",
                        table: "TermLoop"
                    )) {
                        addingClaudeAccount = true
                    }
                    .controlSize(.small)
                }
            } else {
                ForEach(Array(claudeCredentialStore.profiles.enumerated()), id: \.element.id) { index, profile in
                    if index > 0 {
                        TermLoopSettingsCardDivider()
                    }
                    TermLoopSettingsCardRow(
                        title: profile.displayName,
                        subtitle: claudeAccountSubtitle(for: profile)
                    ) {
                        HStack(spacing: 6) {
                            Button(String(
                                localized: "claude.account.edit.button",
                                defaultValue: "Edit",
                                table: "TermLoop"
                            )) {
                                editingClaudeAccount = profile
                            }
                            .controlSize(.small)

                            Button(role: .destructive) {
                                deletingClaudeAccount = profile
                            } label: {
                                Image(systemName: "trash")
                            }
                            .controlSize(.small)
                            .help(String(
                                localized: "claude.account.delete.help",
                                defaultValue: "Delete this account",
                                table: "TermLoop"
                            ))
                        }
                    }
                }

                TermLoopSettingsCardDivider()

                TermLoopSettingsCardRow(
                    title: String(
                        localized: "claude.account.add.row.title",
                        defaultValue: "Add another account",
                        table: "TermLoop"
                    ),
                    subtitle: String(
                        localized: "claude.account.add.row.subtitle",
                        defaultValue: "For example, a personal account alongside a work account.",
                        table: "TermLoop"
                    )
                ) {
                    Button(String(
                        localized: "claude.account.add.button",
                        defaultValue: "Add Account…",
                        table: "TermLoop"
                    )) {
                        addingClaudeAccount = true
                    }
                    .controlSize(.small)
                }
            }
        }
    }

    private func claudeAccountSubtitle(for profile: ClaudeCredentialProfile) -> String {
        let hasToken = claudeCredentialStore.hasToken(forProfileId: profile.id)
        if hasToken {
            return String(
                localized: "claude.account.subtitle.tokenSet",
                defaultValue: "id: \(profile.id) · token stored in Keychain",
                table: "TermLoop"
            )
        }
        return String(
            localized: "claude.account.subtitle.noToken",
            defaultValue: "id: \(profile.id) · no token saved — Claude will fall back to ~/.claude/",
            table: "TermLoop"
        )
    }

    // MARK: Git hosting

    @ViewBuilder
    private var gitHostAuthSection: some View {
        TermLoopSettingsSectionHeader(
            title: String(
                localized: "termloop.settings.section.gitHosting",
                defaultValue: "Git Hosting",
                table: "TermLoop"
            )
        )

        TermLoopSettingsCard {
            TermLoopSettingsCardRow(
                title: String(
                    localized: "gitHost.settings.azurePAT.label",
                    defaultValue: "Azure DevOps PAT fallback",
                    table: "TermLoop"
                ),
                subtitle: gitHostAuthMessage ?? String(
                    localized: "gitHost.settings.azurePAT.subtitle",
                    defaultValue: "Used only when silent GCM / Azure CLI auth is unavailable. Scope is the Azure DevOps organization.",
                    table: "TermLoop"
                )
            ) {
                VStack(alignment: .trailing, spacing: 6) {
                    TextField(
                        String(
                            localized: "gitHost.settings.azureOrg.placeholder",
                            defaultValue: "organization",
                            table: "TermLoop"
                        ),
                        text: $azureDevOpsOrganization
                    )
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 180)

                    SecureField(
                        String(
                            localized: "gitHost.settings.azurePAT.placeholder",
                            defaultValue: "Personal Access Token",
                            table: "TermLoop"
                        ),
                        text: $azureDevOpsPAT
                    )
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 180)

                    HStack(spacing: 8) {
                        Button(String(
                            localized: "gitHost.settings.azurePAT.clear",
                            defaultValue: "Clear",
                            table: "TermLoop"
                        )) {
                            clearAzureDevOpsPAT()
                        }
                        .controlSize(.small)
                        .disabled(azureDevOpsOrganization.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                        Button(String(
                            localized: "gitHost.settings.azurePAT.save",
                            defaultValue: "Save",
                            table: "TermLoop"
                        )) {
                            saveAzureDevOpsPAT()
                        }
                        .controlSize(.small)
                        .disabled(
                            azureDevOpsOrganization.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || azureDevOpsPAT.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        )
                    }
                }
            }
        }
    }

    private func saveAzureDevOpsPAT() {
        let organization = azureDevOpsOrganization.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = azureDevOpsPAT.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !organization.isEmpty, !token.isEmpty else { return }
        do {
            try GitHostPATStore.saveToken(token, host: .azureDevOps, scope: organization)
            azureDevOpsPAT = ""
            gitHostAuthMessage = String(
                localized: "gitHost.settings.azurePAT.saved",
                defaultValue: "Saved Azure DevOps token in Keychain.",
                table: "TermLoop"
            )
        } catch {
            gitHostAuthMessage = error.localizedDescription
        }
    }

    private func clearAzureDevOpsPAT() {
        let organization = azureDevOpsOrganization.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !organization.isEmpty else { return }
        do {
            try GitHostPATStore.clearToken(host: .azureDevOps, scope: organization)
            azureDevOpsPAT = ""
            gitHostAuthMessage = String(
                localized: "gitHost.settings.azurePAT.cleared",
                defaultValue: "Cleared Azure DevOps token from Keychain.",
                table: "TermLoop"
            )
        } catch {
            gitHostAuthMessage = error.localizedDescription
        }
    }

    // MARK: Quick Action

    @ViewBuilder
    private var quickActionSection: some View {
        TermLoopSettingsSectionHeader(
            title: String(
                localized: "termloop.settings.section.quickAction",
                defaultValue: "Quick Action",
                table: "TermLoop"
            )
        )

        TermLoopSettingsCard {
            TermLoopSettingsCardRow(
                title: String(
                    localized: "quickAction.settings.enabled.label",
                    defaultValue: "Enable Quick Action",
                    table: "TermLoop"
                ),
                subtitle: quickActionEnabled
                    ? String(
                        localized: "quickAction.settings.enabled.subtitleOn",
                        defaultValue: "Press Shift twice to open the agent palette from anywhere.",
                        table: "TermLoop"
                    )
                    : String(
                        localized: "quickAction.settings.enabled.subtitleOff",
                        defaultValue: "Double-Shift is ignored while Quick Action is disabled.",
                        table: "TermLoop"
                    )
            ) {
                Toggle("", isOn: $quickActionEnabled)
                    .labelsHidden()
                    .controlSize(.small)
            }

            TermLoopSettingsCardDivider()

            TermLoopSettingsCardRow(
                title: String(
                    localized: "quickAction.settings.trigger.label",
                    defaultValue: "Trigger",
                    table: "TermLoop"
                ),
                subtitle: String(
                    localized: "quickAction.settings.trigger.subtitle",
                    defaultValue: "Double-Shift is the only trigger in this version.",
                    table: "TermLoop"
                )
            ) {
                Text(String(
                    localized: "quickAction.settings.trigger.doubleShift",
                    defaultValue: "Double Shift",
                    table: "TermLoop"
                ))
                .font(.caption)
                .foregroundColor(.secondary)
            }

            TermLoopSettingsCardDivider()

            TermLoopSettingsCardRow(
                title: String(
                    localized: "quickAction.settings.accessibility.label",
                    defaultValue: "Accessibility access",
                    table: "TermLoop"
                ),
                subtitle: AXIsProcessTrusted()
                    ? String(
                        localized: "quickAction.settings.accessibility.subtitleGranted",
                        defaultValue: "Granted — Quick Action works when TermLoop is a background app.",
                        table: "TermLoop"
                    )
                    : String(
                        localized: "quickAction.settings.accessibility.subtitleMissing",
                        defaultValue: "Not granted — Quick Action only works while TermLoop is frontmost.",
                        table: "TermLoop"
                    )
            ) {
                if AXIsProcessTrusted() {
                    Text("✓")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.secondary)
                } else {
                    Button(String(
                        localized: "quickAction.settings.accessibility.grantButton",
                        defaultValue: "Grant…",
                        table: "TermLoop"
                    )) {
                        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                        if let url { NSWorkspace.shared.open(url) }
                    }
                    .controlSize(.small)
                }
            }

            TermLoopSettingsCardDivider()

            TermLoopSettingsCardRow(
                title: String(
                    localized: "quickAction.settings.defaultTemplate.label",
                    defaultValue: "Fallback agent for free prompts",
                    table: "TermLoop"
                ),
                subtitle: String(
                    localized: "quickAction.settings.defaultTemplate.subtitle",
                    defaultValue: "Used only when Free Prompt Template is unavailable.",
                    table: "TermLoop"
                )
            ) {
                Picker("", selection: $quickActionDefaultTemplateId) {
                    Text(String(
                        localized: "quickAction.settings.defaultTemplate.unset",
                        defaultValue: "— First available —",
                        table: "TermLoop"
                    )).tag("")
                    ForEach(templateStore.templates, id: \.id) { tpl in
                        Text(tpl.name).tag(tpl.id)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 220)
            }

            TermLoopSettingsCardDivider()

            TermLoopSettingsCardRow(
                title: String(
                    localized: "quickAction.settings.window.label",
                    defaultValue: "Double-Shift window",
                    table: "TermLoop"
                ),
                subtitle: String(
                    localized: "quickAction.settings.window.subtitle",
                    defaultValue: "Maximum milliseconds between the two Shift presses.",
                    table: "TermLoop"
                )
            ) {
                Stepper(value: $quickActionWindowMs, in: QuickActionSettings.minDoubleShiftWindowMs...QuickActionSettings.maxDoubleShiftWindowMs, step: 25) {
                    Text("\(quickActionWindowMs) ms")
                        .font(.caption)
                        .monospacedDigit()
                }
                .controlSize(.small)
            }

            TermLoopSettingsCardDivider()

            TermLoopSettingsCardRow(
                title: String(
                    localized: "quickAction.settings.excludedApps.label",
                    defaultValue: "Excluded apps",
                    table: "TermLoop"
                ),
                subtitle: String(
                    localized: "quickAction.settings.excludedApps.subtitle",
                    defaultValue: "Double-Shift is ignored when these apps are frontmost. Edit the list in settings.json for now.",
                    table: "TermLoop"
                )
            ) {
                Text("\(currentExcludedBundleCount)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .id(excludedBundlesRefreshTick)
            }

            TermLoopSettingsCardDivider()

            TermLoopSettingsCardRow(
                title: String(
                    localized: "quickAction.settings.resetLRU.label",
                    defaultValue: "Reset recent agents",
                    table: "TermLoop"
                ),
                subtitle: String(
                    localized: "quickAction.settings.resetLRU.subtitle",
                    defaultValue: "Clears the most-recently-used order and remembered advanced values.",
                    table: "TermLoop"
                )
            ) {
                Button(String(
                    localized: "quickAction.settings.resetLRU.button",
                    defaultValue: "Reset",
                    table: "TermLoop"
                )) {
                    QuickActionLRUStore.shared.resetAll()
                }
                .controlSize(.small)
            }
        }
    }

    private var currentExcludedBundleCount: Int {
        QuickActionSettings.excludedBundleIdentifiers().count
    }
}

private struct TermLoopSettingsSectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.leading, 2)
    }
}

private struct TermLoopSettingsCard<Content: View>: View {
    @ViewBuilder let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .background(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color(nsColor: NSColor.controlBackgroundColor).opacity(0.76))
                .overlay(
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .stroke(Color(nsColor: NSColor.separatorColor).opacity(0.5), lineWidth: 1)
                )
        )
    }
}

private struct TermLoopSettingsCardRow<Trailing: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder let trailing: Trailing

    init(
        title: String,
        subtitle: String? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: subtitle == nil ? 0 : 3) {
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
                .layoutPriority(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct TermLoopSettingsCardDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color(nsColor: NSColor.separatorColor).opacity(0.5))
            .frame(height: 1)
    }
}

private struct TermLoopSettingsCardNote: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundColor(.secondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Claude Account editor sheet

private struct ClaudeAccountEditorSheet: View {
    let editing: ClaudeCredentialProfile?
    @Binding var isPresented: Bool

    @ObservedObject private var store = ClaudeCredentialStore.shared

    @State private var profileId: String = ""
    @State private var displayName: String = ""
    @State private var token: String = ""
    @State private var replaceToken: Bool = false
    @State private var errorMessage: String?

    private var isEditing: Bool { editing != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(isEditing
                 ? String(
                    localized: "claude.account.editor.title.edit",
                    defaultValue: "Edit Claude Account",
                    table: "TermLoop"
                   )
                 : String(
                    localized: "claude.account.editor.title.add",
                    defaultValue: "Add Claude Account",
                    table: "TermLoop"
                   )
            )
            .font(.system(size: 14, weight: .semibold))

            VStack(alignment: .leading, spacing: 4) {
                Text(String(
                    localized: "claude.account.editor.id.label",
                    defaultValue: "Profile id",
                    table: "TermLoop"
                ))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                TextField(
                    String(
                        localized: "claude.account.editor.id.placeholder",
                        defaultValue: "e.g. work, personal",
                        table: "TermLoop"
                    ),
                    text: $profileId
                )
                .textFieldStyle(.roundedBorder)
                .disabled(isEditing)
                if !isEditing {
                    Text(String(
                        localized: "claude.account.editor.id.hint",
                        defaultValue: "Lowercase letters, digits, dashes, or underscores. Cannot be changed later.",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(String(
                    localized: "claude.account.editor.displayName.label",
                    defaultValue: "Display name",
                    table: "TermLoop"
                ))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                TextField(
                    String(
                        localized: "claude.account.editor.displayName.placeholder",
                        defaultValue: "Shown in Settings and project pickers",
                        table: "TermLoop"
                    ),
                    text: $displayName
                )
                .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                if isEditing {
                    Toggle(String(
                        localized: "claude.account.editor.replaceToken.label",
                        defaultValue: "Replace stored token",
                        table: "TermLoop"
                    ), isOn: $replaceToken)
                    .controlSize(.small)
                }

                if !isEditing || replaceToken {
                    Text(String(
                        localized: "claude.account.editor.token.label",
                        defaultValue: "Token (CLAUDE_CODE_OAUTH_TOKEN)",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    SecureField(
                        String(
                            localized: "claude.account.editor.token.placeholder",
                            defaultValue: "sk-ant-oat01-…",
                            table: "TermLoop"
                        ),
                        text: $token
                    )
                    .textFieldStyle(.roundedBorder)
                    Text(String(
                        localized: "claude.account.editor.token.hint",
                        defaultValue: "Run `claude setup-token` in a Terminal while logged into the desired account, then paste the token here. The token is stored in your macOS Keychain.",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }

            HStack {
                Spacer()
                Button(String(
                    localized: "claude.account.editor.cancel",
                    defaultValue: "Cancel",
                    table: "TermLoop"
                )) {
                    isPresented = false
                }
                .keyboardShortcut(.cancelAction)
                Button(isEditing
                       ? String(
                            localized: "claude.account.editor.save",
                            defaultValue: "Save",
                            table: "TermLoop"
                         )
                       : String(
                            localized: "claude.account.editor.add",
                            defaultValue: "Add",
                            table: "TermLoop"
                         )
                ) {
                    submit()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear {
            if let editing {
                profileId = editing.id
                displayName = editing.displayName
            }
        }
    }

    private var canSubmit: Bool {
        if isEditing {
            return !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && (!replaceToken || !token.isEmpty)
        }
        let trimmedId = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmedId.isEmpty && !token.isEmpty
    }

    private func submit() {
        do {
            if let editing {
                try store.rename(id: editing.id, newDisplayName: displayName)
                if replaceToken, !token.isEmpty {
                    try store.updateToken(id: editing.id, token: token)
                }
            } else {
                _ = try store.addProfile(
                    id: profileId,
                    displayName: displayName,
                    token: token
                )
            }
            isPresented = false
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Compact header shown at the top of the sidebar. Displays the active
/// project and provides a menu for switching / creating / renaming /
/// deleting projects.
struct ProjectSwitcherStrip: View {
    @ObservedObject private var projectStore = ProjectStore.shared
    @ObservedObject private var refreshCoordinator = SidebarProjectRefreshCoordinator.shared
    @ObservedObject private var keyboardShortcutSettingsObserver = KeyboardShortcutSettingsObserver.shared
    @EnvironmentObject private var tabManager: TabManager
    @AppStorage(ShortcutHintDebugSettings.alwaysShowHintsKey)
    private var alwaysShowShortcutHints = ShortcutHintDebugSettings.defaultAlwaysShowHints
    @StateObject private var shortcutHintMonitor = ProjectSwitcherShortcutHintMonitor()

    @State private var sheet: ActiveSheet?
    @State private var deleteCandidate: Project?
    @State private var branchTick = 0
    @State private var projectTitleWidth: CGFloat = 0

    private enum ActiveSheet: Identifiable {
        case create
        case rename(Project)

        var id: String {
            switch self {
            case .create: return "create"
            case .rename(let project): return "rename-\(project.id.uuidString)"
            }
        }
    }

    var body: some View {
        let _ = branchTick
        HStack(alignment: .center, spacing: 10) {
            Menu {
                projectListSection
                Divider()
                Button {
                    sheet = .create
                } label: {
                    Label(
                        String(
                            localized: "project.menu.new",
                            defaultValue: "New Project…", table: "TermLoop"
                        ),
                        systemImage: "plus"
                    )
                }
                if let active = activeProject {
                    Button {
                        sheet = .rename(active)
                    } label: {
                        Label(
                            String(
                                localized: "project.menu.edit",
                                defaultValue: "Edit Project…", table: "TermLoop"
                            ),
                            systemImage: "pencil"
                        )
                    }
                    if projectStore.projects.count > 1 {
                        Button(role: .destructive) {
                            deleteCandidate = active
                        } label: {
                            Label(
                                String(
                                    localized: "project.menu.delete",
                                    defaultValue: "Delete Project…", table: "TermLoop"
                                ),
                                systemImage: "trash"
                            )
                        }
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(projectTitleText)
                            .font(TermLoopSidebarTheme.headerLabel)
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .layoutPriority(1)
                            .background(
                                GeometryReader { proxy in
                                    Color.clear.preference(
                                        key: ProjectSwitcherTitleWidthPreferenceKey.self,
                                        value: proxy.size.width
                                    )
                                }
                            )

#if DEBUG
                            Text(verbatim: "DEV")
                                .font(TermLoopSidebarTheme.microCaps)
                                .foregroundStyle(TermLoopSidebarTheme.accent)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .overlay(
                                    Rectangle()
                                        .stroke(TermLoopSidebarTheme.accent.opacity(0.55), lineWidth: 1)
                                )
#endif
                        }

                        if let path = activeProject?.folderPath, !path.isEmpty {
                            Text(verbatim: abbreviatedPath(path))
                                .font(TermLoopSidebarTheme.tinyMono)
                                .foregroundStyle(TermLoopSidebarTheme.dimmer)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }

                    Spacer(minLength: 4)

                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(activeProject?.folderPath ?? "")
            .accessibilityIdentifier("ProjectSwitcherStrip.Menu")
            .overlay(alignment: .topLeading) {
                if showsProjectShortcutHint, let projectShortcutLabel {
                    ShortcutHintPill(text: projectShortcutLabel, fontSize: 10, emphasis: 0.9)
                        .offset(x: projectTitleWidth + 6, y: 0)
                        .transition(.opacity)
                        .allowsHitTesting(false)
                        .accessibilityIdentifier("ProjectSwitcherStrip.ShortcutHint")
                }
            }
            .animation(.easeOut(duration: 0.12), value: showsProjectShortcutHint)

            refreshButton
        }
        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .sheet(item: $sheet) { active in
            switch active {
            case .create:
                CreateProjectSheet(isPresented: Binding(
                    get: { sheet != nil },
                    set: { if !$0 { sheet = nil } }
                ))
            case .rename(let project):
                RenameProjectSheet(
                    project: project,
                    isPresented: Binding(
                        get: { sheet != nil },
                        set: { if !$0 { sheet = nil } }
                    )
                )
            }
        }
        .confirmationDialog(
            deleteTitle,
            isPresented: Binding(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }
            ),
            presenting: deleteCandidate
        ) { project in
            Button(
                String(
                    localized: "project.delete.cascade",
                    defaultValue: "Delete Project and Close Workspaces", table: "TermLoop"
                ),
                role: .destructive
            ) {
                performDelete(project: project)
            }
            Button(
                String(
                    localized: "project.delete.cancel",
                    defaultValue: "Cancel", table: "TermLoop"
                ),
                role: .cancel
            ) {
                deleteCandidate = nil
            }
        } message: { project in
            Text(String(
                localized: "project.delete.message",
                defaultValue: "Deleting “\(project.name)” cannot be undone.", table: "TermLoop"
            ))
        }
        .onReceive(WorkspaceMetadataStore.shared.$branchVersion) { newValue in
            branchTick = newValue
        }
        .background(
            WindowAccessor { window in
                shortcutHintMonitor.setHostWindow(window)
            }
            .frame(width: 0, height: 0)
        )
        .onAppear {
            shortcutHintMonitor.start()
        }
        .onDisappear {
            shortcutHintMonitor.stop()
        }
        .onPreferenceChange(ProjectSwitcherTitleWidthPreferenceKey.self) { width in
            projectTitleWidth = width
        }
    }

    // MARK: - Menu contents

    @ViewBuilder
    private var projectListSection: some View {
        let active = projectStore.activeProjectId
        ForEach(projectStore.projects) { project in
            Button {
                try? projectStore.setActive(id: project.id)
                selectFirstWorkspaceForActiveProject()
            } label: {
                if project.id == active {
                    Label(project.name, systemImage: "checkmark")
                } else {
                    Text(project.name)
                }
            }
        }
    }

    // MARK: - Helpers

    private var refreshButton: some View {
        Button {
            refreshCoordinator.refresh(tabManager: tabManager)
        } label: {
            ZStack {
                if refreshCoordinator.isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.55)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                }
            }
            .frame(width: 22, height: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(activeProject == nil || refreshCoordinator.isRefreshing)
        .help(String(
            localized: "project.refresh.help",
            defaultValue: "Refresh Git and PR status",
            table: "TermLoop"
        ))
        .accessibilityLabel(String(
            localized: "project.refresh.accessibilityLabel",
            defaultValue: "Refresh project status",
            table: "TermLoop"
        ))
        .accessibilityIdentifier("ProjectSwitcherStrip.RefreshButton")
    }

    private var activeProject: Project? {
        guard let id = projectStore.activeProjectId else { return nil }
        return projectStore.project(id: id)
    }

    private var projectTitleText: AttributedString {
        TermLoopSidebarTheme.caps(
            activeProject?.name ?? String(
                localized: "project.switcher.none",
                defaultValue: "No Project",
                table: "TermLoop"
            )
        )
    }

    private var projectShortcutLabel: String? {
        let _ = keyboardShortcutSettingsObserver.revision
        guard let activeProject,
              let index = projectStore.projects.firstIndex(where: { $0.id == activeProject.id }),
              let digit = ProjectShortcutRouter.digitForProject(
                at: index,
                projectCount: projectStore.projects.count
              ) else { return nil }
        let shortcut = KeyboardShortcutSettings.shortcut(for: .selectProjectByNumber)
        return "\(shortcut.numberedDigitHintPrefix)\(digit)"
    }

    private var showsProjectShortcutHint: Bool {
        (shortcutHintMonitor.isCommandPressed || alwaysShowShortcutHints) && projectShortcutLabel != nil
    }

    private var deleteTitle: String {
        guard let project = deleteCandidate else {
            return String(
                localized: "project.delete.title.generic",
                defaultValue: "Delete Project", table: "TermLoop"
            )
        }
        return String(
            localized: "project.delete.title",
            defaultValue: "Delete “\(project.name)”?", table: "TermLoop"
        )
    }

    private func performDelete(project: Project) {
        let appDelegate = NSApp.delegate as? AppDelegate
        do {
            try projectStore.delete(id: project.id)
            appDelegate?.closeWorkspaces(inProjectId: project.id)
            selectFirstWorkspaceForActiveProject()
        } catch {
            ProjectStore.presentError(error)
        }
        deleteCandidate = nil
    }

    private func selectFirstWorkspaceForActiveProject() {
        guard let activeId = projectStore.activeProjectId else { return }
        if let current = tabManager.selectedTabId,
           let tab = tabManager.tabs.first(where: { $0.id == current }),
           tab.projectId == activeId {
            return
        }
        if let first = tabManager.tabs.first(where: { $0.projectId == activeId }) {
            tabManager.selectedTabId = first.id
        }
    }

    /// Replace the user's home directory prefix with `~` so the subtitle
    /// stays legible in a narrow sidebar. The full path is still exposed via
    /// `.help(...)` on the menu label.
    private func abbreviatedPath(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

}

private struct ProjectSwitcherTitleWidthPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

@MainActor
private final class ProjectSwitcherShortcutHintMonitor: ObservableObject {
    @Published private(set) var isCommandPressed = false

    private weak var hostWindow: NSWindow?
    private var hostWindowDidBecomeKeyObserver: NSObjectProtocol?
    private var hostWindowDidResignKeyObserver: NSObjectProtocol?
    private var flagsMonitor: Any?
    private var keyDownMonitor: Any?
    private var appResignObserver: NSObjectProtocol?

    func setHostWindow(_ window: NSWindow?) {
        guard hostWindow !== window else { return }
        removeHostWindowObservers()
        hostWindow = window
        guard let window else {
            reset()
            return
        }

        hostWindowDidBecomeKeyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.update(from: NSEvent.modifierFlags, eventWindow: nil)
            }
        }

        hostWindowDidResignKeyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.reset()
            }
        }

        update(from: NSEvent.modifierFlags, eventWindow: nil)
    }

    func start() {
        guard flagsMonitor == nil else {
            update(from: NSEvent.modifierFlags, eventWindow: nil)
            return
        }

        flagsMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.update(from: event.modifierFlags, eventWindow: event.window)
            return event
        }

        keyDownMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard self?.isCurrentWindow(eventWindow: event.window) == true else { return event }
            self?.reset()
            return event
        }

        appResignObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.reset()
            }
        }

        update(from: NSEvent.modifierFlags, eventWindow: nil)
    }

    func stop() {
        if let flagsMonitor {
            NSEvent.removeMonitor(flagsMonitor)
            self.flagsMonitor = nil
        }
        if let keyDownMonitor {
            NSEvent.removeMonitor(keyDownMonitor)
            self.keyDownMonitor = nil
        }
        if let appResignObserver {
            NotificationCenter.default.removeObserver(appResignObserver)
            self.appResignObserver = nil
        }
        removeHostWindowObservers()
        reset()
    }

    private func update(from modifierFlags: NSEvent.ModifierFlags, eventWindow: NSWindow?) {
        isCommandPressed = isCurrentWindow(eventWindow: eventWindow)
            && ShortcutHintModifierPolicy.shouldShowHints(for: modifierFlags)
    }

    private func isCurrentWindow(eventWindow: NSWindow?) -> Bool {
        ShortcutHintModifierPolicy.isCurrentWindow(
            hostWindowNumber: hostWindow?.windowNumber,
            hostWindowIsKey: hostWindow?.isKeyWindow ?? false,
            eventWindowNumber: eventWindow?.windowNumber,
            keyWindowNumber: NSApp.keyWindow?.windowNumber
        )
    }

    private func reset() {
        isCommandPressed = false
    }

    private func removeHostWindowObservers() {
        if let hostWindowDidBecomeKeyObserver {
            NotificationCenter.default.removeObserver(hostWindowDidBecomeKeyObserver)
            self.hostWindowDidBecomeKeyObserver = nil
        }
        if let hostWindowDidResignKeyObserver {
            NotificationCenter.default.removeObserver(hostWindowDidResignKeyObserver)
            self.hostWindowDidResignKeyObserver = nil
        }
    }
}

// MARK: - Create sheet

struct CreateProjectSheet: View {
    @Binding var isPresented: Bool
    @ObservedObject private var projectStore = ProjectStore.shared

    @AppStorage(ProjectStore.lastParentDirectoryDefaultsKey) private var lastProjectParentDir: String = ""

    @State private var name: String = ""
    @State private var folderPath: String = ""
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(String(
                localized: "project.create.title",
                defaultValue: "New Project", table: "TermLoop"
            ))
            .font(.system(size: 14, weight: .semibold))

            VStack(alignment: .leading, spacing: 4) {
                Text(String(
                    localized: "project.field.name",
                    defaultValue: "Name", table: "TermLoop"
                ))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                TextField("", text: $name)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(String(
                    localized: "project.field.folder",
                    defaultValue: "Folder", table: "TermLoop"
                ))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    TextField("", text: $folderPath)
                        .textFieldStyle(.roundedBorder)
                    Button(String(
                        localized: "project.field.folder.browse",
                        defaultValue: "Choose…", table: "TermLoop"
                    )) {
                        chooseFolder()
                    }
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
                    localized: "project.button.cancel",
                    defaultValue: "Cancel", table: "TermLoop"
                )) {
                    isPresented = false
                }
                .keyboardShortcut(.cancelAction)
                Button(String(
                    localized: "project.button.create",
                    defaultValue: "Create", table: "TermLoop"
                )) {
                    submit()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 420)
        .onAppear {
            if folderPath.isEmpty {
                folderPath = lastProjectParentDir.isEmpty
                    ? ProjectStore.defaultParentDirectory()
                    : lastProjectParentDir
            }
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        let initialDir: String = {
            if !folderPath.isEmpty { return folderPath }
            if !lastProjectParentDir.isEmpty { return lastProjectParentDir }
            return ProjectStore.defaultParentDirectory()
        }()
        panel.directoryURL = URL(fileURLWithPath: (initialDir as NSString).expandingTildeInPath)
        if panel.runModal() == .OK, let url = panel.url {
            folderPath = url.path
        }
    }

    private func submit() {
        do {
            _ = try projectStore.create(name: name, folderPath: folderPath)
            let parent = URL(fileURLWithPath: (folderPath as NSString).expandingTildeInPath)
                .deletingLastPathComponent().path
            if !parent.isEmpty, parent != "/" {
                lastProjectParentDir = parent
            }
            isPresented = false
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// MARK: - Rename sheet

private struct RenameProjectSheet: View {
    let project: Project
    @Binding var isPresented: Bool
    @ObservedObject private var projectStore = ProjectStore.shared
    @ObservedObject private var credentialStore = ClaudeCredentialStore.shared

    @State private var name: String
    @State private var folderPath: String
    @State private var claudeProfileId: String
    @State private var errorMessage: String?

    private static let inheritProfileTag = "__inherit__"

    init(project: Project, isPresented: Binding<Bool>) {
        self.project = project
        self._isPresented = isPresented
        self._name = State(initialValue: project.name)
        self._folderPath = State(initialValue: project.folderPath)
        self._claudeProfileId = State(
            initialValue: project.claudeCredentialProfileId ?? Self.inheritProfileTag
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(String(
                localized: "project.rename.title",
                defaultValue: "Edit Project", table: "TermLoop"
            ))
            .font(.system(size: 14, weight: .semibold))

            VStack(alignment: .leading, spacing: 4) {
                Text(String(
                    localized: "project.field.name",
                    defaultValue: "Name", table: "TermLoop"
                ))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                TextField("", text: $name)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(String(
                    localized: "project.field.folder",
                    defaultValue: "Folder", table: "TermLoop"
                ))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    TextField("", text: $folderPath)
                        .textFieldStyle(.roundedBorder)
                    Button(String(
                        localized: "project.field.folder.browse",
                        defaultValue: "Choose…", table: "TermLoop"
                    )) {
                        chooseFolder()
                    }
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(String(
                    localized: "project.field.claudeAccount",
                    defaultValue: "Claude account", table: "TermLoop"
                ))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                Picker("", selection: $claudeProfileId) {
                    Text(String(
                        localized: "project.field.claudeAccount.inherit",
                        defaultValue: "Use ~/.claude/ (default login)",
                        table: "TermLoop"
                    )).tag(Self.inheritProfileTag)
                    ForEach(credentialStore.profiles) { profile in
                        Text(profileLabel(profile)).tag(profile.id)
                    }
                }
                .labelsHidden()
                if claudeProfileId != Self.inheritProfileTag,
                   !credentialStore.hasToken(forProfileId: claudeProfileId) {
                    Text(String(
                        localized: "project.field.claudeAccount.missingToken",
                        defaultValue: "⚠ Selected account has no token saved. Add one in Settings → Claude Accounts, otherwise Claude will fall back to your default login.",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 10))
                    .foregroundStyle(.orange)
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
                    localized: "project.button.cancel",
                    defaultValue: "Cancel", table: "TermLoop"
                )) {
                    isPresented = false
                }
                .keyboardShortcut(.cancelAction)
                Button(String(
                    localized: "project.button.save",
                    defaultValue: "Save", table: "TermLoop"
                )) {
                    submit()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func profileLabel(_ profile: ClaudeCredentialProfile) -> String {
        let name = profile.displayName == profile.id
            ? profile.displayName
            : "\(profile.displayName) (\(profile.id))"
        if credentialStore.hasToken(forProfileId: profile.id) {
            return name
        }
        return name + " — " + String(
            localized: "project.field.claudeAccount.noTokenSuffix",
            defaultValue: "no token",
            table: "TermLoop"
        )
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: (folderPath as NSString).expandingTildeInPath)
        if panel.runModal() == .OK, let url = panel.url {
            folderPath = url.path
        }
    }

    private func submit() {
        do {
            if name != project.name {
                try projectStore.rename(id: project.id, newName: name)
            }
            if folderPath != project.folderPath {
                try projectStore.updateFolder(id: project.id, newPath: folderPath)
            }
            let resolvedProfileId: String? = claudeProfileId == Self.inheritProfileTag ? nil : claudeProfileId
            if resolvedProfileId != project.claudeCredentialProfileId {
                projectStore.setClaudeCredentialProfileId(resolvedProfileId, project: project.id)
            }
            isPresented = false
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

// MARK: - Footer button

struct SidebarSkillsCommandsButton: View {
    private let title = String(
        localized: "sidebar.skillsAndCommands.button",
        defaultValue: "Skills & Commands"
    )
    private let buttonSize: CGFloat = 22
    private let iconSize: CGFloat = 11

    @State private var isPopoverPresented = false
    @ObservedObject private var projectStore = ProjectStore.shared

    var body: some View {
        Button {
            isPopoverPresented.toggle()
        } label: {
            Image(systemName: "sparkles")
                .symbolRenderingMode(.monochrome)
                .font(.system(size: iconSize, weight: .medium))
                .foregroundStyle(Color(nsColor: .secondaryLabelColor))
                .frame(width: buttonSize, height: buttonSize, alignment: .center)
        }
        .buttonStyle(SidebarSkillsCommandsFooterButtonStyle())
        .frame(width: buttonSize, height: buttonSize, alignment: .center)
        .background(SidebarSkillsCommandsPopoverHost(
            isPresented: $isPopoverPresented,
            projectFolderURL: activeProjectURL
        ))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityIdentifier("SidebarSkillsCommandsButton")
        .help(title)
    }

    private var activeProjectURL: URL? {
        guard let id = projectStore.activeProjectId,
              let project = projectStore.project(id: id) else { return nil }
        return URL(fileURLWithPath: project.folderPath, isDirectory: true)
    }
}

private struct SidebarSkillsCommandsFooterButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        SidebarSkillsCommandsFooterButtonBody(configuration: configuration)
    }
}

private struct SidebarSkillsCommandsFooterButtonBody: View {
    let configuration: SidebarSkillsCommandsFooterButtonStyle.Configuration
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    private var backgroundOpacity: Double {
        guard isEnabled else { return 0.0 }
        if configuration.isPressed { return 0.16 }
        if isHovered { return 0.08 }
        return 0.0
    }

    var body: some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(backgroundOpacity))
            )
            .onHover { isHovered = $0 }
            .animation(.easeOut(duration: 0.12), value: isHovered)
            .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
    }
}

// MARK: - Popover host (AppKit bridge)

/// Carries the active project URL into the popover's SwiftUI content.
/// Using an ObservableObject lets the content react to project changes
/// without rebuilding the root view (which would reset `@StateObject`).
/// Only mutated on the main thread via NSViewRepresentable callbacks.
final class SkillsCommandsPopoverContext: ObservableObject {
    @Published var projectFolderURL: URL?
    init(projectFolderURL: URL?) { self.projectFolderURL = projectFolderURL }
}

private struct SidebarSkillsCommandsPopoverHost: NSViewRepresentable {
    @Binding var isPresented: Bool
    let projectFolderURL: URL?

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        context.coordinator.anchorView = view
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.anchorView = nsView
        context.coordinator.context.projectFolderURL = projectFolderURL
        if isPresented {
            context.coordinator.present()
        } else {
            context.coordinator.dismiss()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(isPresented: $isPresented, initialURL: projectFolderURL)
    }

    @MainActor
    final class Coordinator: NSObject, NSPopoverDelegate {
        @Binding var isPresented: Bool
        weak var anchorView: NSView?
        let context: SkillsCommandsPopoverContext
        // Owned here so present() can trigger refresh directly;
        // onAppear is unreliable for NSHostingController+NSPopover.
        let catalog = SkillCatalog()
        private var popover: NSPopover?
        // Lazy so catalog is fully initialised before the view is built.
        private lazy var hosting: NSHostingController<AnyView> = {
            NSHostingController(
                rootView: AnyView(SkillsCommandsPopoverView(context: context, catalog: catalog))
            )
        }()

        init(isPresented: Binding<Bool>, initialURL: URL?) {
            _isPresented = isPresented
            let ctx = SkillsCommandsPopoverContext(projectFolderURL: initialURL)
            self.context = ctx
        }

        func present() {
            guard let anchorView else {
                isPresented = false
                return
            }
            let popover = popover ?? makePopover()
            if popover.isShown { return }
            // Trigger refresh here because onAppear is not reliable for
            // NSHostingController content inside NSPopover on macOS.
            catalog.refresh(projectFolderPath: context.projectFolderURL)
            popover.contentSize = NSSize(width: 520, height: 420)
            popover.show(
                relativeTo: anchorView.bounds,
                of: anchorView,
                preferredEdge: .maxY
            )
        }

        func dismiss() {
            popover?.performClose(nil)
            popover = nil
        }

        func popoverDidClose(_ notification: Notification) {
            popover = nil
            if isPresented { isPresented = false }
        }

        private func makePopover() -> NSPopover {
            let popover = NSPopover()
            popover.behavior = .transient
            popover.animates = true
            popover.contentViewController = hosting
            popover.delegate = self
            self.popover = popover
            return popover
        }
    }
}

// MARK: - Popover content

struct SkillsCommandsPopoverView: View {
    @ObservedObject var context: SkillsCommandsPopoverContext
    @ObservedObject var catalog: SkillCatalog

    @State private var selectedTab: SkillKind = .skill
    @State private var selectedId: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $selectedTab) {
                Text(String(localized: "sidebar.skillsAndCommands.tab.skills",
                            defaultValue: "Skills")).tag(SkillKind.skill)
                Text(String(localized: "sidebar.skillsAndCommands.tab.commands",
                            defaultValue: "Commands")).tag(SkillKind.command)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(10)

            Divider()

            HStack(spacing: 0) {
                SkillsCommandsListView(
                    entries: entries(for: selectedTab),
                    selectedId: $selectedId,
                    emptyMessage: emptyMessage(for: selectedTab)
                )
                .frame(width: 200)

                Divider()

                SkillsCommandsPreviewView(entry: selectedEntry)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: 520, height: 420)
        .onChange(of: context.projectFolderURL) { newValue in
            catalog.refresh(projectFolderPath: newValue)
            selectedId = nil
        }
        .onChange(of: catalog.skills) { _ in ensureSelection() }
        .onChange(of: catalog.commands) { _ in ensureSelection() }
        .onChange(of: selectedTab) { _ in
            selectedId = nil
            ensureSelection()
        }
    }

    private func entries(for kind: SkillKind) -> [SkillEntry] {
        switch kind {
        case .skill: return catalog.skills
        case .command: return catalog.commands
        }
    }

    private var selectedEntry: SkillEntry? {
        guard let id = selectedId else { return nil }
        return entries(for: selectedTab).first { $0.id == id }
    }

    private func ensureSelection() {
        guard selectedId == nil else { return }
        let list = entries(for: selectedTab)
        if let project = list.first(where: { $0.source == .project }) {
            selectedId = project.id
        } else if let first = list.first {
            selectedId = first.id
        }
    }

    private func emptyMessage(for kind: SkillKind) -> String {
        switch kind {
        case .skill:
            return String(
                localized: "sidebar.skillsAndCommands.empty.skills",
                defaultValue: "No skills found in project or ~/.claude/skills/."
            )
        case .command:
            return String(
                localized: "sidebar.skillsAndCommands.empty.commands",
                defaultValue: "No commands found in project or ~/.claude/commands/."
            )
        }
    }
}

private struct SkillsCommandsListView: View {
    let entries: [SkillEntry]
    @Binding var selectedId: String?
    let emptyMessage: String

    private var projectEntries: [SkillEntry] { entries.filter { $0.source == .project } }
    private var globalEntries: [SkillEntry] { entries.filter { $0.source == .global } }

    var body: some View {
        if entries.isEmpty {
            VStack {
                Spacer()
                Text(emptyMessage)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List(selection: $selectedId) {
                if !projectEntries.isEmpty {
                    Section(String(
                        localized: "sidebar.skillsAndCommands.section.project",
                        defaultValue: "Project"
                    )) {
                        ForEach(projectEntries) { row($0) }
                    }
                }
                if !globalEntries.isEmpty {
                    Section(String(
                        localized: "sidebar.skillsAndCommands.section.global",
                        defaultValue: "Global"
                    )) {
                        ForEach(globalEntries) { row($0) }
                    }
                }
            }
            .listStyle(.sidebar)
        }
    }

    @ViewBuilder
    private func row(_ entry: SkillEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(entry.displayPath)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
            if let description = entry.description, !description.isEmpty {
                Text(description)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .tag(entry.id)
    }
}

private struct SkillsCommandsPreviewView: View {
    let entry: SkillEntry?

    var body: some View {
        if let entry {
            VStack(alignment: .leading, spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(entry.name)
                            .font(.system(size: 14, weight: .semibold))
                        if let description = entry.description, !description.isEmpty {
                            Text(description)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                        Text(renderedBody(entry.body))
                            .font(.system(size: 12))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(12)
                }
                Divider()
                Text(entry.fileURL.path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            VStack {
                Spacer()
                Text(String(
                    localized: "sidebar.skillsAndCommands.preview.placeholder",
                    defaultValue: "Select an item to preview."
                ))
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func renderedBody(_ raw: String) -> AttributedString {
        if let attributed = try? AttributedString(
            markdown: raw,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return attributed
        }
        return AttributedString(raw)
    }
}

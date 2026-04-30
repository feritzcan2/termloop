// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

@MainActor
struct PlanTab: View {
    let projectRoot: URL?
    @ObservedObject private var folderSettings = PlanFolderSettings.shared

    @State private var entriesByFolder: [PlanFolderSpec: [PlanFileEntry]] = [:]
    @State private var expanded: Set<String> = []

    var body: some View {
        Group {
            if projectRoot == nil {
                emptyState(
                    title: String(localized: "plan.empty.no-project.title",
                                  defaultValue: "Select a project", table: "TermLoop"),
                    body: String(localized: "plan.empty.no-project.body",
                                 defaultValue: "Plan tab shows specs and plans from the active project.",
                                 table: "TermLoop")
                )
            } else if totalCount == 0 {
                emptyState(
                    title: String(localized: "plan.empty.no-files.title",
                                  defaultValue: "No plan files yet", table: "TermLoop"),
                    body: String(localized: "plan.empty.no-files.body",
                                 defaultValue: "Files from your configured plan folders will appear here.",
                                 table: "TermLoop")
                )
            } else {
                list
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: refreshID) { await refresh() }
    }

    private var totalCount: Int {
        entriesByFolder.values.reduce(0) { $0 + $1.count }
    }

    private var folderSpecs: [PlanFolderSpec] {
        folderSettings.folderSpecs(projectRoot: projectRoot)
    }

    private var refreshID: String {
        "\(projectRoot?.path ?? "")\n\(folderSettings.refreshSignature)"
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(folderSpecs) { folder in
                    section(for: folder)
                }
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func section(for folder: PlanFolderSpec) -> some View {
        let entries = entriesByFolder[folder] ?? []
        if !entries.isEmpty {
            let isExpanded = expanded.contains(folder.id)
            VStack(alignment: .leading, spacing: 0) {
                sectionHeader(folder, count: entries.count, isExpanded: isExpanded)
                if isExpanded {
                    ForEach(entries) { entry in
                        Button {
                            openInMarkdownEditor(entry: entry)
                        } label: {
                            PlanFileRow(entry: entry)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button(String(
                                localized: "plan.contextMenu.openInExternalEditor",
                                defaultValue: "Open in External Editor",
                                table: "TermLoop"
                            )) {
                                NSWorkspace.shared.open(entry.url)
                            }
                            Button(String(
                                localized: "plan.contextMenu.revealInFinder",
                                defaultValue: "Reveal in Finder",
                                table: "TermLoop"
                            )) {
                                NSWorkspace.shared.activateFileViewerSelecting([entry.url])
                            }
                            Divider()
                            Button(role: .destructive) {
                                confirmDelete(entry: entry)
                            } label: {
                                Text(String(
                                    localized: "plan.contextMenu.delete",
                                    defaultValue: "Move to Trash",
                                    table: "TermLoop"
                                ))
                            }
                        }
                        TermLoopSidebarRule()
                    }
                }
            }
        }
    }

    private func sectionHeader(_ folder: PlanFolderSpec, count: Int, isExpanded: Bool) -> some View {
        Button {
            if isExpanded {
                expanded.remove(folder.id)
            } else {
                expanded.insert(folder.id)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(TermLoopSidebarTheme.microCaps)
                    .frame(width: 10)
                Text(TermLoopSidebarTheme.caps(folder.sectionTitle))
                    .font(TermLoopSidebarTheme.sectionCaps)
                Text("\(count)")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundColor(TermLoopSidebarTheme.dim)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(TermLoopSidebarTheme.hoverBg)
    }

    private func emptyState(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(TermLoopSidebarTheme.bodyMonoStrong)
            Text(body)
                .font(TermLoopSidebarTheme.bodyMono)
                .foregroundColor(TermLoopSidebarTheme.dim)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func openInMarkdownEditor(entry: PlanFileEntry) {
        DocEditorStore.shared.select(
            fileURL: entry.url,
            folderName: entry.folder.sectionTitle
        )
    }

    private func confirmDelete(entry: PlanFileEntry) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "plan.alert.deleteTitle",
            defaultValue: "Move “\(entry.filename)” to Trash?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "plan.alert.deleteBody",
            defaultValue: "The file will be moved to the Trash. You can restore it from there.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "plan.alert.deleteConfirm",
            defaultValue: "Move to Trash",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "plan.alert.deleteCancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        do {
            try FileManager.default.trashItem(at: entry.url, resultingItemURL: nil)
        } catch {
            let err = NSAlert()
            err.alertStyle = .warning
            err.messageText = String(
                localized: "plan.alert.deleteErrorTitle",
                defaultValue: "Could not move file to Trash",
                table: "TermLoop"
            )
            err.informativeText = error.localizedDescription
            err.runModal()
            return
        }
        Task { await refresh() }
    }

    private func refresh() async {
        guard let root = projectRoot else {
            entriesByFolder = [:]
            return
        }
        let folders = folderSpecs
        expanded.formUnion(folders.map(\.id))
        let result = await Task.detached(priority: .userInitiated) {
            PlanFileScanner.scan(projectRoot: root, folders: folders)
        }.value
        entriesByFolder = result
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

extension Notification.Name {
    static let termLoopOpenPlanPicker = Notification.Name("termLoopOpenPlanPicker")
}

struct PlanPickerRequest: Identifiable {
    let id = UUID()
    let workspaceIds: [UUID]

    static func from(notification: Notification) -> PlanPickerRequest? {
        let info = notification.userInfo as? [String: Any] ?? [:]
        let ids = (info["workspaceIds"] as? [String] ?? [])
            .compactMap(UUID.init(uuidString:))
        guard !ids.isEmpty else { return nil }
        return PlanPickerRequest(workspaceIds: ids)
    }
}

private let pasteablePlanAgentIds: Set<String> = ["claude", "codex"]

@MainActor
private func resolvedPlanAgentId(for workspaceId: UUID) -> String? {
    TerminalAgentResolver.resolve(workspaceId: workspaceId)?.id
}

@MainActor
private func eligibleWorkspaceIds(from ids: [UUID]) -> [UUID] {
    return ids.filter { id in
        guard let agentId = resolvedPlanAgentId(for: id) else { return false }
        return pasteablePlanAgentIds.contains(agentId)
    }
}

extension TermLoopSidebar {
    /// Context-menu entry: "Select Plan…" — posts `.termLoopOpenPlanPicker`
    /// so the sidebar root presents `PlanPickerSheet`. Disabled when none of
    /// the selected workspaces have a Claude or Codex agent running.
    @MainActor
    struct SelectPlanMenuItem: View {
        let targetIds: [UUID]
        @ObservedObject private var metadata = WorkspaceMetadataStore.shared

        var body: some View {
            if !targetIds.isEmpty {
                let eligible = eligibleWorkspaceIds(from: targetIds)
                Button(String(
                    localized: "contextMenu.selectPlan",
                    defaultValue: "Select Plan…",
                    table: "TermLoop"
                )) {
                    NotificationCenter.default.post(
                        name: .termLoopOpenPlanPicker,
                        object: nil,
                        userInfo: ["workspaceIds": eligible.map(\.uuidString)]
                    )
                }
                .disabled(eligible.isEmpty)
            }
        }
    }
}

private let planPreviewMaxBytes = 64 * 1024

@MainActor
struct PlanPickerSheet: View {
    let request: PlanPickerRequest
    let projectRoot: URL?
    let tabManager: TabManager
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var folderSettings = PlanFolderSettings.shared
    @State private var entriesByFolder: [PlanFolderSpec: [PlanFileEntry]] = [:]
    @State private var selectedId: String? = nil
    @State private var previewText: String = ""
    @State private var previewLoading: Bool = false

    private var totalCount: Int {
        entriesByFolder.values.reduce(0) { $0 + $1.count }
    }

    private var selectedEntry: PlanFileEntry? {
        guard let id = selectedId else { return nil }
        return entriesByFolder.values.flatMap { $0 }.first { $0.id == id }
    }

    private var folderSpecs: [PlanFolderSpec] {
        folderSettings.folderSpecs(projectRoot: projectRoot)
    }

    private var refreshID: String {
        "\(projectRoot?.path ?? "")\n\(folderSettings.refreshSignature)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(minWidth: 780, minHeight: 480)
        .task(id: refreshID) { await refresh() }
    }

    private var header: some View {
        HStack {
            Text(String(
                localized: "planPicker.title",
                defaultValue: "Select Plan",
                table: "TermLoop"
            ))
            .font(.title3)
            .fontWeight(.semibold)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var content: some View {
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
            HStack(spacing: 0) {
                list
                    .frame(width: 320)
                Divider()
                preview
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
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
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Text(TermLoopSidebarTheme.caps(folder.sectionTitle))
                        .font(TermLoopSidebarTheme.sectionCaps)
                    Text("\(entries.count)")
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundColor(TermLoopSidebarTheme.dim)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 6)
                .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                .background(TermLoopSidebarTheme.hoverBg)

                ForEach(entries) { entry in
                    Button {
                        selectedId = entry.id
                        Task { await loadPreview(entry: entry) }
                    } label: {
                        PlanFileRow(entry: entry)
                            .background(TermLoopSidebarRowBackground(
                                isActive: selectedId == entry.id,
                                isHovering: false
                            ))
                    }
                    .buttonStyle(.plain)
                    TermLoopSidebarRule()
                }
            }
        }
    }

    @ViewBuilder
    private var preview: some View {
        if let entry = selectedEntry {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Text(entry.filename)
                        .font(TermLoopSidebarTheme.bodyMonoStrong)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                    Button {
                        NSWorkspace.shared.open(entry.url)
                    } label: {
                        Image(systemName: "arrow.up.forward.square")
                    }
                    .buttonStyle(.plain)
                    .help(String(localized: "planPicker.openInEditor",
                                 defaultValue: "Open in editor", table: "TermLoop"))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                Divider()

                if previewLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        Text(previewText)
                            .font(TermLoopSidebarTheme.bodyMono)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                }
            }
        } else {
            VStack {
                Text(String(
                    localized: "planPicker.noSelection",
                    defaultValue: "Select a plan on the left to preview.",
                    table: "TermLoop"
                ))
                .font(TermLoopSidebarTheme.bodyMono)
                .foregroundColor(TermLoopSidebarTheme.dim)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button(String(
                localized: "planPicker.close",
                defaultValue: "Close",
                table: "TermLoop"
            )) { dismiss() }
            .keyboardShortcut(.cancelAction)

            Button(String(
                localized: "planPicker.use",
                defaultValue: "Use Plan",
                table: "TermLoop"
            )) {
                guard let entry = selectedEntry else { return }
                pasteToWorkspaces(entry: entry)
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
            .disabled(selectedEntry == nil)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func emptyState(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(TermLoopSidebarTheme.bodyMonoStrong)
            Text(body)
                .font(TermLoopSidebarTheme.bodyMono)
                .foregroundColor(TermLoopSidebarTheme.dim)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func refresh() async {
        guard let root = projectRoot else {
            entriesByFolder = [:]
            return
        }
        let folders = folderSpecs
        entriesByFolder = await Task.detached(priority: .userInitiated) {
            PlanFileScanner.scan(projectRoot: root, folders: folders)
        }.value
    }

    private func loadPreview(entry: PlanFileEntry) async {
        previewLoading = true
        defer { previewLoading = false }
        let url = entry.url
        let text = await Task.detached(priority: .userInitiated) {
            readPreview(from: url)
        }.value
        guard selectedId == entry.id else { return }
        previewText = text
    }

    private func pasteToWorkspaces(entry: PlanFileEntry) {
        for workspaceId in request.workspaceIds {
            guard let workspace = tabManager.tabs.first(where: { $0.id == workspaceId }),
                  let agentId = resolvedPlanAgentId(for: workspaceId),
                  pasteablePlanAgentIds.contains(agentId),
                  let panelId = workspace.focusedPanelId ?? workspace.panels.keys.first,
                  let panel = workspace.terminalPanel(for: panelId)
            else { continue }
            let payload = pastePayload(for: agentId, path: entry.url.path)
            panel.sendText(payload)
        }
    }

    private func pastePayload(for agentId: String, path: String) -> String {
        switch agentId {
        case "claude": return "@\(path) "
        default:       return "\(path) "
        }
    }
}

private func readPreview(from url: URL) -> String {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
    defer { try? handle.close() }
    let data = (try? handle.read(upToCount: planPreviewMaxBytes)) ?? Data()
    var text = String(data: data, encoding: .utf8) ?? ""
    if data.count == planPreviewMaxBytes {
        text += "\n\n… (truncated)"
    }
    return text
}

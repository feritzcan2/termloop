// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI
import AppKit

/// Small trailing-accessory button placed inside a sidebar Epic row header.
/// Opens a popover listing past Claude Code sessions for the folder's
/// relevant cwd roots and resumes a selected one into a new tab.
struct SessionResumeButton: View {
    let cwdsProvider: () -> [String]
    @Binding var isPresented: Bool
    @EnvironmentObject private var tabManager: TabManager
    @State private var sessions: [JSONLMetadata] = []
    @State private var isLoading = false

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            Image(systemName: "clock.arrow.circlepath")
                .font(TermLoopSidebarTheme.bodyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .frame(width: 14, height: 14)
        }
        .buttonStyle(.plain)
        .help(String(
            localized: "session_resume.button_tooltip",
            defaultValue: "Resume a past Claude Code session",
            table: "TermLoop"))
        .popover(isPresented: $isPresented, arrowEdge: .trailing) {
            let scopeCwds = normalizedCwds()
            SessionResumePopover(
                scopeCwds: scopeCwds,
                sessions: sessions,
                isLoading: isLoading,
                onResume: { meta in
                    isPresented = false
                    Task { @MainActor in resume(meta) }
                },
                onCancel: { isPresented = false },
                onDelete: { meta in
                    Task { @MainActor in handleDelete(meta) }
                }
            )
            .onAppear { startLoad() }
        }
    }

    @MainActor
    private func handleDelete(_ meta: JSONLMetadata) {
        let alert = NSAlert()
        alert.messageText = String(localized: "session_resume.delete_confirm_title",
                                   defaultValue: "Delete this session?",
                                   table: "TermLoop")
        alert.informativeText = String(localized: "session_resume.delete_confirm_body",
                                       defaultValue: "The JSONL file at \(meta.path.path) will be permanently deleted.",
                                       table: "TermLoop")
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "session_resume.delete_confirm_action",
                                          defaultValue: "Delete",
                                          table: "TermLoop"))
        alert.addButton(withTitle: String(localized: "session_resume.cancel_button",
                                          defaultValue: "Cancel",
                                          table: "TermLoop"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        do {
            try ClaudeSessionScanner.shared.deleteSession(path: meta.path)
        } catch {
            NSApp.presentError(error)
            return
        }
        // Refresh: remove from local state + rescan.
        sessions.removeAll { $0.sessionId == meta.sessionId }
        startLoad()
    }

    private func startLoad() {
        let targetCwds = normalizedCwds()
        guard !targetCwds.isEmpty else {
            sessions = []
            isLoading = false
            return
        }
        isLoading = true
        Task.detached(priority: .userInitiated) {
            let results = ClaudeSessionScanner.shared.scan(cwds: targetCwds)
            await MainActor.run {
                self.sessions = results
                self.isLoading = false
            }
        }
    }

    @MainActor
    private func resume(_ meta: JSONLMetadata) {
        let command = "cmux session replay \(shellQuote(meta.path.path))"
        _ = tabManager.addWorkspace(
            workingDirectory: meta.cwd,
            initialTerminalCommand: command)
    }

    private func shellQuote(_ s: String) -> String {
        return "'" + s.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
    }

    private func normalizedCwds() -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for raw in cwdsProvider() {
            let cwd = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cwd.isEmpty, seen.insert(cwd).inserted else { continue }
            ordered.append(cwd)
        }
        return ordered
    }
}

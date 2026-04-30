// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI
import AppKit

struct SessionResumePopover: View {
    let scopeCwds: [String]
    let sessions: [JSONLMetadata]
    let isLoading: Bool
    let onResume: (JSONLMetadata) -> Void
    let onCancel: () -> Void
    let onDelete: (JSONLMetadata) -> Void

    @State private var selectedId: String?
    @State private var searchText: String = ""
    @State private var previewFilter: PreviewFilter = .user
    @ObservedObject private var metadata = WorkspaceMetadataStore.shared

    /// Session IDs currently open in a live workspace — hide these from the
    /// resume list so users don't try to resume a session that is already
    /// running in another tab (Claude Code rejects concurrent resumes of the
    /// same JSONL, and the UX is misleading).
    private var liveSessionIds: Set<String> {
        Set(metadata.ephemeralClaudeSessions.values.map { $0.sessionId })
    }

    private var visibleSessions: [JSONLMetadata] {
        let live = liveSessionIds
        guard !live.isEmpty else { return sessions }
        return sessions.filter { !live.contains($0.sessionId) }
    }

    private var defaultsKey: String? {
        let slugs = scopeCwds
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map(ClaudeSessionScanner.slug(forCwd:))
            .sorted()
        guard !slugs.isEmpty else { return nil }
        return "session_resume.lastSelected." + slugs.joined(separator: "|")
    }

    private var filtered: [JSONLMetadata] {
        let base = visibleSessions
        let q = searchText.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return base }
        return base.filter { matches($0, query: q) }
    }

    private func matches(_ m: JSONLMetadata, query: String) -> Bool {
        if m.title.localizedCaseInsensitiveContains(query) { return true }
        if m.lastUserSnippet.localizedCaseInsensitiveContains(query) { return true }
        for line in m.previewLines {
            if case .user(let t) = line,
               t.localizedCaseInsensitiveContains(query) { return true }
        }
        return false
    }

    private var selected: JSONLMetadata? {
        filtered.first { $0.sessionId == selectedId }
    }

    var body: some View {
        VStack(spacing: 0) {
            searchField
                .frame(height: 30)
                .padding(.horizontal, 10)
            Divider()
            if isLoading && sessions.isEmpty {
                ProgressView(String(
                    localized: "session_resume.loading",
                    defaultValue: "Loading…",
                    table: "TermLoop"))
                    .frame(width: 520, height: 316)
            } else {
                HStack(spacing: 0) {
                    SessionListView(
                        sessions: filtered,
                        selectedId: $selectedId,
                        isSearching: !searchText.trimmingCharacters(in: .whitespaces).isEmpty,
                        onDelete: onDelete)
                        .frame(width: 180)
                    Divider()
                    VStack(spacing: 0) {
                        HStack {
                            Spacer()
                            Picker("", selection: $previewFilter) {
                                ForEach(PreviewFilter.allCases, id: \.self) { f in
                                    Text(f.rawValue).tag(f)
                                }
                            }
                            .pickerStyle(.segmented)
                            .frame(width: 110)
                            .padding(.trailing, 8)
                            .padding(.vertical, 4)
                        }
                        Divider()
                        SessionPreviewView(metadata: selected, filter: previewFilter)
                    }
                    .frame(maxWidth: .infinity)
                }
                .frame(height: 316)
            }
            Divider()
            footer
                .frame(height: 44)
                .padding(.horizontal, 12)
        }
        .frame(width: 520)
        .onAppear { restoreSelection() }
        .onChange(of: sessions) { _, _ in restoreSelection() }
        .onChange(of: filtered) { _, new in
            if let id = selectedId, !new.contains(where: { $0.sessionId == id }) {
                selectedId = new.first?.sessionId
            } else if selectedId == nil {
                selectedId = new.first?.sessionId
            }
        }
        .onChange(of: selectedId) { _, new in
            guard let new, let key = defaultsKey else { return }
            UserDefaults.standard.set(new, forKey: key)
        }
        .onExitCommand { onCancel() }
    }

    private func restoreSelection() {
        let available = visibleSessions
        if let key = defaultsKey,
           let saved = UserDefaults.standard.string(forKey: key),
           available.contains(where: { $0.sessionId == saved }) {
            selectedId = saved
            return
        }
        if selectedId == nil {
            selectedId = available.first?.sessionId
        }
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            PopoverSearchField(text: $searchText, placeholder: String(
                localized: "session_resume.search_placeholder",
                defaultValue: "Search sessions",
                table: "TermLoop"))
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help(String(
                    localized: "session_resume.search_clear",
                    defaultValue: "Clear search",
                    table: "TermLoop"))
            }
        }
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button(String(
                localized: "session_resume.cancel_button",
                defaultValue: "Cancel",
                table: "TermLoop")) { onCancel() }
                .keyboardShortcut(.cancelAction)
            Button(String(
                localized: "session_resume.resume_button",
                defaultValue: "Resume in new tab",
                table: "TermLoop")) {
                    if let s = selected {
                        if let key = defaultsKey {
                            UserDefaults.standard.set(s.sessionId, forKey: key)
                        }
                        onResume(s)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(selected == nil)
        }
    }
}

/// AppKit-backed search field that reliably steals first responder when the
/// popover appears. SwiftUI `TextField` + `@FocusState` is unreliable inside
/// an `NSPopover` hosted by a Ghostty terminal window — the terminal surface
/// (acceptsFirstResponder = true) keeps the key window's first responder, so
/// typed characters end up going to the terminal instead of the field.
struct PopoverSearchField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String

    final class Coordinator: NSObject, NSTextFieldDelegate {
        var binding: Binding<String>
        init(binding: Binding<String>) { self.binding = binding }
        func controlTextDidChange(_ obj: Notification) {
            guard let field = obj.object as? NSTextField else { return }
            binding.wrappedValue = field.stringValue
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(binding: $text) }

    func makeNSView(context: Context) -> AutoFocusTextField {
        let field = AutoFocusTextField()
        field.delegate = context.coordinator
        field.placeholderString = placeholder
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.bezelStyle = .roundedBezel
        field.font = .systemFont(ofSize: 12)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return field
    }

    func updateNSView(_ nsView: AutoFocusTextField, context: Context) {
        if nsView.stringValue != text { nsView.stringValue = text }
        nsView.placeholderString = placeholder
        context.coordinator.binding = $text
    }
}

/// NSTextField subclass that forces its host window to become key and takes
/// first responder as soon as it is attached to a window. Works around a
/// Ghostty-window quirk where SwiftUI's popover content never grabs focus
/// from the terminal surface.
final class AutoFocusTextField: NSTextField {
    private var keyMonitor: Any?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window = self.window {
            attach(to: window)
        } else {
            detach()
        }
    }

    deinit { detach() }

    private func attach(to window: NSWindow) {
        if let panel = window as? NSPanel {
            panel.becomesKeyOnlyIfNeeded = false
        }
        // SwiftUI's `.popover(isPresented:)` hosts content in an
        // `_NSPopoverWindow` (NSPanel) that never becomes `NSApp.keyWindow`, so
        // keyDown events dispatched via `NSApp.sendEvent` target the Ghostty
        // host window and our text field never sees them. Workaround: install
        // a local event monitor for the lifetime of this view. Typing-only
        // events get forwarded to this popover window; modifier-bearing
        // shortcuts pass through untouched so Cmd-T/W/etc. keep working.
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window else { return }
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(self)
            if let editor = self.currentEditor() as? NSTextView {
                let end = (self.stringValue as NSString).length
                editor.selectedRange = NSRange(location: end, length: 0)
            }
        }
        if keyMonitor == nil {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self, weak window] event in
                guard let self, let window = window else { return event }
                guard window.isVisible else { return event }
                // Pass shortcuts (Cmd / Ctrl) through unchanged.
                let mods = event.modifierFlags.intersection([.command, .control])
                if !mods.isEmpty { return event }
                // If the event is already destined for our popover window, let it flow.
                if event.window === window { return event }
                // Make sure our text field is first responder, then deliver the
                // event directly to our popover window's responder chain.
                if window.firstResponder !== self,
                   window.firstResponder !== self.currentEditor() {
                    window.makeFirstResponder(self)
                }
                window.sendEvent(event)
                return nil
            }
        }
    }

    private func detach() {
        if let monitor = keyMonitor {
            NSEvent.removeMonitor(monitor)
            keyMonitor = nil
        }
    }
}

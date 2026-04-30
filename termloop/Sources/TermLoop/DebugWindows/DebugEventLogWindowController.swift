// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

#if DEBUG
import AppKit
import Bonsplit
import Combine
import SwiftUI

@MainActor
final class DebugEventLogWindowController: NSWindowController, NSWindowDelegate {
    static let shared = DebugEventLogWindowController()

    private init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = String(
            localized: "termloop.debugEventLog.window.title",
            defaultValue: "Debug Event Log",
            table: "TermLoop"
        )
        window.titleVisibility = .visible
        window.isReleasedWhenClosed = false
        window.identifier = NSUserInterfaceItemIdentifier("cmux.debugEventLog")
        window.center()
        window.contentView = NSHostingView(rootView: DebugEventLogView())
        super.init(window: window)
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show() {
        guard let window else { return }
        if !window.isVisible {
            window.center()
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }
}

@MainActor
private final class DebugEventLogStore: ObservableObject {
    struct Entry: Identifiable, Hashable {
        let id: UInt64
        let text: String
    }

    @Published private(set) var entries: [Entry] = []
    private var cancellable: AnyCancellable?
    private var nextID: UInt64 = 0
    private let displayCap = 5_000

    init() {
        let snapshot = DebugEventLog.shared.snapshot()
        entries = snapshot.map { text in
            defer { nextID &+= 1 }
            return Entry(id: nextID, text: text)
        }
        cancellable = DebugEventLog.shared.eventPublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] text in
                guard let self else { return }
                let entry = Entry(id: self.nextID, text: text)
                self.nextID &+= 1
                self.entries.append(entry)
                if self.entries.count > self.displayCap {
                    self.entries.removeFirst(self.entries.count - self.displayCap)
                }
            }
    }

    func clear() {
        entries.removeAll()
        DebugEventLog.shared.clearBuffer()
    }
}

private struct DebugEventLogView: View {
    @StateObject private var store = DebugEventLogStore()
    @State private var filter = ""
    @State private var autoScroll = true

    private var filtered: [DebugEventLogStore.Entry] {
        let needle = filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return store.entries }
        return store.entries.filter { $0.text.lowercased().contains(needle) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField(
                    String(
                        localized: "termloop.debugEventLog.filter.placeholder",
                        defaultValue: "Filter…",
                        table: "TermLoop"
                    ),
                    text: $filter
                )
                .textFieldStyle(.roundedBorder)

                Toggle(
                    String(
                        localized: "termloop.debugEventLog.autoscroll",
                        defaultValue: "Auto-scroll",
                        table: "TermLoop"
                    ),
                    isOn: $autoScroll
                )
                .toggleStyle(.checkbox)

                Button(
                    String(
                        localized: "termloop.debugEventLog.copy",
                        defaultValue: "Copy",
                        table: "TermLoop"
                    )
                ) {
                    copyAll()
                }

                Button(
                    String(
                        localized: "termloop.debugEventLog.clear",
                        defaultValue: "Clear",
                        table: "TermLoop"
                    )
                ) {
                    store.clear()
                }
            }
            .padding(8)

            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(filtered) { entry in
                            Text(entry.text)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(entry.id)
                        }
                    }
                    .padding(8)
                }
                .onChange(of: filtered.last?.id) { _, newID in
                    guard autoScroll, let id = newID else { return }
                    withAnimation(.none) {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
                .onAppear {
                    if autoScroll, let id = filtered.last?.id {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
            .background(Color(nsColor: .textBackgroundColor))

            Divider()

            HStack(spacing: 8) {
                Text(
                    String(
                        format: String(
                            localized: "termloop.debugEventLog.counts",
                            defaultValue: "%lld / %lld",
                            table: "TermLoop"
                        ),
                        filtered.count,
                        store.entries.count
                    )
                )
                .font(.caption)
                .foregroundStyle(.secondary)

                Spacer()

                Text(DebugEventLog.logFilePath)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .frame(minWidth: 520, minHeight: 320)
    }

    private func copyAll() {
        let text = filtered.map(\.text).joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
#endif

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI
import STTextView

/// Shared markdown editor used by every edit surface in TermLoop.
///
/// Wraps `STTextView` directly (not via `STTextViewUI.TextView`) so we can:
///  - Guard external updates against identical content, preventing SwiftUI
///    re-renders (e.g. agents ticking) from resetting the text view and
///    jumping the scroll position to the top/bottom.
///  - Preserve scroll + selection across legitimate external updates.
///  - Apply lightweight markdown syntax coloring via `addAttributes` (which
///    does not move the caret or scroll).
struct MarkdownEditor: View {
    @Binding var text: AttributedString
    var autosaveDebounce: Duration?
    var onCommit: ((String) -> Void)?
    var onEscape: (() -> Void)?
    var placeholder: String?

    @State private var saveTask: Task<Void, Never>?
    @State private var isLoaded = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            MarkdownTextView(text: $text, onEscape: onEscape)
                .background(MarkdownTheme.editorBg)
                .onAppear { isLoaded = true }
                .onChange(of: text) { newValue in
                    guard isLoaded else { return }
                    scheduleSave(newValue)
                }
                .onDisappear { flushSave() }

            if let placeholder, String(text.characters).isEmpty {
                Text(placeholder)
                    .font(MarkdownTheme.codeEditor)
                    .foregroundStyle(Color.primary.opacity(0.28))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 12)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func scheduleSave(_ value: AttributedString) {
        guard let debounce = autosaveDebounce, let onCommit else { return }
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            onCommit(String(value.characters))
        }
    }

    func flushSave() {
        saveTask?.cancel()
        onCommit?(String(text.characters))
    }
}

// MARK: - STTextView wrapper

private struct MarkdownTextView: NSViewRepresentable {
    @Binding var text: AttributedString
    var onEscape: (() -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = MarkdownPlainTextView.scrollableTextView()
        let textView = scrollView.documentView as! MarkdownPlainTextView
        textView.delegate = context.coordinator
        textView.onEscape = { context.coordinator.parent.onEscape?() }
        configureWrappedLineLayout(for: textView, in: scrollView)
        textView.highlightSelectedLine = false
        textView.allowsDocumentBackgroundColorChange = false
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textColor = .labelColor
        applyBackground(to: textView, in: scrollView)

        context.coordinator.isApplyingExternal = true
        textView.setAttributedString(NSAttributedString(string: String(text.characters),
                                                        attributes: baseAttributes()))
        MarkdownSyntaxHighlighter.apply(to: textView)
        context.coordinator.lastAppliedString = textView.string
        context.coordinator.isApplyingExternal = false

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        let textView = scrollView.documentView as! MarkdownPlainTextView
        textView.onEscape = { context.coordinator.parent.onEscape?() }

        let incoming = String(text.characters)
        configureWrappedLineLayout(for: textView, in: scrollView)
        applyBackground(to: textView, in: scrollView)

        // Crucial guard: if the content hasn't actually changed, do nothing.
        // This prevents SwiftUI re-renders (driven by agent terminal ticks,
        // status updates, etc.) from calling setAttributedString, which would
        // clobber scroll position and selection.
        if incoming == textView.string { return }

        // Legit external update (e.g. initial disk load, file switch).
        // Preserve scroll + selection across the replace when possible.
        let savedSelection = textView.selectedRange()
        let savedScroll = scrollView.contentView.bounds.origin

        context.coordinator.isApplyingExternal = true
        textView.setAttributedString(NSAttributedString(string: incoming,
                                                        attributes: baseAttributes()))
        MarkdownSyntaxHighlighter.apply(to: textView)
        context.coordinator.lastAppliedString = incoming
        context.coordinator.isApplyingExternal = false

        let nsString = textView.string as NSString
        let maxLen = nsString.length
        let clamped = NSRange(
            location: min(savedSelection.location, maxLen),
            length: 0
        )
        textView.setSelectedRange(clamped)
        scrollView.contentView.setBoundsOrigin(savedScroll)
    }

    private func baseAttributes() -> [NSAttributedString.Key: Any] {
        [
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
            .foregroundColor: NSColor.labelColor,
        ]
    }

    private func applyBackground(to textView: STTextView, in scrollView: NSScrollView) {
        let background = MarkdownTheme.nsEditorBackground
        textView.backgroundColor = background
        scrollView.drawsBackground = true
        scrollView.backgroundColor = background
        scrollView.contentView.drawsBackground = true
        scrollView.contentView.backgroundColor = background
    }

    private func configureWrappedLineLayout(for textView: STTextView, in scrollView: NSScrollView) {
        scrollView.hasHorizontalScroller = false
        textView.isHorizontallyResizable = false
    }

    @MainActor
    final class Coordinator: NSObject, STTextViewDelegate {
        var parent: MarkdownTextView
        var isApplyingExternal = false
        var lastAppliedString: String = ""
        private var highlightTask: Task<Void, Never>?

        init(parent: MarkdownTextView) {
            self.parent = parent
        }

        func textViewDidChangeText(_ notification: Notification) {
            guard let textView = notification.object as? STTextView else { return }
            guard !isApplyingExternal else { return }

            let newString = textView.string
            lastAppliedString = newString

            // Forward to binding without re-triggering our own update path:
            // the equality guard in `updateNSView` makes that a no-op.
            let newValue = AttributedString(newString)
            DispatchQueue.main.async { [weak self] in
                self?.parent.text = newValue
            }

            // Debounced re-highlight so typing stays snappy.
            highlightTask?.cancel()
            highlightTask = Task { [weak self, weak textView] in
                try? await Task.sleep(for: .milliseconds(120))
                guard !Task.isCancelled, let textView else { return }
                await MainActor.run {
                    self?.isApplyingExternal = true
                    MarkdownSyntaxHighlighter.apply(to: textView)
                    self?.isApplyingExternal = false
                }
            }
        }
    }
}

private final class MarkdownPlainTextView: STTextView {
    var onEscape: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        if ShortcutStroke.isEscapeCancelEvent(event),
           !hasMarkedText(),
           let onEscape {
            onEscape()
            return
        }
        super.keyDown(with: event)
    }

    override func paste(_ sender: Any?) {
        pasteAsPlainText(sender)
    }

    override func pasteAsRichText(_ sender: Any?) {
        pasteAsPlainText(sender)
    }
}

// MARK: - Syntax highlighter

/// Lightweight, regex-based markdown highlighter. Resets rich paste attributes
/// back to editor defaults, then applies markdown-specific styling in place.
private enum MarkdownSyntaxHighlighter {
    static func apply(to textView: STTextView) {
        let full = textView.string as NSString
        let range = NSRange(location: 0, length: full.length)
        guard range.length > 0 else { return }

        // Reset to base style first.
        textView.setAttributes([
            .foregroundColor: NSColor.labelColor,
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
        ], range: range)

        let text = full as String

        // Fenced code blocks (```...```)
        highlight(pattern: #"(?ms)^```[\s\S]*?^```"#, in: text, range: range) { match in
            textView.addAttributes([
                .foregroundColor: NSColor.secondaryLabelColor,
                .backgroundColor: NSColor.quaternaryLabelColor.withAlphaComponent(0.35),
            ], range: match)
        }

        // Headings (# ... ######)
        highlight(pattern: #"(?m)^#{1,6} .*$"#, in: text, range: range) { match in
            textView.addAttributes([
                .foregroundColor: NSColor.systemBlue,
                .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .bold),
            ], range: match)
        }

        // Bold (**x** or __x__)
        highlight(pattern: #"(\*\*|__)(?=\S)([\s\S]*?\S)\1"#, in: text, range: range) { match in
            textView.addAttributes([
                .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .bold),
            ], range: match)
        }

        // Italic (*x* or _x_)
        highlight(pattern: #"(?<![*_\w])([*_])(?=\S)([^*_\n]+?\S)\1(?![*_\w])"#, in: text, range: range) { match in
            textView.addAttributes([
                .foregroundColor: NSColor.systemTeal,
            ], range: match)
        }

        // Inline code `x`
        highlight(pattern: #"`[^`\n]+`"#, in: text, range: range) { match in
            textView.addAttributes([
                .foregroundColor: NSColor.systemPink,
                .backgroundColor: NSColor.quaternaryLabelColor.withAlphaComponent(0.25),
            ], range: match)
        }

        // List markers (-, *, +, 1.)
        highlight(pattern: #"(?m)^\s*([-*+]|\d+\.)\s"#, in: text, range: range) { match in
            textView.addAttributes([
                .foregroundColor: NSColor.systemOrange,
            ], range: match)
        }

        // Block quotes
        highlight(pattern: #"(?m)^\s*>.*$"#, in: text, range: range) { match in
            textView.addAttributes([
                .foregroundColor: NSColor.secondaryLabelColor,
            ], range: match)
        }

        // Links [text](url)
        highlight(pattern: #"\[[^\]\n]+\]\([^)\n]+\)"#, in: text, range: range) { match in
            textView.addAttributes([
                .foregroundColor: NSColor.systemPurple,
                .underlineStyle: NSUnderlineStyle.single.rawValue,
            ], range: match)
        }
    }

    private static func highlight(pattern: String,
                                  in text: String,
                                  range: NSRange,
                                  apply: (NSRange) -> Void) {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return }
        regex.enumerateMatches(in: text, range: range) { match, _, _ in
            if let r = match?.range { apply(r) }
        }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

enum QuickActionPasteboardHelper {
    static func imagePasteInsertionText(
        from pasteboard: NSPasteboard = .general
    ) -> String? {
        guard let fileURL = GhosttyPasteboardHelper.saveImageFileURLIfNeeded(from: pasteboard) else {
            return nil
        }
        return "Please inspect this image: \(fileURL.path)"
    }

    static func insertImagePasteIfNeeded(
        into textView: NSTextView,
        pasteboard: NSPasteboard = .general
    ) -> Bool {
        guard let coreText = imagePasteInsertionText(from: pasteboard) else {
            return false
        }

        let insertion = formattedInsertionText(coreText, in: textView)
        textView.insertText(insertion, replacementRange: textView.selectedRange())
        return true
    }

    private static func formattedInsertionText(
        _ coreText: String,
        in textView: NSTextView
    ) -> String {
        let existingText = textView.string as NSString
        let selection = textView.selectedRange()
        guard existingText.length > 0 else { return coreText }

        var result = coreText
        if selection.location > 0,
           existingText.character(at: selection.location - 1) != 10 {
            result = "\n" + result
        }
        if selection.location < existingText.length,
           existingText.character(at: selection.location) != 10 {
            result += "\n"
        }
        return result
    }
}

#if DEBUG
func cmuxQuickActionImagePasteInsertionForTesting(
    _ pasteboard: NSPasteboard
) -> String? {
    QuickActionPasteboardHelper.imagePasteInsertionText(from: pasteboard)
}
#endif

/// Multiline prompt field for the Quick Action palette. Backed by
/// `NSTextView` so we can distinguish return-submit from shift-return-newline
/// and forward ⌘↵ / ⌘K / Tab / Esc / ↑↓ to the view model without losing
/// text-editing basics.
struct QuickActionComposer: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var effectivePreviewText: String? = nil
    var effectivePreviewLabel: String? = nil
    var isFocused: Binding<Bool>

    var onSubmit: (() -> Void)?
    var onCommandReturn: (() -> Void)?
    var onOpenTemplateDropdown: (() -> Void)?
    var onToggleAdvanced: (() -> Void)?
    var onEscape: (() -> Void)?
    var onNavigateUp: (() -> Void)?
    var onNavigateDown: (() -> Void)?
    var autocompleteContextProvider: (() -> QuickActionAutocompleteContext)? = nil

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.borderType = .noBorder
        scroll.autohidesScrollers = true

        let textView = QuickActionComposerTextView()
        textView.coordinator = context.coordinator
        textView.isEditable = true
        textView.isRichText = false
        textView.drawsBackground = false
        textView.font = NSFont.systemFont(ofSize: 15)
        textView.textContainerInset = NSSize(width: 2, height: 4)
        textView.delegate = context.coordinator
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.translatesAutoresizingMaskIntoConstraints = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true

        scroll.documentView = textView
        context.coordinator.textView = textView
        context.coordinator.updatePlaceholder(placeholder)
        context.coordinator.updateEffectivePreview(
            text: effectivePreviewText,
            label: effectivePreviewLabel
        )
        context.coordinator.applyTextIfNeeded(text)
        context.coordinator.installAutocompleteIfNeeded()
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.updatePlaceholder(placeholder)
        context.coordinator.updateEffectivePreview(
            text: effectivePreviewText,
            label: effectivePreviewLabel
        )
        context.coordinator.applyTextIfNeeded(text)
        context.coordinator.installAutocompleteIfNeeded()
        if isFocused.wrappedValue,
           let tv = context.coordinator.textView,
           tv.window?.firstResponder !== tv {
            DispatchQueue.main.async {
                tv.window?.makeFirstResponder(tv)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        weak var textView: QuickActionComposerTextView?
        var parent: QuickActionComposer
        private var placeholderText: String = ""
        var autocompleteController: QuickActionAutocompleteController?

        init(parent: QuickActionComposer) {
            self.parent = parent
        }

        @MainActor
        func installAutocompleteIfNeeded() {
            guard autocompleteController == nil,
                  let provider = parent.autocompleteContextProvider,
                  let textView else { return }
            autocompleteController = QuickActionAutocompleteController(
                textView: textView,
                contextProvider: provider
            )
        }

        func applyTextIfNeeded(_ newText: String) {
            guard let textView else { return }
            if textView.string != newText {
                let previousSelection = textView.selectedRange()
                textView.string = newText
                let clampedLocation = min(previousSelection.location, newText.utf16.count)
                textView.setSelectedRange(NSRange(location: clampedLocation, length: 0))
                textView.needsDisplay = true
                if newText.isEmpty {
                    Task { @MainActor in self.autocompleteController?.reset() }
                }
            }
        }

        func updatePlaceholder(_ placeholder: String) {
            placeholderText = placeholder
            textView?.placeholderString = placeholder
            textView?.needsDisplay = true
        }

        func updateEffectivePreview(text: String?, label: String?) {
            textView?.effectivePreviewText = text
            textView?.effectivePreviewLabel = label
            textView?.needsDisplay = true
        }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            let value = tv.string
            DispatchQueue.main.async { [weak self] in
                self?.parent.text = value
            }
            tv.needsDisplay = true
            Task { @MainActor in self.autocompleteController?.textDidChange() }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            Task { @MainActor in self.autocompleteController?.textDidChange() }
        }

        @MainActor
        func isAutocompleteOpen() -> Bool {
            autocompleteController?.isPopupVisible ?? false
        }

        @MainActor
        func handleAutocompleteKey(_ keyCode: UInt16) -> Bool {
            autocompleteController?.handleKeyEvent(keyCode) ?? false
        }

        func handleSpecialKey(_ kind: SpecialKey) -> Bool {
            switch kind {
            case .submit:
                guard let onSubmit = parent.onSubmit else { return false }
                onSubmit()
                return true
            case .newline:
                return false
            case .commandReturn:
                guard let onCommandReturn = parent.onCommandReturn else { return false }
                onCommandReturn()
                return true
            case .commandK:
                guard let onOpenTemplateDropdown = parent.onOpenTemplateDropdown else { return false }
                onOpenTemplateDropdown()
                return true
            case .tab:
                guard let onToggleAdvanced = parent.onToggleAdvanced else { return false }
                onToggleAdvanced()
                return true
            case .escape:
                guard let onEscape = parent.onEscape else { return false }
                onEscape()
                return true
            case .up:
                guard let onNavigateUp = parent.onNavigateUp else { return false }
                onNavigateUp()
                return true
            case .down:
                guard let onNavigateDown = parent.onNavigateDown else { return false }
                onNavigateDown()
                return true
            }
        }

        enum SpecialKey {
            case submit, newline, commandReturn, commandK, tab, escape, up, down
        }
    }
}

final class QuickActionComposerTextView: NSTextView {
    weak var coordinator: QuickActionComposer.Coordinator?
    var placeholderString: String? {
        didSet { needsDisplay = true }
    }
    var effectivePreviewText: String? {
        didSet { needsDisplay = true }
    }
    var effectivePreviewLabel: String? {
        didSet { needsDisplay = true }
    }
    private var pasteMonitor: Any?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window {
            attachPasteMonitor(to: window)
        } else {
            detachPasteMonitor()
        }
    }

    deinit {
        detachPasteMonitor()
    }

    override func paste(_ sender: Any?) {
        if QuickActionPasteboardHelper.insertImagePasteIfNeeded(into: self) {
            return
        }
        super.paste(sender)
    }

    override func keyDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let key = event.charactersIgnoringModifiers ?? ""

        if let coordinator, MainActor.assumeIsolated({ coordinator.isAutocompleteOpen() }) {
            switch event.keyCode {
            case 126, 125, 53: // up, down, esc
                if MainActor.assumeIsolated({ coordinator.handleAutocompleteKey(event.keyCode) }) { return }
            case 36: // return
                if !modifiers.contains(.shift),
                   !modifiers.contains(.option),
                   !modifiers.contains(.command),
                   MainActor.assumeIsolated({ coordinator.handleAutocompleteKey(event.keyCode) }) { return }
            case 48: // tab
                if MainActor.assumeIsolated({ coordinator.handleAutocompleteKey(event.keyCode) }) { return }
            default:
                break
            }
        }

        if modifiers.contains(.command), key.lowercased() == "k" {
            if coordinator?.handleSpecialKey(.commandK) == true { return }
        }
        if modifiers.contains(.command), event.keyCode == 36 {
            if coordinator?.handleSpecialKey(.commandReturn) == true { return }
        }
        if event.keyCode == 36 {
            if modifiers.contains(.shift) || modifiers.contains(.option) {
                super.keyDown(with: event)
                return
            }
            if coordinator?.handleSpecialKey(.submit) == true { return }
        }
        if event.keyCode == 48 {
            if coordinator?.handleSpecialKey(.tab) == true { return }
        }
        if event.keyCode == 53 {
            if coordinator?.handleSpecialKey(.escape) == true { return }
        }
        if event.keyCode == 126 {
            if shouldHijackVerticalNavigation(goingUp: true) {
                if coordinator?.handleSpecialKey(.up) == true { return }
            }
        }
        if event.keyCode == 125 {
            if shouldHijackVerticalNavigation(goingUp: false) {
                if coordinator?.handleSpecialKey(.down) == true { return }
            }
        }
        super.keyDown(with: event)
    }

    private func shouldHijackVerticalNavigation(goingUp: Bool) -> Bool {
        if !string.contains("\n") { return true }
        let selected = selectedRange()
        let location = selected.location
        let nsString = string as NSString
        if goingUp {
            return !nsString.substring(with: NSRange(location: 0, length: location)).contains("\n")
        } else {
            let tail = NSRange(location: location, length: nsString.length - location)
            return !nsString.substring(with: tail).contains("\n")
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty else { return }

        let trimmedPreview = effectivePreviewText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedPreview.isEmpty {
            drawEffectivePreview(text: trimmedPreview, label: effectivePreviewLabel)
            return
        }

        guard let placeholder = placeholderString, !placeholder.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 15),
            .foregroundColor: NSColor.placeholderTextColor,
        ]
        let insets = textContainerInset
        let origin = NSPoint(x: insets.width + 5, y: insets.height)
        (placeholder as NSString).draw(at: origin, withAttributes: attrs)
    }

    private func drawEffectivePreview(text: String, label: String?) {
        let insets = textContainerInset
        let x = insets.width + 5
        let y = insets.height + 2
        let availableWidth = max(0, bounds.width - x - insets.width - 8)

        var currentY = y
        if let label, !label.isEmpty {
            let labelStyle = NSMutableParagraphStyle()
            labelStyle.lineBreakMode = .byTruncatingTail
            let labelAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold),
                .foregroundColor: NSColor.tertiaryLabelColor,
                .paragraphStyle: labelStyle,
            ]
            let labelRect = NSRect(x: x, y: currentY, width: availableWidth, height: 16)
            (label.uppercased() as NSString).draw(in: labelRect, withAttributes: labelAttrs)
            currentY += 18
        }

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        let textAttrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 15),
            .foregroundColor: NSColor.placeholderTextColor,
            .paragraphStyle: paragraph,
        ]
        let previewRect = NSRect(
            x: x,
            y: currentY,
            width: availableWidth,
            height: max(0, bounds.height - currentY - insets.height - 6)
        )
        (text as NSString).draw(in: previewRect, withAttributes: textAttrs)
    }

    private func attachPasteMonitor(to window: NSWindow) {
        guard pasteMonitor == nil else { return }
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self, weak window] event in
            guard let self, let window else { return event }
            guard window.isVisible else { return event }

            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
            guard flags == [.command], key == "v" else { return event }

            if window.firstResponder !== self {
                window.makeFirstResponder(self)
            }
            self.paste(nil)
            return nil
        }
    }

    private func detachPasteMonitor() {
        if let pasteMonitor {
            NSEvent.removeMonitor(pasteMonitor)
            self.pasteMonitor = nil
        }
    }
}

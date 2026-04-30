// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// A detected `@query` slice inside the composer's text. `range` covers the
/// full span including the leading `@`; `query` is the text after `@` up to
/// the caret.
struct QuickActionAutocompleteQuery: Equatable {
    let range: NSRange
    let query: String
}

/// Orchestrates the autocomplete popup for the QuickAction composer. Owns the
/// panel lifecycle, keyboard handling while the popup is visible, and the
/// candidate cache for the current composer session.
@MainActor
final class QuickActionAutocompleteController {
    typealias ContextProvider = () -> QuickActionAutocompleteContext

    private weak var textView: NSTextView?
    private let contextProvider: ContextProvider
    private let panel: QuickActionAutocompletePanel
    private let model: QuickActionAutocompleteModel
    private var hostingView: NSHostingView<QuickActionAutocompleteView>!
    private var candidates: [QuickActionAutocompleteItem] = []
    private var activeQuery: QuickActionAutocompleteQuery?
    private var loadToken: UUID?
    private var hasLoadedForSession = false

    init(textView: NSTextView, contextProvider: @escaping ContextProvider) {
        self.textView = textView
        self.contextProvider = contextProvider
        self.panel = QuickActionAutocompletePanel()
        self.model = QuickActionAutocompleteModel()
        let view = QuickActionAutocompleteView(model: model) { [weak self] item in
            self?.accept(item)
        }
        let hosting = NSHostingView(rootView: view)
        hosting.translatesAutoresizingMaskIntoConstraints = false
        self.hostingView = hosting

        let container = NSView(frame: .zero)
        container.addSubview(hosting)
        NSLayoutConstraint.activate([
            hosting.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            hosting.topAnchor.constraint(equalTo: container.topAnchor),
            hosting.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        panel.contentView = container
    }

    var isPopupVisible: Bool { panel.isVisible }

    /// Called by the text view after every text change. Decides whether to
    /// open, refresh, or close the popup.
    func textDidChange() {
        guard let textView else { close(); return }
        guard let detected = Self.detectQuery(in: textView.string, caret: textView.selectedRange().location) else {
            close()
            return
        }
        activeQuery = detected
        if !hasLoadedForSession {
            hasLoadedForSession = true
            loadCandidates()
        }
        applyFilter()
        if model.items.isEmpty {
            hidePanel()
        } else {
            showPanel()
        }
    }

    /// Called when the text view loses focus or the composer resets.
    func reset() {
        activeQuery = nil
        candidates = []
        hasLoadedForSession = false
        model.items = []
        model.selectedIndex = 0
        hidePanel()
    }

    /// Returns true when the key event was handled by the popup. The text
    /// view should stop its own handling in that case.
    func handleKeyEvent(_ keyCode: UInt16) -> Bool {
        guard isPopupVisible else { return false }
        switch keyCode {
        case 126: // up
            model.moveUp()
            return true
        case 125: // down
            model.moveDown()
            return true
        case 36, 48: // return, tab
            if let item = model.selectedItem {
                accept(item)
                return true
            }
            return false
        case 53: // escape
            close()
            return true
        default:
            return false
        }
    }

    private func loadCandidates() {
        let token = UUID()
        loadToken = token
        let context = contextProvider()
        Task { [weak self] in
            let loaded = await QuickActionAutocompleteSource.candidates(for: context)
            await MainActor.run {
                guard let self, self.loadToken == token else { return }
                self.candidates = loaded
                self.applyFilter()
                if !self.model.items.isEmpty, self.activeQuery != nil {
                    self.showPanel()
                }
            }
        }
    }

    private func applyFilter() {
        let query = activeQuery?.query ?? ""
        model.items = QuickActionAutocompleteSource.filter(candidates, query: query)
        model.selectedIndex = 0
    }

    private func showPanel() {
        guard let textView, let window = textView.window else { return }
        positionPanel(under: textView)
        if !panel.isVisible {
            window.addChildWindow(panel, ordered: .above)
        }
    }

    private func hidePanel() {
        if panel.isVisible {
            panel.parent?.removeChildWindow(panel)
            panel.orderOut(nil)
        }
    }

    private func close() {
        activeQuery = nil
        hidePanel()
    }

    private func positionPanel(under textView: NSTextView) {
        guard let window = textView.window,
              let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer,
              let query = activeQuery else { return }
        let glyphIndex = layoutManager.glyphIndexForCharacter(at: query.range.location)
        let glyphRange = NSRange(location: glyphIndex, length: 0)
        var localRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
        localRect.origin.x += textView.textContainerOrigin.x
        localRect.origin.y += textView.textContainerOrigin.y
        let inViewRect = textView.convert(localRect, to: nil)
        let screenRect = window.convertToScreen(inViewRect)
        let size = panel.frame.size
        let origin = NSPoint(x: screenRect.origin.x, y: screenRect.origin.y - size.height - 4)
        panel.setFrameOrigin(origin)
    }

    private func accept(_ item: QuickActionAutocompleteItem) {
        guard let textView, let query = activeQuery else { return }
        let ns = textView.string as NSString
        let safeRange = NSRange(
            location: query.range.location,
            length: min(query.range.length, ns.length - query.range.location)
        )
        let replacement = "@" + item.insertText + " "
        if textView.shouldChangeText(in: safeRange, replacementString: replacement) {
            textView.replaceCharacters(in: safeRange, with: replacement)
            textView.didChangeText()
            let caret = safeRange.location + (replacement as NSString).length
            textView.setSelectedRange(NSRange(location: caret, length: 0))
        }
        close()
    }

    /// Scan backward from the caret to find an `@` that starts a fresh word.
    /// Returns nil when the caret is not inside such a token.
    static func detectQuery(in string: String, caret: Int) -> QuickActionAutocompleteQuery? {
        let ns = string as NSString
        guard caret >= 0, caret <= ns.length else { return nil }
        var i = caret - 1
        while i >= 0 {
            let ch = ns.character(at: i)
            if ch == 0x40 { // '@'
                let startsOk: Bool
                if i == 0 {
                    startsOk = true
                } else {
                    let prev = ns.character(at: i - 1)
                    startsOk = isWordBoundary(prev)
                }
                guard startsOk else { return nil }
                let range = NSRange(location: i, length: caret - i)
                let queryRange = NSRange(location: i + 1, length: caret - i - 1)
                let query = ns.substring(with: queryRange)
                return QuickActionAutocompleteQuery(range: range, query: query)
            }
            if !isQueryChar(ch) { return nil }
            i -= 1
        }
        return nil
    }

    private static func isQueryChar(_ ch: unichar) -> Bool {
        if ch == 0x20 || ch == 0x09 || ch == 0x0A || ch == 0x0D { return false }
        if ch < 0x20 { return false }
        return true
    }

    private static func isWordBoundary(_ ch: unichar) -> Bool {
        return ch == 0x20 || ch == 0x09 || ch == 0x0A || ch == 0x0D
    }
}

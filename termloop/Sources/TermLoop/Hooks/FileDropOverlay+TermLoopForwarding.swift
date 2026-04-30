// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import WebKit

/// Transient per-overlay state for file-drop forwarding into SwiftUI-hosted
/// targets (e.g. sidebar Docs rows). Kept external so `FileDropOverlayView`
/// doesn't need new stored properties (Y4). Keys are the upstream overlay
/// views; values are the forwarded NSView targets. Weak-to-weak so entries
/// fall out of the map as soon as either the overlay or the target is
/// deallocated.
@MainActor
final class FileDropForwardingState {
    static let shared = FileDropForwardingState()
    private init() {}

    private let preparedTargets = NSMapTable<NSView, NSView>(
        keyOptions: [.weakMemory, .objectPointerPersonality],
        valueOptions: [.weakMemory, .objectPointerPersonality]
    )
    private let activeTargets = NSMapTable<NSView, NSView>(
        keyOptions: [.weakMemory, .objectPointerPersonality],
        valueOptions: [.weakMemory, .objectPointerPersonality]
    )

    func prepared(for overlay: NSView) -> NSView? {
        preparedTargets.object(forKey: overlay)
    }

    func setPrepared(_ target: NSView?, for overlay: NSView) {
        if let target {
            preparedTargets.setObject(target, forKey: overlay)
        } else {
            preparedTargets.removeObject(forKey: overlay)
        }
    }

    func active(for overlay: NSView) -> NSView? {
        activeTargets.object(forKey: overlay)
    }

    func setActive(_ target: NSView?, for overlay: NSView) {
        if let target {
            activeTargets.setObject(target, forKey: overlay)
        } else {
            activeTargets.removeObject(forKey: overlay)
        }
    }

    func reset(for overlay: NSView) {
        preparedTargets.removeObject(forKey: overlay)
        activeTargets.removeObject(forKey: overlay)
    }
}

/// TermLoop-side hooks that let `FileDropOverlayView` route window-level
/// file drops into SwiftUI-hosted targets without growing the overlay's
/// class body. Each hook is called from a single-line marker block inside
/// the upstream overrides.
@MainActor
extension FileDropOverlayView {
    /// Called in `draggingExited`. Resets forwarded state and notifies the
    /// previously-active forwarded target that the drag left.
    func termLoopResetForwardingOnExit(sender: (any NSDraggingInfo)?) {
        let state = FileDropForwardingState.shared
        state.setPrepared(nil, for: self)
        if let prev = state.active(for: self) {
            prev.draggingExited(sender)
            state.setActive(nil, for: self)
        }
    }

    /// Called at the top of `prepareForDragOperation`. If a forwarded target
    /// sits under the drag, prepares it and returns the result for early-
    /// return. Returns `nil` when upstream handling should continue.
    func termLoopTryPrepareForwardedDrop(
        sender: any NSDraggingInfo,
        shouldCapture: Bool
    ) -> Bool? {
        let state = FileDropForwardingState.shared
        guard shouldCapture,
              let target = fileDropTargetUnderPoint(sender.draggingLocation) else {
            state.setPrepared(nil, for: self)
            return nil
        }
        state.setPrepared(target, for: self)
        return target.prepareForDragOperation(sender)
    }

    /// Called at the top of `performDragOperation`. Same contract as
    /// `termLoopTryPrepareForwardedDrop` — routes to a forwarded target when
    /// one is available and returns the target's drop result.
    func termLoopTryPerformForwardedDrop(
        sender: any NSDraggingInfo,
        shouldCapture: Bool
    ) -> Bool? {
        let state = FileDropForwardingState.shared
        let candidate = shouldCapture
            ? (state.prepared(for: self)
                ?? state.active(for: self)
                ?? fileDropTargetUnderPoint(sender.draggingLocation))
            : nil
        guard let target = candidate else {
            state.reset(for: self)
            return nil
        }
        state.setPrepared(target, for: self)
        state.setActive(target, for: self)
        return target.performDragOperation(sender)
    }

    /// Called in `concludeDragOperation` after the `guard let sender`.
    /// Calls `concludeDragOperation` on the forwarded target (if any) and
    /// resets the forwarded state.
    func termLoopConcludeForwardedDrop(sender: any NSDraggingInfo) {
        let state = FileDropForwardingState.shared
        let target = state.prepared(for: self)
            ?? state.active(for: self)
            ?? fileDropTargetUnderPoint(sender.draggingLocation)
        target?.concludeDragOperation(sender)
        state.reset(for: self)
    }

    /// Called at the top of `handleDragUpdate`. Routes drag-entered/updated
    /// events to a forwarded target and returns its drag operation for
    /// early-return. Returns `nil` when no forwarded target exists.
    func termLoopTryForwardDragUpdate(
        sender: any NSDraggingInfo,
        shouldCapture: Bool
    ) -> NSDragOperation? {
        let state = FileDropForwardingState.shared
        let target = shouldCapture
            ? fileDropTargetUnderPoint(sender.draggingLocation)
            : nil

        if let prev = state.active(for: self), prev !== target {
            prev.draggingExited(sender)
            state.setActive(nil, for: self)
        }

        guard let target else { return nil }

        if state.active(for: self) !== target {
            state.setActive(target, for: self)
            return target.draggingEntered(sender)
        }
        return target.draggingUpdated(sender)
    }

    // MARK: - Hit-testing helpers

    /// Locate the topmost SwiftUI/AppKit subview that registered itself as
    /// a file-drop target at `windowPoint`. The overlay temporarily hides
    /// itself so hit-testing descends past its own body into the content
    /// view hierarchy. Terminal and webview subviews are excluded so the
    /// existing routing keeps owning those drops.
    fileprivate func fileDropTargetUnderPoint(_ windowPoint: NSPoint) -> NSView? {
        guard let window, let contentView = window.contentView else { return nil }
        isHidden = true
        defer { isHidden = false }
        let point = contentView.convert(windowPoint, from: nil)
        return fileDropTarget(in: contentView, pointInView: point)
    }

    private func fileDropTarget(in view: NSView, pointInView: NSPoint) -> NSView? {
        for subview in view.subviews.reversed() {
            let pointInSubview = subview.convert(pointInView, from: view)
            guard subview.bounds.contains(pointInSubview) else { continue }
            if let target = fileDropTarget(in: subview, pointInView: pointInSubview) {
                return target
            }
        }

        guard view !== self,
              !(view is WKWebView),
              !(view is GhosttyNSView),
              view.registeredDraggedTypes.contains(.fileURL),
              view.bounds.contains(pointInView) else {
            return nil
        }
        return view
    }
}

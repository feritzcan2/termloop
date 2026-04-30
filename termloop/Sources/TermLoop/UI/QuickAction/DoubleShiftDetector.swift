// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation
import os

/// Watches `.flagsChanged` events (both global and local) for a Shift-Shift
/// chord within a configurable window. Fires `onFire` at most once per
/// successful chord. Shift keystrokes are never consumed — the local monitor
/// returns the event unchanged so other views (Ghostty, TextFields, chords)
/// see modifier state normally.
///
/// Accessibility permission:
///   `NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged)` requires
///   termloop to be trusted for Accessibility (System Settings → Privacy &
///   Security → Accessibility). If `AXIsProcessTrusted()` is false we still
///   install the local monitor so the chord works when termloop is frontmost.
///   `QuickActionController` surfaces the prompt in Settings.
@MainActor
final class DoubleShiftDetector {
    enum StateKind: Equatable {
        case idle
        case sawFirstDown(downAt: TimeInterval)
        case sawFirstUp(firstDownAt: TimeInterval)
    }

    private let logger = Logger(subsystem: "com.termloop.fork", category: "quickAction.detect")
    private let clock: () -> TimeInterval
    private let workspace: () -> NSRunningApplication?
    private var state: StateKind = .idle
    private var shiftIsDown: Bool = false
    private var globalMonitor: Any?
    private var localMonitor: Any?

    /// Fired on a successful chord. Runs on the main thread.
    var onFire: (() -> Void)?

    init(
        clock: @escaping () -> TimeInterval = { CFAbsoluteTimeGetCurrent() },
        workspace: @escaping () -> NSRunningApplication? = { NSWorkspace.shared.frontmostApplication }
    ) {
        self.clock = clock
        self.workspace = workspace
    }

    // MARK: Installation

    func install() {
        if globalMonitor == nil, AXIsProcessTrusted() {
            globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
                Task { @MainActor [weak self] in
                    self?.handle(event)
                }
            }
        }
        if localMonitor == nil {
            localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
                Task { @MainActor [weak self] in
                    self?.handle(event)
                }
                return event
            }
        }
    }

    func uninstall() {
        if let m = globalMonitor { NSEvent.removeMonitor(m); globalMonitor = nil }
        if let m = localMonitor { NSEvent.removeMonitor(m); localMonitor = nil }
        state = .idle
        shiftIsDown = false
    }

    deinit {
        if let m = globalMonitor { NSEvent.removeMonitor(m) }
        if let m = localMonitor { NSEvent.removeMonitor(m) }
    }

    // MARK: Core state machine (exposed as `process(flags:timestamp:)` for tests)

    private func handle(_ event: NSEvent) {
        process(flags: event.modifierFlags, timestamp: clock())
    }

    /// Pure state-machine entry point. `timestamp` is in seconds. Returns
    /// `true` iff this call fired the chord.
    @discardableResult
    func process(flags: NSEvent.ModifierFlags, timestamp: TimeInterval) -> Bool {
        let wasShift = shiftIsDown
        let isShift = flags.contains(.shift)
        let otherModifier = flags.intersection([.command, .option, .control, .function]).isEmpty == false

        shiftIsDown = isShift

        // Any non-shift modifier appearing resets the chord. (User likely hit
        // Cmd-Shift-X or similar; that shouldn't arm us.)
        if otherModifier {
            state = .idle
            return false
        }

        // Shift just went down.
        if !wasShift, isShift {
            switch state {
            case .idle:
                state = .sawFirstDown(downAt: timestamp)
            case .sawFirstDown:
                // Extra down without a release in between. Reset and start fresh.
                state = .sawFirstDown(downAt: timestamp)
            case .sawFirstUp(let firstDownAt):
                let windowSec = Double(QuickActionSettings.doubleShiftWindowMs()) / 1000.0
                if timestamp - firstDownAt <= windowSec {
                    state = .idle
                    if QuickActionSettings.isEnabled(), !isExcludedFrontmostApp() {
                        fire()
                        return true
                    }
                } else {
                    state = .sawFirstDown(downAt: timestamp)
                }
            }
        }

        // Shift just went up.
        if wasShift, !isShift {
            switch state {
            case .sawFirstDown(let downAt):
                let windowSec = Double(QuickActionSettings.doubleShiftWindowMs()) / 1000.0
                if timestamp - downAt <= windowSec {
                    state = .sawFirstUp(firstDownAt: downAt)
                } else {
                    state = .idle
                }
            default:
                state = .idle
            }
        }

        return false
    }

    // MARK: Helpers

    private func fire() {
        logger.debug("quickAction: double-shift fire")
        onFire?()
    }

    private func isExcludedFrontmostApp() -> Bool {
        guard let bundleId = workspace()?.bundleIdentifier else { return false }
        if bundleId == Bundle.main.bundleIdentifier { return false }
        return QuickActionSettings.excludedBundleIdentifiers().contains(bundleId)
    }
}

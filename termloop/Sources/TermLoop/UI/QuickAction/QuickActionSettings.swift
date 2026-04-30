// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// UserDefaults-backed Quick Action preferences.
///
/// v1 intentionally does **not** round-trip through `settings.json`:
/// `CmuxSettingsFileStore` and its `ResolvedSettingsSnapshot` live in an
/// upstream file (`Sources/KeyboardShortcutSettingsFileStore.swift`). Per
/// TermLoop K-Rules (K1/K2) we cannot add new parser methods or snapshot
/// fields inside an upstream file body. Using plain UserDefaults keys + the
/// `@AppStorage` binding pattern keeps all Quick Action state in TermLoop-
/// owned code while still giving the Settings UI live reactivity via
/// `UserDefaults.didChangeNotification`.
///
/// A future v2 can expose `quickAction.*` keys in `settings.json` once the
/// required parser hooks have a K-compliant insertion path.
enum QuickActionSettings {
    // MARK: UserDefaults keys

    static let freePromptTemplateId = "free-prompt-template"
    static let enabledKey = "termloop.quickAction.enabled"
    static let doubleShiftWindowMsKey = "termloop.quickAction.doubleShiftWindowMs"
    static let defaultAgentTemplateIdKey = "termloop.quickAction.defaultAgentTemplateId"
    static let defaultFreePromptModelKey = "termloop.quickAction.defaultFreePromptModel"
    static let excludedBundleIdentifiersKey = "termloop.quickAction.excludedBundleIdentifiers"
    static let autoCloseOnLaunchKey = "termloop.quickAction.autoCloseOnLaunch"

    // MARK: Defaults

    static let defaultEnabled: Bool = true
    static let defaultDoubleShiftWindowMs: Int = 300
    static let minDoubleShiftWindowMs: Int = 100
    static let maxDoubleShiftWindowMs: Int = 2000

    /// JetBrains IDEs, Xcode, and VS Code are excluded by default so those
    /// apps' native Shift+Shift (Rider/IntelliJ "Search Everywhere") keeps
    /// working. Users can edit the list from Settings.
    static let defaultExcludedBundleIdentifiers: [String] = [
        "com.jetbrains.rider",
        "com.jetbrains.intellij",
        "com.jetbrains.intellij.ce",
        "com.jetbrains.pycharm",
        "com.jetbrains.pycharm.ce",
        "com.jetbrains.WebStorm",
        "com.jetbrains.goland",
        "com.jetbrains.rubymine",
        "com.jetbrains.CLion",
        "com.jetbrains.AppCode",
        "com.jetbrains.datagrip",
        "com.jetbrains.PhpStorm",
        "com.jetbrains.RustRover",
        "com.google.android.studio",
        "com.apple.dt.Xcode",
        "com.microsoft.VSCode",
    ]

    // MARK: Readers (used by DoubleShiftDetector off-main-actor)

    static func isEnabled() -> Bool {
        if let value = UserDefaults.standard.object(forKey: enabledKey) as? Bool {
            return value
        }
        return defaultEnabled
    }

    static func doubleShiftWindowMs() -> Int {
        let raw = UserDefaults.standard.object(forKey: doubleShiftWindowMsKey) as? Int
            ?? defaultDoubleShiftWindowMs
        return min(maxDoubleShiftWindowMs, max(minDoubleShiftWindowMs, raw))
    }

    static func excludedBundleIdentifiers() -> Set<String> {
        let raw = UserDefaults.standard.stringArray(forKey: excludedBundleIdentifiersKey)
            ?? defaultExcludedBundleIdentifiers
        return Set(raw)
    }

    static func defaultAgentTemplateId() -> String? {
        let raw = UserDefaults.standard.string(forKey: defaultAgentTemplateIdKey)
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty ?? true) ? nil : trimmed
    }

    static func defaultFreePromptModel() -> String? {
        let raw = UserDefaults.standard.string(forKey: defaultFreePromptModelKey)
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty ?? true) ? nil : trimmed
    }

    static func autoCloseOnLaunch() -> Bool {
        if let value = UserDefaults.standard.object(forKey: autoCloseOnLaunchKey) as? Bool {
            return value
        }
        return true
    }

    /// Seeds the default excluded bundles once so first-launch users see a
    /// populated list in Settings (matches Raycast's "it already knows about
    /// your IDE" feel). Subsequent launches respect whatever the user saved.
    static func seedDefaultsIfNeeded() {
        let ud = UserDefaults.standard
        if ud.object(forKey: excludedBundleIdentifiersKey) == nil {
            ud.set(defaultExcludedBundleIdentifiers, forKey: excludedBundleIdentifiersKey)
        }
    }
}

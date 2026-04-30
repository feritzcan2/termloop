# TermLoop xcstrings setup notes

TermLoop-owned localized strings live in `Resources/TermLoop.xcstrings`, kept separate from upstream's `Resources/Localizable.xcstrings` so the fork's l10n surface never creates merge conflicts with upstream.

## File

- Path: `Resources/TermLoop.xcstrings`
- Format: standard `.xcstrings` JSON (same schema as `Localizable.xcstrings`).
- Source language: `en`.
- Translations currently provided: `en`, `ja` (mirrors the upstream file's coverage).

## How it was added to the `termloop` target

The plan's preferred route is the Xcode UI ("Add Files to GhosttyTabs...", tick the `termloop` target). Because this phase is executed in an automated context where Xcode UI is unavailable, Option B — direct `project.pbxproj` editing — was used instead. The approach mirrored the existing `Localizable.xcstrings` entries:

1. Added a `PBXFileReference` with `lastKnownFileType = text.json.xcstrings; path = TermLoop.xcstrings;`.
2. Added a matching `PBXBuildFile` referencing that file ref.
3. Added a `children` entry in the `087C454FFF74443AB06942C3 /* Resources */` `PBXGroup`.
4. Added a `files` entry in the `A5001102 /* Resources */` `PBXResourcesBuildPhase` (the termloop target's Copy Bundle Resources phase).

### IDs used

Generated unique, hex-safe 24-character tokens so they will not collide with Xcode-assigned IDs:

- `A9E70001A6EAC0DE00000001` — `PBXFileReference` for `TermLoop.xcstrings`.
- `A9E70001A6EAC0DE00000002` — `PBXBuildFile` for `TermLoop.xcstrings in Resources`.

The children/files entries reuse those same IDs (they are references, not new objects).

### Template diff (against Localizable.xcstrings)

```
# PBXBuildFile section
DA7A10CA710E000000000003 /* Localizable.xcstrings in Resources */ = {isa = PBXBuildFile; fileRef = DA7A10CA710E000000000001 /* Localizable.xcstrings */; };
A9E70001A6EAC0DE00000002 /* TermLoop.xcstrings in Resources */    = {isa = PBXBuildFile; fileRef = A9E70001A6EAC0DE00000001 /* TermLoop.xcstrings */; };

# PBXFileReference section
DA7A10CA710E000000000001 /* Localizable.xcstrings */ = {isa = PBXFileReference; lastKnownFileType = text.json.xcstrings; path = Localizable.xcstrings; sourceTree = "<group>"; };
A9E70001A6EAC0DE00000001 /* TermLoop.xcstrings */    = {isa = PBXFileReference; lastKnownFileType = text.json.xcstrings; path = TermLoop.xcstrings; sourceTree = "<group>"; };

# Resources PBXGroup children
DA7A10CA710E000000000001 /* Localizable.xcstrings */,
A9E70001A6EAC0DE00000001 /* TermLoop.xcstrings */,

# Resources PBXResourcesBuildPhase files
DA7A10CA710E000000000003 /* Localizable.xcstrings in Resources */,
A9E70001A6EAC0DE00000002 /* TermLoop.xcstrings in Resources */,
```

## Call-site pattern

Every TermLoop-owned string call-site must explicitly select the `TermLoop` strings table:

```swift
String(localized: "feature.defaultName", defaultValue: "Default", table: "TermLoop")
```

Important ordering rule: `String(localized:defaultValue:table:bundle:locale:comment:)` requires `table:` to come **after** `defaultValue:`, not before. Earlier versions of the migration script placed `table:` before `defaultValue:` and the build failed with "argument 'defaultValue' must precede argument 'table'" — always put `table:` after `defaultValue:` (or omit `defaultValue:` entirely).

## Upstream-file call-sites

A small number of localized TermLoop-key call-sites remain embedded in upstream files (notably `Sources/ContentView.swift`). Until those call-sites are relocated into `Sources/TermLoop/` proper in Phase 6, each one is wrapped with `// MARK: termloop-hook` / `// MARK: /termloop-hook` marker comments so the fork-discipline linter can spot them and so downstream phases know what to move.

## Verified behaviors

- `./scripts/reload.sh --tag termloop-l10n` produces `** BUILD SUCCEEDED **`.
- `xcodebuild -project GhosttyTabs.xcodeproj -scheme termloop -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/termloop-termloop-l10n-verify build` also produces `** BUILD SUCCEEDED **` as a compile-only sanity check.
- Runtime localization rendering (string lookup actually hitting the `TermLoop` table at launch) will be verified by the user in a separate pass; Phase 2 intentionally does not launch the app.

## Gotchas

- The TermLoop.xcstrings file **must** be in the termloop target's "Copy Bundle Resources" phase. If a migrated UI element renders its raw key string at runtime, suspect missing target membership first — open Xcode, confirm the file is checked for the termloop target under File Inspector > Target Membership, clean, and rebuild.
- Adding a new TermLoop key: add it to `Resources/TermLoop.xcstrings` (Xcode can edit it directly), and use `table: "TermLoop"` at every call-site. Do **not** add TermLoop keys to `Resources/Localizable.xcstrings` — that file is reserved for upstream strings to keep the fork merge-clean.

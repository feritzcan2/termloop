// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Which files participate in the mirror and which of them is canonical.
///
/// `canonical == nil` means "per folder": whichever tracked file exists
/// in a given folder becomes canonical; the rest are created as relative
/// symlinks to it. When multiple tracked files exist as regular files with
/// identical content, the one with the newest mtime wins.
struct ContextBankSymlinkConfig: Equatable {
    var tracked: Set<String>
    var canonical: String?
    /// When true, divergent regular files and stale symlinks are replaced with
    /// fresh symlinks to the canonical sibling. Originals are moved to the
    /// system Trash so the user can recover them if the override was wrong.
    var forceOverwriteDivergent: Bool

    static let defaultConfig = ContextBankSymlinkConfig(
        tracked: Set(ContextBankFile.Kind.allFileNames),
        canonical: nil,
        forceOverwriteDivergent: false
    )

    var summaryTitle: String {
        if let canonical { return "\(canonical) is the source" }
        return "Mirror (per folder)"
    }
}

struct ContextBankSymlinkPlanItem: Identifiable, Equatable {
    enum Action: Equatable {
        /// Create a new symlink at `linkName` pointing to `targetName`.
        case create
        /// Both files are regular with identical content — delete the
        /// non-canonical file and replace it with a symlink to the canonical
        /// sibling.
        case convertToSymlink
        /// User opted into force fix: divergent regular file or stale symlink
        /// is moved to Trash and replaced with a symlink to the canonical
        /// sibling.
        case forceOverwriteDivergent
        /// A symlink pointing to the canonical sibling is already in place.
        case skipAlreadyLinked
        /// Two or more regular files exist with divergent content. The user
        /// must reconcile manually.
        case skipDivergentPair
        /// Canonical source missing in this folder for the chosen direction.
        case skipDirectionMismatch

        var symbolName: String {
            switch self {
            case .create: return "plus.circle.fill"
            case .convertToSymlink: return "arrow.triangle.2.circlepath"
            case .forceOverwriteDivergent: return "trash.fill"
            case .skipAlreadyLinked: return "link"
            case .skipDivergentPair: return "exclamationmark.triangle.fill"
            case .skipDirectionMismatch: return "minus.circle"
            }
        }
    }

    let id: UUID
    let directoryPath: String
    let linkName: String
    let targetName: String
    let action: Action
    let absoluteLinkPath: String

    init(directoryPath: String, linkName: String, targetName: String, action: Action) {
        self.id = UUID()
        self.directoryPath = directoryPath
        self.linkName = linkName
        self.targetName = targetName
        self.action = action
        self.absoluteLinkPath = (directoryPath as NSString).appendingPathComponent(linkName)
    }
}

struct ContextBankSymlinkPlan {
    let items: [ContextBankSymlinkPlanItem]

    var createCount: Int { items.filter { $0.action == .create }.count }
    var convertCount: Int { items.filter { $0.action == .convertToSymlink }.count }
    var forceCount: Int { items.filter { $0.action == .forceOverwriteDivergent }.count }
    var actionableCount: Int { createCount + convertCount + forceCount }
    var alreadyLinkedCount: Int { items.filter { $0.action == .skipAlreadyLinked }.count }
    var divergentCount: Int { items.filter { $0.action == .skipDivergentPair }.count }
    var mismatchCount: Int { items.filter { $0.action == .skipDirectionMismatch }.count }
    var isEmpty: Bool { items.isEmpty }
    var hasWork: Bool { actionableCount > 0 }
}

enum ContextBankSymlinker {
    private enum FileKind: Equatable {
        case missing
        case regular
        case symlink(target: String)

        var isRegular: Bool {
            if case .regular = self { return true }
            return false
        }

        var isSymlink: Bool {
            if case .symlink = self { return true }
            return false
        }
    }

    static func plan(
        projectRoot: URL,
        config: ContextBankSymlinkConfig
    ) -> ContextBankSymlinkPlan {
        guard !config.tracked.isEmpty else {
            return ContextBankSymlinkPlan(items: [])
        }
        let tracked = config.tracked

        let fm = FileManager.default
        var dirs: Set<String> = []

        let keys: [URLResourceKey] = [.isDirectoryKey, .nameKey]
        let enumerator = fm.enumerator(
            at: projectRoot.standardizedFileURL,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles]
        )

        while let url = enumerator?.nextObject() as? URL {
            if Task.isCancelled { return ContextBankSymlinkPlan(items: []) }
            let values = try? url.resourceValues(forKeys: Set(keys))
            let name = values?.name ?? url.lastPathComponent
            let isDir = values?.isDirectory ?? false

            if isDir {
                if ContextBankIndexer.prunedDirectoryNames.contains(name) {
                    enumerator?.skipDescendants()
                }
                continue
            }
            if tracked.contains(name) {
                dirs.insert(url.deletingLastPathComponent().path)
            }
        }

        var items: [ContextBankSymlinkPlanItem] = []
        for dir in dirs.sorted() {
            var kinds: [String: FileKind] = [:]
            for name in tracked {
                let path = (dir as NSString).appendingPathComponent(name)
                kinds[name] = Self.kind(at: path)
            }
            items.append(contentsOf: Self.itemsFor(dir: dir, kinds: kinds, config: config))
        }
        return ContextBankSymlinkPlan(items: items)
    }

    @discardableResult
    static func apply(_ plan: ContextBankSymlinkPlan) -> Int {
        var applied = 0
        let fm = FileManager.default
        for item in plan.items {
            switch item.action {
            case .create:
                guard !fm.fileExists(atPath: item.absoluteLinkPath) else { continue }
                if (try? fm.createSymbolicLink(
                    atPath: item.absoluteLinkPath,
                    withDestinationPath: item.targetName
                )) != nil {
                    applied += 1
                }

            case .convertToSymlink:
                let targetPath = (item.directoryPath as NSString)
                    .appendingPathComponent(item.targetName)
                // Defense in depth: confirm identity at apply time.
                guard Self.contentIdentical(item.absoluteLinkPath, targetPath) else {
                    continue
                }
                guard (try? fm.removeItem(atPath: item.absoluteLinkPath)) != nil else {
                    continue
                }
                if (try? fm.createSymbolicLink(
                    atPath: item.absoluteLinkPath,
                    withDestinationPath: item.targetName
                )) != nil {
                    applied += 1
                }

            case .forceOverwriteDivergent:
                // Trash the existing file/symlink so the user can recover it,
                // then create a fresh symlink to the canonical sibling. If the
                // trash step fails, abort this row — never silently delete.
                let url = URL(fileURLWithPath: item.absoluteLinkPath)
                guard (try? fm.trashItem(at: url, resultingItemURL: nil)) != nil else {
                    continue
                }
                if (try? fm.createSymbolicLink(
                    atPath: item.absoluteLinkPath,
                    withDestinationPath: item.targetName
                )) != nil {
                    applied += 1
                }

            case .skipAlreadyLinked, .skipDivergentPair, .skipDirectionMismatch:
                continue
            }
        }
        return applied
    }

    // MARK: - Per-folder decision

    private static func itemsFor(
        dir: String,
        kinds: [String: FileKind],
        config: ContextBankSymlinkConfig
    ) -> [ContextBankSymlinkPlanItem] {
        let tracked = config.tracked

        let regulars = tracked.filter { (kinds[$0] ?? .missing).isRegular }
        let symlinks = tracked.filter { (kinds[$0] ?? .missing).isSymlink }

        // Pick canonical per the user's config.
        let canonical: String?
        if let fixed = config.canonical, tracked.contains(fixed) {
            canonical = [regulars, symlinks]
                .flatMap { $0 }
                .contains(fixed) ? fixed : nil
        } else {
            canonical = Self.pickCanonicalByMtime(among: Array(regulars), dir: dir)
                ?? Array(regulars).sorted().first
                ?? Array(symlinks).sorted().first
        }

        guard let canonical else {
            // Chosen canonical isn't here — nothing to link against.
            var items: [ContextBankSymlinkPlanItem] = []
            if let fixed = config.canonical, !fixed.isEmpty {
                for name in tracked.sorted() where kinds[name] != .missing {
                    items.append(ContextBankSymlinkPlanItem(
                        directoryPath: dir,
                        linkName: name,
                        targetName: fixed,
                        action: .skipDirectionMismatch
                    ))
                }
            }
            return items
        }

        // Divergent check: more than one regular file and at least one differs
        // from canonical's content.
        let canonicalPath = (dir as NSString).appendingPathComponent(canonical)
        var divergentPartners: [String] = []
        for name in regulars where name != canonical {
            let path = (dir as NSString).appendingPathComponent(name)
            if !contentIdentical(path, canonicalPath) {
                divergentPartners.append(name)
            }
        }

        var items: [ContextBankSymlinkPlanItem] = []

        if !divergentPartners.isEmpty {
            let divergentAction: ContextBankSymlinkPlanItem.Action =
                config.forceOverwriteDivergent ? .forceOverwriteDivergent : .skipDivergentPair
            for name in divergentPartners.sorted() {
                items.append(ContextBankSymlinkPlanItem(
                    directoryPath: dir,
                    linkName: name,
                    targetName: canonical,
                    action: divergentAction
                ))
            }
        }

        // Handle each tracked file that isn't the canonical.
        for name in tracked.sorted() where name != canonical {
            if divergentPartners.contains(name) { continue }
            let kind = kinds[name] ?? .missing
            switch kind {
            case .missing:
                items.append(ContextBankSymlinkPlanItem(
                    directoryPath: dir,
                    linkName: name,
                    targetName: canonical,
                    action: .create
                ))
            case .regular:
                // Identical to canonical (already filtered above) — convert.
                items.append(ContextBankSymlinkPlanItem(
                    directoryPath: dir,
                    linkName: name,
                    targetName: canonical,
                    action: .convertToSymlink
                ))
            case .symlink(let target):
                // A stale symlink pointing somewhere other than the chosen
                // canonical shouldn't be reported as "already linked" — it's
                // a mismatch that needs reconciliation. With force on, we
                // retarget it to the canonical (the link itself goes to Trash
                // before we recreate it).
                let action: ContextBankSymlinkPlanItem.Action =
                    (target == canonical) ? .skipAlreadyLinked
                    : (config.forceOverwriteDivergent ? .forceOverwriteDivergent : .skipDivergentPair)
                items.append(ContextBankSymlinkPlanItem(
                    directoryPath: dir,
                    linkName: name,
                    targetName: action == .forceOverwriteDivergent ? canonical : target,
                    action: action
                ))
            }
        }

        return items
    }

    private static func pickCanonicalByMtime(among names: [String], dir: String) -> String? {
        guard !names.isEmpty else { return nil }
        var best: (name: String, mtime: Date)?
        for name in names {
            let path = (dir as NSString).appendingPathComponent(name)
            let mtime = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)
                ?? .distantPast
            if best == nil || mtime > best!.mtime {
                best = (name, mtime)
            }
        }
        return best?.name
    }

    // MARK: - Primitives

    private static func kind(at path: String) -> FileKind {
        guard FileManager.default.fileExists(atPath: path) else {
            // `fileExists` follows symlinks; use attributes for the real truth.
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let type = attrs[.type] as? FileAttributeType,
               type == .typeSymbolicLink {
                let target = (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) ?? ""
                return .symlink(target: target)
            }
            return .missing
        }
        if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
           let type = attrs[.type] as? FileAttributeType,
           type == .typeSymbolicLink {
            let target = (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) ?? ""
            return .symlink(target: target)
        }
        return .regular
    }

    private static func contentIdentical(_ lhs: String, _ rhs: String) -> Bool {
        let fm = FileManager.default
        let lsize = (try? fm.attributesOfItem(atPath: lhs)[.size] as? Int) ?? -1
        let rsize = (try? fm.attributesOfItem(atPath: rhs)[.size] as? Int) ?? -2
        guard lsize == rsize, lsize >= 0 else { return false }
        guard let a = try? Data(contentsOf: URL(fileURLWithPath: lhs)),
              let b = try? Data(contentsOf: URL(fileURLWithPath: rhs))
        else { return false }
        return a == b
    }

}

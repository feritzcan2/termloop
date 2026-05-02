// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Which files participate in the mirror and which of them is canonical.
///
/// `canonical == nil` means "per folder": whichever tracked regular file
/// exists in a given folder becomes canonical; the rest are created as
/// real file copies from it. When multiple tracked files exist as regular
/// files with identical content, the one with the newest mtime wins.
struct ContextBankMirrorConfig: Equatable {
    var tracked: Set<String>
    var canonical: String?
    /// When true, divergent regular files are replaced with fresh copies of
    /// the canonical sibling. Originals are moved to the system Trash so the
    /// user can recover them if the override was wrong.
    var forceOverwriteDivergent: Bool

    static let defaultConfig = ContextBankMirrorConfig(
        tracked: Set(ContextBankFile.Kind.allFileNames),
        canonical: nil,
        forceOverwriteDivergent: false
    )

    var summaryTitle: String {
        if let canonical { return "\(canonical) is the source" }
        return "Mirror (per folder)"
    }
}

struct ContextBankMirrorPlanItem: Identifiable, Equatable {
    enum Action: Equatable {
        /// Create a new real file at `linkName` by copying `targetName`.
        case createCopy
        /// Replace an existing symlink with a real file copy of `targetName`.
        case replaceWithCopy
        /// User opted into force fix: divergent regular file is moved to
        /// Trash and replaced with a real file copy of the canonical sibling.
        case forceOverwriteDivergent
        /// A regular file with identical content is already in place.
        case skipAlreadyMirrored
        /// Two or more regular files exist with divergent content. The user
        /// must reconcile manually.
        case skipDivergentPair
        /// Canonical source missing in this folder for the chosen direction.
        case skipDirectionMismatch

        var symbolName: String {
            switch self {
            case .createCopy: return "plus.circle.fill"
            case .replaceWithCopy: return "arrow.triangle.2.circlepath"
            case .forceOverwriteDivergent: return "trash.fill"
            case .skipAlreadyMirrored: return "doc.on.doc"
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

struct ContextBankMirrorPlan {
    let items: [ContextBankMirrorPlanItem]

    var createCount: Int { items.filter { $0.action == .createCopy }.count }
    var convertCount: Int { items.filter { $0.action == .replaceWithCopy }.count }
    var forceCount: Int { items.filter { $0.action == .forceOverwriteDivergent }.count }
    var actionableCount: Int { createCount + convertCount + forceCount }
    var alreadyMirroredCount: Int { items.filter { $0.action == .skipAlreadyMirrored }.count }
    var divergentCount: Int { items.filter { $0.action == .skipDivergentPair }.count }
    var mismatchCount: Int { items.filter { $0.action == .skipDirectionMismatch }.count }
    var isEmpty: Bool { items.isEmpty }
    var hasWork: Bool { actionableCount > 0 }
}

enum ContextBankMirrorPlanner {
    private enum FileKind: Equatable {
        case missing
        case regular
        case symlink(target: String)

        var isRegular: Bool {
            if case .regular = self { return true }
            return false
        }
    }

    static func plan(
        projectRoot: URL,
        config: ContextBankMirrorConfig
    ) -> ContextBankMirrorPlan {
        guard !config.tracked.isEmpty else {
            return ContextBankMirrorPlan(items: [])
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
            if Task.isCancelled { return ContextBankMirrorPlan(items: []) }
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

        var items: [ContextBankMirrorPlanItem] = []
        for dir in dirs.sorted() {
            var kinds: [String: FileKind] = [:]
            for name in tracked {
                let path = (dir as NSString).appendingPathComponent(name)
                kinds[name] = Self.kind(at: path)
            }
            items.append(contentsOf: Self.itemsFor(dir: dir, kinds: kinds, config: config))
        }
        return ContextBankMirrorPlan(items: items)
    }

    @discardableResult
    static func apply(_ plan: ContextBankMirrorPlan) -> Int {
        var applied = 0
        let fm = FileManager.default
        for item in plan.items {
            switch item.action {
            case .createCopy:
                guard !fm.fileExists(atPath: item.absoluteLinkPath) else { continue }
                let targetPath = (item.directoryPath as NSString)
                    .appendingPathComponent(item.targetName)
                guard Self.isRegularFile(at: targetPath) else { continue }
                if Self.copyRegularFile(from: targetPath, to: item.absoluteLinkPath) {
                    applied += 1
                }

            case .replaceWithCopy:
                let targetPath = (item.directoryPath as NSString)
                    .appendingPathComponent(item.targetName)
                guard Self.isRegularFile(at: targetPath) else {
                    continue
                }
                guard (try? fm.removeItem(atPath: item.absoluteLinkPath)) != nil else {
                    continue
                }
                if Self.copyRegularFile(from: targetPath, to: item.absoluteLinkPath) {
                    applied += 1
                }

            case .forceOverwriteDivergent:
                // Trash the existing file so the user can recover it, then
                // create a fresh copy of the canonical sibling. If the trash
                // step fails, abort this row — never silently delete.
                let targetPath = (item.directoryPath as NSString)
                    .appendingPathComponent(item.targetName)
                guard Self.isRegularFile(at: targetPath) else { continue }
                let url = URL(fileURLWithPath: item.absoluteLinkPath)
                guard (try? fm.trashItem(at: url, resultingItemURL: nil)) != nil else {
                    continue
                }
                if Self.copyRegularFile(from: targetPath, to: item.absoluteLinkPath) {
                    applied += 1
                }

            case .skipAlreadyMirrored, .skipDivergentPair, .skipDirectionMismatch:
                continue
            }
        }
        return applied
    }

    // MARK: - Per-folder decision

    private static func itemsFor(
        dir: String,
        kinds: [String: FileKind],
        config: ContextBankMirrorConfig
    ) -> [ContextBankMirrorPlanItem] {
        let tracked = config.tracked

        let regulars = tracked.filter { (kinds[$0] ?? .missing).isRegular }

        // Pick canonical per the user's config.
        let canonical: String?
        if let fixed = config.canonical, tracked.contains(fixed) {
            canonical = regulars.contains(fixed) ? fixed : nil
        } else {
            canonical = Self.pickCanonicalByMtime(among: Array(regulars), dir: dir)
                ?? Array(regulars).sorted().first
        }

        guard let canonical else {
            // Chosen canonical isn't here as a regular file — nothing safe to
            // link against. A symlink-only folder may already be dangling or
            // part of a chain, so never create more links to it.
            var items: [ContextBankMirrorPlanItem] = []
            if let fixed = config.canonical, !fixed.isEmpty {
                for name in tracked.sorted() where kinds[name] != .missing {
                    items.append(ContextBankMirrorPlanItem(
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

        var items: [ContextBankMirrorPlanItem] = []

        if !divergentPartners.isEmpty {
            let divergentAction: ContextBankMirrorPlanItem.Action =
                config.forceOverwriteDivergent ? .forceOverwriteDivergent : .skipDivergentPair
            for name in divergentPartners.sorted() {
                items.append(ContextBankMirrorPlanItem(
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
                items.append(ContextBankMirrorPlanItem(
                    directoryPath: dir,
                    linkName: name,
                    targetName: canonical,
                    action: .createCopy
                ))
            case .regular:
                // Identical to canonical (already filtered above).
                items.append(ContextBankMirrorPlanItem(
                    directoryPath: dir,
                    linkName: name,
                    targetName: canonical,
                    action: .skipAlreadyMirrored
                ))
            case .symlink:
                // Legacy symlinks are always migrated to real files. A copied
                // mirror is robust across repo renames, archive tools, and
                // tools that do not preserve symlink targets.
                items.append(ContextBankMirrorPlanItem(
                    directoryPath: dir,
                    linkName: name,
                    targetName: canonical,
                    action: .replaceWithCopy
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

    private static func isRegularFile(at path: String) -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let type = attrs[.type] as? FileAttributeType
        else { return false }
        return type == .typeRegular
    }

    private static func copyRegularFile(from sourcePath: String, to destinationPath: String) -> Bool {
        guard isRegularFile(at: sourcePath) else { return false }
        do {
            try FileManager.default.copyItem(atPath: sourcePath, toPath: destinationPath)
            return isRegularFile(at: destinationPath)
        } catch {
            return false
        }
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

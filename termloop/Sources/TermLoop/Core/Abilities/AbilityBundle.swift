import Foundation

struct AbilityBundleManifest: Codable {
    var id: String
    var name: String
    var description: String
    var activation: AbilityActivation
    var tags: [String]
    var items: [AbilityItem]
    var instructionFile: String
    var termLoopMCPTools: [AbilityMCPToolBinding]
    var bindings: [AbilityBinding]

    static let defaultInstructionFile = "instructions.md"
    static let systemReminderFile = "system-reminder.md"
    static let customizerPromptFile = "prompt-customizer.md"

    private enum CodingKeys: String, CodingKey {
        case id, name, description, activation, tags, items, instructionFile, termLoopMCPTools, bindings
    }

    init(
        id: String,
        name: String,
        description: String,
        activation: AbilityActivation,
        tags: [String],
        items: [AbilityItem],
        instructionFile: String = AbilityBundleManifest.defaultInstructionFile,
        termLoopMCPTools: [AbilityMCPToolBinding] = [],
        bindings: [AbilityBinding] = []
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.activation = activation
        self.tags = tags
        self.items = items
        self.instructionFile = instructionFile
        self.termLoopMCPTools = termLoopMCPTools
        self.bindings = bindings
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.description = try c.decode(String.self, forKey: .description)
        self.activation = try c.decode(AbilityActivation.self, forKey: .activation)
        self.tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        self.instructionFile = try c.decodeIfPresent(String.self, forKey: .instructionFile)
            ?? AbilityBundleManifest.defaultInstructionFile
        self.termLoopMCPTools = try c.decodeIfPresent(
            [AbilityMCPToolBinding].self,
            forKey: .termLoopMCPTools
        ) ?? []
        self.bindings = try c.decodeIfPresent([AbilityBinding].self, forKey: .bindings) ?? []

        if c.contains(.items) {
            var items: [AbilityItem] = []
            var unkeyed = try c.nestedUnkeyedContainer(forKey: .items)
            while !unkeyed.isAtEnd {
                let beforeIndex = unkeyed.currentIndex
                if let item = try? unkeyed.decode(AbilityItem.self) {
                    items.append(item)
                    continue
                }
                _ = try? unkeyed.decode(SkippedJSONValue.self)
                if unkeyed.currentIndex == beforeIndex {
                    // Defensive: never loop on a slot neither decoder consumed.
                    break
                }
            }
            self.items = items
        } else {
            self.items = []
        }
    }
}

/// Consumes any single JSON value (object, array, scalar, null) so the unkeyed
/// container's index advances when a `StoredAbilityItem` decode fails on an
/// unknown manifest entry.
private struct SkippedJSONValue: Decodable {
    init(from decoder: Decoder) throws {
        if var unkeyed = try? decoder.unkeyedContainer() {
            while !unkeyed.isAtEnd { _ = try? unkeyed.decode(SkippedJSONValue.self) }
            return
        }
        if let keyed = try? decoder.container(keyedBy: AnyKey.self) {
            for k in keyed.allKeys { _ = try? keyed.decode(SkippedJSONValue.self, forKey: k) }
            return
        }
        let single = try decoder.singleValueContainer()
        if single.decodeNil() { return }
        if (try? single.decode(Bool.self)) != nil { return }
        if (try? single.decode(Double.self)) != nil { return }
        if (try? single.decode(String.self)) != nil { return }
    }

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { self.intValue = intValue; self.stringValue = "\(intValue)" }
    }
}

enum AbilityBundleStore {
    static func load(from directoryURL: URL) throws -> Ability {
        let manifestURL = directoryURL.appendingPathComponent("ability.json")
        let manifestData = try Data(contentsOf: manifestURL)
        let manifest = try JSONDecoder().decode(AbilityBundleManifest.self, from: manifestData)
        let bodyURL = directoryURL.appendingPathComponent(manifest.instructionFile)
        let body = (try? String(contentsOf: bodyURL, encoding: .utf8)) ?? ""

        let systemReminderURL = directoryURL.appendingPathComponent(AbilityBundleManifest.systemReminderFile)
        let systemReminderBody: String? = readOptionalMarkdown(at: systemReminderURL)

        let customizerURL = directoryURL.appendingPathComponent(AbilityBundleManifest.customizerPromptFile)
        let customizerPromptBody: String? = readOptionalMarkdown(at: customizerURL)

        return Ability(
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            activation: manifest.activation,
            body: body,
            systemReminderBody: systemReminderBody,
            customizerPromptBody: customizerPromptBody,
            tags: manifest.tags,
            items: manifest.items,
            mcpTools: manifest.termLoopMCPTools,
            bindings: manifest.bindings,
            filePath: bodyURL,
            metadataFilePath: manifestURL,
            storageKind: .bundle
        )
    }

    private static func readOptionalMarkdown(at url: URL) -> String? {
        guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : raw
    }

    static func save(_ ability: Ability) throws {
        let bundleURL = ability.metadataFilePath.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)

        let manifest = AbilityBundleManifest(
            id: ability.id,
            name: ability.name,
            description: ability.description,
            activation: ability.activation,
            tags: ability.tags,
            items: ability.items,
            instructionFile: relativeInstructionPath(for: ability),
            termLoopMCPTools: ability.mcpTools,
            bindings: ability.bindings
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(manifest)
        try data.write(to: ability.metadataFilePath, options: .atomic)
        // Only persist `instructions.md` when there is actual content. Empty
        // body means the ability is skill-backed and its instruction file is
        // intentionally absent — writing zero bytes would just resurrect the
        // legacy file on every save.
        try writeOrRemove(
            content: ability.body,
            at: ability.filePath
        )

        try writeOrRemove(
            content: ability.systemReminderBody,
            at: bundleURL.appendingPathComponent(AbilityBundleManifest.systemReminderFile)
        )
        try writeOrRemove(
            content: ability.customizerPromptBody,
            at: bundleURL.appendingPathComponent(AbilityBundleManifest.customizerPromptFile)
        )
    }

    private static func writeOrRemove(content: String?, at url: URL) throws {
        if let content,
           !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }

    static func bundleDirectoryURL(parentDirectory: URL, slug: String) -> URL {
        parentDirectory.appendingPathComponent(slug, isDirectory: true)
    }

    static func instructionFileURL(parentDirectory: URL, slug: String) -> URL {
        bundleDirectoryURL(parentDirectory: parentDirectory, slug: slug)
            .appendingPathComponent(AbilityBundleManifest.defaultInstructionFile)
    }

    static func metadataFileURL(parentDirectory: URL, slug: String) -> URL {
        bundleDirectoryURL(parentDirectory: parentDirectory, slug: slug)
            .appendingPathComponent("ability.json")
    }

    private static func relativeInstructionPath(for ability: Ability) -> String {
        let bundleURL = ability.metadataFilePath.deletingLastPathComponent()
        let bundlePath = bundleURL.path.hasSuffix("/") ? bundleURL.path : bundleURL.path + "/"
        let filePath = ability.filePath.path
        if filePath.hasPrefix(bundlePath) {
            return String(filePath.dropFirst(bundlePath.count))
        }
        return ability.filePath.lastPathComponent
    }
}

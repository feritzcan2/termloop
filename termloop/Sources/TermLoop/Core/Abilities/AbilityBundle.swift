import Foundation

struct AbilityBundleManifest: Codable {
    var id: String
    var name: String
    var description: String
    var activation: AbilityActivation
    var tags: [String]
    var items: [AbilityItem]
    var termLoopMCPTools: [AbilityMCPToolBinding]

    static let customizerPromptFile = "prompt-customizer.md"
    static let payloadDirectoryName = "payload"

    private enum CodingKeys: String, CodingKey {
        case id, name, description, activation, tags, items, termLoopMCPTools
    }

    init(
        id: String,
        name: String,
        description: String,
        activation: AbilityActivation,
        tags: [String],
        items: [AbilityItem],
        termLoopMCPTools: [AbilityMCPToolBinding] = []
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.activation = activation
        self.tags = tags
        self.items = items
        self.termLoopMCPTools = termLoopMCPTools
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.description = try c.decode(String.self, forKey: .description)
        self.activation = try c.decode(AbilityActivation.self, forKey: .activation)
        self.tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        self.termLoopMCPTools = try c.decodeIfPresent(
            [AbilityMCPToolBinding].self,
            forKey: .termLoopMCPTools
        ) ?? []

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

        let customizerURL = directoryURL.appendingPathComponent(AbilityBundleManifest.customizerPromptFile)
        let customizerPromptBody: String? = readOptionalMarkdown(at: customizerURL)
        let payloadBlocks = loadPayloadBlocks(from: directoryURL)

        return Ability(
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            activation: manifest.activation,
            customizerPromptBody: customizerPromptBody,
            payloadBlocks: payloadBlocks,
            tags: manifest.tags,
            items: manifest.items,
            mcpTools: manifest.termLoopMCPTools,
            metadataFilePath: manifestURL
        )
    }

    static func loadPayloadBlocks(from bundleURL: URL) -> [AbilityPayloadBlock] {
        let payloadURL = bundleURL.appendingPathComponent(AbilityBundleManifest.payloadDirectoryName, isDirectory: true)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: payloadURL.path, isDirectory: &isDir),
              isDir.boolValue else { return [] }
        let files = ((try? FileManager.default.contentsOfDirectory(
            at: payloadURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? [])
            .filter { $0.pathExtension.lowercased() == "md" }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        return files.compactMap(loadPayloadBlock)
    }

    private static func loadPayloadBlock(from fileURL: URL) -> AbilityPayloadBlock? {
        guard let raw = try? String(contentsOf: fileURL, encoding: .utf8) else { return nil }
        let parsed = try? FrontmatterParser.parse(raw)
        let frontmatter = parsed?.frontmatter ?? [:]
        let fallbackTitle = humanizedPayloadTitle(fileURL.deletingPathExtension().lastPathComponent)
        let mcpToolName = stringValue(frontmatter["mcpTool"])?.nilIfBlank()
        return AbilityPayloadBlock(
            id: fileURL.deletingPathExtension().lastPathComponent,
            title: stringValue(frontmatter["title"])?.nilIfBlank() ?? fallbackTitle,
            description: stringValue(frontmatter["description"]) ?? "",
            enabled: boolValue(frontmatter["enabled"]) ?? true,
            body: parsed?.body ?? raw.trimmingCharacters(in: .whitespacesAndNewlines),
            fileURL: fileURL,
            mcpToolName: mcpToolName,
            includeInSkillFooter: boolValue(frontmatter["includeInSkillFooter"]) ?? (mcpToolName != nil)
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
            termLoopMCPTools: ability.mcpTools
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(manifest)
        try data.write(to: ability.metadataFilePath, options: .atomic)

        try writeOrRemove(
            content: ability.customizerPromptBody,
            at: bundleURL.appendingPathComponent(AbilityBundleManifest.customizerPromptFile)
        )
        for block in ability.payloadBlocks {
            try writePayloadBlock(block)
        }
    }

    private static func writeOrRemove(content: String?, at url: URL) throws {
        if let content,
           !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }

    static func writePayloadBlock(_ block: AbilityPayloadBlock) throws {
        try FileManager.default.createDirectory(
            at: block.fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let text = formatPayloadBlock(block)
        try text.write(to: block.fileURL, atomically: true, encoding: .utf8)
    }

    static func createPayloadBlock(in ability: Ability) throws -> AbilityPayloadBlock {
        let dir = payloadDirectoryURL(for: ability)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let nextIndex = nextPayloadBlockIndex(existing: ability.payloadBlocks.map(\.id))
        let id = String(format: "%03d-new-block", nextIndex)
        let block = AbilityPayloadBlock(
            id: id,
            title: "New block",
            description: "",
            enabled: true,
            body: "",
            fileURL: dir.appendingPathComponent("\(id).md")
        )
        try writePayloadBlock(block)
        return block
    }

    static func deletePayloadBlock(_ block: AbilityPayloadBlock) throws {
        try FileManager.default.removeItem(at: block.fileURL)
    }

    static func bundleDirectoryURL(parentDirectory: URL, slug: String) -> URL {
        parentDirectory.appendingPathComponent(slug, isDirectory: true)
    }

    static func metadataFileURL(parentDirectory: URL, slug: String) -> URL {
        bundleDirectoryURL(parentDirectory: parentDirectory, slug: slug)
            .appendingPathComponent("ability.json")
    }

    static func payloadDirectoryURL(for ability: Ability) -> URL {
        ability.metadataFilePath
            .deletingLastPathComponent()
            .appendingPathComponent(AbilityBundleManifest.payloadDirectoryName, isDirectory: true)
    }

    private static func formatPayloadBlock(_ block: AbilityPayloadBlock) -> String {
        var lines = [
            "---",
            "title: \(yamlString(block.title))",
            "description: \(yamlString(block.description))",
            "enabled: \(block.enabled ? "true" : "false")"
        ]
        if let mcpToolName = block.mcpToolName?.nilIfBlank() {
            lines.append("mcpTool: \(yamlString(mcpToolName))")
        }
        if block.includeInSkillFooter || block.mcpToolName?.nilIfBlank() != nil {
            lines.append("includeInSkillFooter: \(block.includeInSkillFooter ? "true" : "false")")
        }
        lines.append("---")
        lines.append("")
        lines.append(block.body.trimmingCharacters(in: .whitespacesAndNewlines))
        lines.append("")
        return lines.joined(separator: "\n")
    }

    private static func yamlString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    private static func stringValue(_ value: Any?) -> String? {
        value as? String
    }

    private static func boolValue(_ value: Any?) -> Bool? {
        value as? Bool
    }

    private static func nextPayloadBlockIndex(existing ids: [String]) -> Int {
        let existingIndexes = ids.compactMap { id -> Int? in
            let prefix = id.prefix { $0.isNumber }
            return prefix.isEmpty ? nil : Int(prefix)
        }
        return ((existingIndexes.max() ?? 0) + 10)
    }

    private static func humanizedPayloadTitle(_ id: String) -> String {
        let withoutIndex = id.replacingOccurrences(of: #"^\d+[-_]*"#, with: "", options: .regularExpression)
        let words = withoutIndex
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
        guard !words.isEmpty else { return "Payload block" }
        return String(words.prefix(1)).uppercased() + String(words.dropFirst())
    }
}

private extension String {
    func nilIfBlank() -> String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

public enum DevServerProfileStoreError: Error, Equatable, LocalizedError {
    case unsupportedSchema(found: Int, supported: Int)
    case decodingFailed(String)
    case writeFailed(String)

    public var errorDescription: String? {
        switch self {
        case .unsupportedSchema(let found, let supported):
            return String(
                localized: "devservers.error.unsupportedSchema",
                defaultValue: "Unsupported dev server schema \(found). This TermLoop build supports up to \(supported).",
                table: "TermLoop"
            )
        case .decodingFailed(let message):
            return String(
                localized: "devservers.error.decodingFailed",
                defaultValue: "Could not read dev server profiles: \(message)",
                table: "TermLoop"
            )
        case .writeFailed(let message):
            return String(
                localized: "devservers.error.writeFailed",
                defaultValue: "Could not write dev server profiles: \(message)",
                table: "TermLoop"
            )
        }
    }
}

@MainActor
public final class DevServerProfileStore: ObservableObject {
    public let projectRoot: URL
    public let projectId: UUID

    @Published public private(set) var file: DevServerProfileFile = DevServerProfileFile()
    @Published public private(set) var loadError: DevServerProfileStoreError?

    public init(projectRoot: URL, projectId: UUID) {
        self.projectRoot = projectRoot
        self.projectId = projectId
    }

    public var profiles: [DevServerProfile] { file.profiles }
    public var defaults: DevServerDefaults { file.defaults }

    public func profile(id: String) -> DevServerProfile? {
        file.profile(id: id)
    }

    public func loadOrCreate() {
        let url = profileFileURL()
        guard FileManager.default.fileExists(atPath: url.path) else {
            file = DevServerProfileFile()
            loadError = nil
            return
        }

        do {
            let data = try Data(contentsOf: url)
            let schemaVersion: Int
            do {
                schemaVersion = try JSONDecoder.devServers.decode(
                    DevServerProfileSchemaHeader.self,
                    from: data
                ).schemaVersion
            } catch {
                throw DevServerProfileStoreError.decodingFailed(String(describing: error))
            }
            guard schemaVersion <= DevServerProfileFile.currentSchemaVersion else {
                throw DevServerProfileStoreError.unsupportedSchema(
                    found: schemaVersion,
                    supported: DevServerProfileFile.currentSchemaVersion
                )
            }
            file = try JSONDecoder.devServers.decode(DevServerProfileFile.self, from: data)
            loadError = nil
        } catch let error as DevServerProfileStoreError {
            file = DevServerProfileFile()
            loadError = error
        } catch {
            file = DevServerProfileFile()
            loadError = .decodingFailed(String(describing: error))
        }
    }

    public func saveNow() throws {
        file.updatedAt = Date()
        try writeAtomically()
        loadError = nil
        objectWillChange.send()
    }

    @discardableResult
    public func updateDefaults(_ block: (inout DevServerDefaults) -> Void) throws -> Bool {
        var next = file.defaults
        block(&next)
        guard next != file.defaults else { return false }
        file.defaults = next
        try saveNow()
        return true
    }

    @discardableResult
    public func upsert(_ profile: DevServerProfile) throws -> Bool {
        var next = file.profiles
        let old = next
        if let index = next.firstIndex(where: { $0.id == profile.id }) {
            next[index] = profile
        } else {
            next.append(profile)
        }
        next = DevServerProfileFile.normalizedProfiles(next)
        guard next != old else { return false }
        file.profiles = next
        try saveNow()
        return true
    }

    @discardableResult
    public func delete(profileId rawId: String) throws -> Bool {
        let id = DevServerProfile.normalizedId(rawId)
        let old = file.profiles
        file.profiles.removeAll { $0.id == id }
        guard file.profiles != old else { return false }
        try saveNow()
        return true
    }

    public func profileFileURL() -> URL {
        projectRoot.appendingPathComponent(".termloop/devservers.json")
    }

    private func writeAtomically() throws {
        try Self.write(file, to: profileFileURL())
    }

    private static func write(_ file: DevServerProfileFile, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data: Data
        do {
            data = try JSONEncoder.devServers.encode(file)
        } catch {
            throw DevServerProfileStoreError.writeFailed("encode: \(error)")
        }
        let tmp = url.appendingPathExtension("tmp-\(UUID().uuidString)")
        do {
            try data.write(to: tmp, options: .atomic)
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: url)
            }
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw DevServerProfileStoreError.writeFailed(String(describing: error))
        }
    }
}

extension JSONEncoder {
    static let devServers: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

extension JSONDecoder {
    static let devServers: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct IntegrationSet: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var itemIds: [String]
    var isDefault: Bool

    init(id: String = UUID().uuidString,
         name: String,
         itemIds: [String] = [],
         isDefault: Bool = false) {
        self.id = id
        self.name = name
        self.itemIds = itemIds
        self.isDefault = isDefault
    }
}

@MainActor
final class IntegrationSetStore: ObservableObject {
    static let shared = IntegrationSetStore()
    @Published private(set) var sets: [IntegrationSet] = []

    private init() { load() }

    func set(id: String) -> IntegrationSet? { sets.first { $0.id == id } }

    func defaultSet() -> IntegrationSet? { sets.first { $0.isDefault } }

    func upsert(_ set: IntegrationSet) {
        if let idx = sets.firstIndex(where: { $0.id == set.id }) {
            sets[idx] = set
        } else {
            sets.append(set)
        }
        if set.isDefault {
            for i in sets.indices where sets[i].id != set.id {
                sets[i].isDefault = false
            }
        }
        save()
    }

    func remove(id: String) {
        sets.removeAll { $0.id == id }
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: IntegrationsPaths.setsFile()) else { return }
        sets = (try? JSONDecoder().decode([IntegrationSet].self, from: data)) ?? []
    }

    private func save() {
        IntegrationsPaths.ensureSupportDir()
        guard let data = try? JSONEncoder().encode(sets) else { return }
        try? data.write(to: IntegrationsPaths.setsFile(), options: .atomic)
    }
}

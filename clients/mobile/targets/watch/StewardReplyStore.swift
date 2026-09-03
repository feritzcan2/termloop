import Foundation

/// A voice turn can outlive the Watch app's short foreground window. Keep the
/// user sequence that the Steward still owes a spoken reply for, scoped to the
/// exact Mac and Project, so reopening the app can finish the turn once.
enum StewardReplyStore {
    private static let defaultsKey = "pendingStewardVoiceReplies"

    static func sequence(connectionId: String, projectId: String) -> Int? {
        pendingReplies[targetKey(connectionId: connectionId, projectId: projectId)]
    }

    static func remember(sequence: Int, connectionId: String, projectId: String) {
        guard sequence > 0, !connectionId.isEmpty, !projectId.isEmpty else { return }
        var replies = pendingReplies
        replies[targetKey(connectionId: connectionId, projectId: projectId)] = sequence
        save(replies)
    }

    static func clear(sequence: Int, connectionId: String, projectId: String) {
        let key = targetKey(connectionId: connectionId, projectId: projectId)
        var replies = pendingReplies
        guard replies[key] == sequence else { return }
        replies.removeValue(forKey: key)
        save(replies)
    }

    private static var pendingReplies: [String: Int] {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let decoded = try? JSONDecoder().decode([String: Int].self, from: data)
        else { return [:] }
        return decoded
    }

    private static func save(_ replies: [String: Int]) {
        guard let data = try? JSONEncoder().encode(replies) else { return }
        UserDefaults.standard.set(data, forKey: defaultsKey)
    }

    private static func targetKey(connectionId: String, projectId: String) -> String {
        "\(connectionId)|\(projectId)"
    }
}

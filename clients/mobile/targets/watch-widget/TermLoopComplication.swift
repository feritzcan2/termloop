import SwiftUI
import WidgetKit

// Watch-face complication: how many agents are working and how many wait for
// input across every saved Mac. The widget reads the same multi-Mac Keychain
// snapshot as the watch app and aggregates reachable gateways concurrently.

struct AgentCounts {
    var working = 0
    var awaitingInput = 0

    static func fetch() async -> AgentCounts? {
        let credentials = loadCredentials()
        guard !credentials.isEmpty else { return nil }
        return await withTaskGroup(of: AgentCounts?.self) { group in
            for credential in credentials {
                group.addTask { await fetch(credential) }
            }
            var total = AgentCounts()
            var reachedAny = false
            for await counts in group {
                guard let counts else { continue }
                reachedAny = true
                total.working += counts.working
                total.awaitingInput += counts.awaitingInput
            }
            return reachedAny ? total : nil
        }
    }

    private struct StatusPayload: Codable {
        struct Session: Codable { let status: String }
        let sessions: [Session]
    }

    private struct StoredCredential: Codable {
        let id: String
        let name: String
        let host: String
        let token: String
        let targetProjectId: String?
    }

    private static func fetch(_ credential: StoredCredential) async -> AgentCounts? {
        guard let url = URL(string: "https://\(credential.host)/watch/status") else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let status = try? JSONDecoder().decode(StatusPayload.self, from: data)
        else { return nil }
        var counts = AgentCounts()
        for session in status.sessions {
            if session.status == "working" { counts.working += 1 }
            if session.status == "awaitingInput" { counts.awaitingInput += 1 }
        }
        return counts
    }

    private static func loadCredentials() -> [StoredCredential] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "ai.termloop.watch.gateway",
            kSecAttrAccount as String: "gateway",
            kSecAttrAccessGroup as String: "S9QXLS2NJ2.ai.termloop.watch.shared",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return [] }
        if let credentials = try? JSONDecoder().decode([StoredCredential].self, from: data) {
            return credentials
        }
        guard let parsed = try? JSONDecoder().decode([String: String].self, from: data),
              let host = parsed["host"], !host.isEmpty,
              let token = parsed["token"], !token.isEmpty
        else { return [] }
        return [StoredCredential(id: "legacy", name: host, host: host, token: token, targetProjectId: nil)]
    }
}

struct AgentEntry: TimelineEntry {
    let date: Date
    let counts: AgentCounts?
}

struct AgentTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> AgentEntry {
        AgentEntry(date: .now, counts: AgentCounts(working: 2, awaitingInput: 1))
    }

    func getSnapshot(in context: Context, completion: @escaping (AgentEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task { completion(AgentEntry(date: .now, counts: await AgentCounts.fetch())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AgentEntry>) -> Void) {
        Task {
            let entry = AgentEntry(date: .now, counts: await AgentCounts.fetch())
            let refresh = Calendar.current.date(byAdding: .minute, value: 15, to: .now) ?? .now
            completion(Timeline(entries: [entry], policy: .after(refresh)))
        }
    }
}

struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: AgentEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            VStack(spacing: 0) {
                Text("\(entry.counts?.working ?? 0)")
                    .font(.system(size: 16, weight: .bold))
                Text("\(entry.counts?.awaitingInput ?? 0)")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(entry.counts?.awaitingInput ?? 0 > 0 ? .orange : .secondary)
            }
            .containerBackground(.clear, for: .widget)
        case .accessoryInline:
            Text(inlineLabel)
                .containerBackground(.clear, for: .widget)
        default:
            VStack(alignment: .leading, spacing: 1) {
                Text("TermLoop").font(.system(size: 11, weight: .semibold))
                Text("\(entry.counts?.working ?? 0) çalışıyor")
                    .font(.system(size: 11))
                    .foregroundStyle(.green)
                Text("\(entry.counts?.awaitingInput ?? 0) girdi bekliyor")
                    .font(.system(size: 11))
                    .foregroundStyle(entry.counts?.awaitingInput ?? 0 > 0 ? .orange : .secondary)
            }
            .containerBackground(.clear, for: .widget)
        }
    }

    private var inlineLabel: String {
        guard let counts = entry.counts else { return "TermLoop" }
        return "▶︎\(counts.working) ✋\(counts.awaitingInput)"
    }
}

struct TermLoopComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TermLoopAgents", provider: AgentTimelineProvider()) { entry in
            ComplicationView(entry: entry)
        }
        .configurationDisplayName("TermLoop Agents")
        .description("Çalışan ve girdi bekleyen agent sayısı.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}

// One tap from the watch face opens the foreground app directly into one bounded
// Steward voice message. WidgetKit cannot own microphone capture, so this is the
// shortest watchOS-permitted path: tap, speak, pause, delivered.
struct StewTalkEntry: TimelineEntry {
    let date: Date
}

struct StewTalkProvider: TimelineProvider {
    func placeholder(in context: Context) -> StewTalkEntry { StewTalkEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (StewTalkEntry) -> Void) {
        completion(StewTalkEntry(date: .now))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<StewTalkEntry>) -> Void) {
        completion(Timeline(entries: [StewTalkEntry(date: .now)], policy: .never))
    }
}

struct StewTalkView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            if family == .accessoryInline {
                Text("🎙️ Stew'a söyle")
            } else {
                VStack(spacing: 0) {
                    Image(systemName: "mic.circle.fill")
                        .font(.system(size: 18, weight: .semibold))
                    Text("SÖYLE")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .widgetURL(URL(string: "termloop-watch://message"))
        .containerBackground(.clear, for: .widget)
    }
}

struct StewTalkComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TermLoopStewTalk", provider: StewTalkProvider()) { _ in
            StewTalkView()
        }
        .configurationDisplayName("Stew'a Söyle")
        .description("Tek dokunuşla Steward'a sesli mesaj kaydetmeye başlar.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline])
    }
}

struct ProjectAgentLaunchView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            if family == .accessoryInline {
                Text("🎤 Agent başlat")
            } else {
                VStack(spacing: 0) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 18, weight: .semibold))
                    Text("Agent")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .widgetURL(URL(string: "termloop-watch://launch-agent"))
        .containerBackground(.clear, for: .widget)
    }
}

struct ProjectAgentLaunchComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TermLoopProjectAgentLaunch", provider: StewTalkProvider()) { _ in
            ProjectAgentLaunchView()
        }
        .configurationDisplayName("Agent Başlat")
        .description("Önce sesli promptu alır, sonra agent ve projeyi seçtirir.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline])
    }
}

@main
struct TermLoopWidgets: WidgetBundle {
    var body: some Widget {
        ProjectAgentLaunchComplication()
        StewTalkComplication()
        TermLoopComplication()
    }
}

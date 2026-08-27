import SwiftUI

// Normally the paired iPhone provisions the watch silently over
// WatchConnectivity; this page just reports that state. The manual six-digit
// pair code (pnpm watch-pair-code on the Mac) stays as a fallback for setups
// without the TermLoop iPhone app.
struct SetupView: View {
    @ObservedObject private var appState = AppState.shared

    @State private var host = ""
    @State private var code = ""
    @State private var busy = false
    @State private var status = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text("❯")
                        .font(.mono(24, .bold))
                        .foregroundStyle(Theme.stew)
                    Text("TermLoop")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                }
                VStack(alignment: .leading, spacing: 4) {
                    if appState.hasConnections {
                        Label("\(appState.connections.count) Mac bağlı", systemImage: "checkmark.circle.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.phosphor)
                        ForEach(appState.connections) { connection in
                            HStack {
                                Circle().fill(Theme.phosphor).frame(width: 5, height: 5)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(connection.name).font(.system(size: 12, weight: .semibold))
                                    Text(connection.host).font(.mono(9)).foregroundStyle(.secondary)
                                }
                            }
                        }
                    } else {
                        Label("iPhone bekleniyor…", systemImage: "iphone.radiowaves.left.and.right")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.amber)
                        Text("Eşleşmiş iPhone'da TermLoop'u aç, ya da aşağıdan elle eşleş.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.graphite))
                TextField("Host (tailnet adı)", text: $host)
                TextField("Eşleşme kodu", text: $code)
                Button {
                    Task { await pair() }
                } label: {
                    Text(busy ? "Eşleşiyor…" : "Elle eşleş")
                        .font(.system(size: 14, weight: .semibold))
                }
                .tint(Theme.stew)
                .foregroundStyle(.black)
                .buttonStyle(.borderedProminent)
                .disabled(busy || host.isEmpty || code.count != 6)
                if !status.isEmpty {
                    Text(status).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("❯ kur")
    }

    private func pair() async {
        busy = true
        defer { busy = false }
        guard let base = GatewayAPI.baseURL(host: host),
              let url = URL(string: base.absoluteString + "/watch/pair")
        else {
            status = "Host adı geçersiz"
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["code": code])
        do {
            let (data, response) = try await GatewayAPI.session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let paired = try? JSONDecoder().decode(PairResponse.self, from: data)
            else {
                status = "Eşleşme reddedildi — yeni kod al"
                return
            }
            appState.upsertCredential(GatewayCredential(
                id: "manual_\(UUID().uuidString.replacingOccurrences(of: "-", with: "_"))",
                name: host.split(separator: ".").first.map(String.init) ?? "Mac",
                host: host,
                token: paired.token,
                targetProjectId: nil
            ))
            status = "Eşleşti"
            code = ""
        } catch {
            status = "TermLoop'a ulaşılamadı"
        }
    }
}

struct PairResponse: Codable {
    let paired: Bool
    let token: String
}

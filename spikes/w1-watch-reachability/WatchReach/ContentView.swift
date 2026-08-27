import SwiftUI
import WatchKit

struct ContentView: View {
    @ObservedObject private var appState = AppState.shared
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            SetupView().tag(0)
            WorktreesView().tag(1)
        }
        .tabViewStyle(.verticalPage)
        .onChange(of: appState.pendingWorktreeCwd) { _, newValue in
            if newValue != nil { tab = 1 }
        }
        .onAppear {
            if appState.pendingWorktreeCwd != nil { tab = 1 }
            if !UserDefaults.standard.string(forKey: "watchToken").isNilOrEmpty { tab = 1 }
        }
    }
}

extension String? {
    var isNilOrEmpty: Bool { self?.isEmpty ?? true }
}

struct SetupView: View {
    // Spike convenience: default to the owner's tailnet name so pairing only
    // needs the six-digit code. Editable for any other gateway host.
    @AppStorage("host") private var host = "ferits-macbook-pro.tail699a1f.ts.net"
    @AppStorage("watchToken") private var watchToken = ""
    @AppStorage("apnsToken") private var apnsToken = ""
    @AppStorage("apnsStatus") private var apnsStatus = "no attempt yet"

    @State private var code = ""
    @State private var busy = false
    @State private var status = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Host (tailnet name)", text: $host)
                TextField("Pair code", text: $code)
                Button(busy ? "Pairing…" : "Pair") {
                    Task { await pair() }
                }
                .disabled(busy || host.isEmpty || code.count != 6)
                Text(watchToken.isEmpty ? "Not paired" : "Paired ✓")
                    .font(.headline)
                    .foregroundStyle(watchToken.isEmpty ? .orange : .green)
                if !status.isEmpty {
                    Text(status).font(.footnote).foregroundStyle(.secondary)
                }
                Text("push: \(apnsToken.isEmpty ? "no token" : "token ✓") · \(apnsStatus)")
                    .font(.footnote)
                    .foregroundStyle(apnsToken.isEmpty ? .orange : .green)
            }
        }
    }

    private func pair() async {
        busy = true
        defer { busy = false }
        guard let base = SpikeAPI.baseURL(host: host),
              let url = URL(string: base.absoluteString + "/watch/pair")
        else {
            status = "Bad host"
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["code": code])
        do {
            let (data, response) = try await SpikeAPI.session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let paired = try? JSONDecoder().decode(PairResponse.self, from: data)
            else {
                status = "Pairing refused — new code?"
                return
            }
            watchToken = paired.token
            status = "Paired with gateway"
            code = ""
            AppDelegate.syncDeviceToken()
        } catch {
            status = "Error: \(error.localizedDescription)"
        }
    }
}

struct PairResponse: Codable {
    let paired: Bool
    let token: String
}

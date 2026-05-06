// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI
import UIKit

@main
struct TermLoopWatchAppPhoneApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PhoneSessionDelegate.shared.activate()
        NotificationManager.shared.bootstrap()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NotificationManager.shared.didReceiveDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NSLog("APNs registration failed: \(error)")
    }
}

struct ContentView: View {
    @ObservedObject private var settings = WatchAppSettings.shared
    @State private var testStatus: String?
    @State private var isTesting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("TermLoop Mac") {
                    TextField("Host (IP or .local)", text: $settings.host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Stepper("Port: \(settings.port)",
                            value: $settings.port, in: 1...65535)
                    SecureField("Socket password", text: $settings.password)
                }
                Section {
                    Button(action: testConnection) {
                        HStack {
                            Text("Test connection")
                            if isTesting { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(settings.endpoint == nil || isTesting)
                    if let testStatus {
                        Text(testStatus)
                            .font(.footnote)
                            .foregroundStyle(testStatus.hasPrefix("OK") ? .green : .red)
                    }
                }
                Section {
                    Text("Open the Watch app and tap **New Agent** to dictate a prompt. " +
                         "The Mac creates a fresh worktree and starts your default agent.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("TermLoop Watch")
        }
    }

    private func testConnection() {
        guard let endpoint = settings.endpoint else { return }
        isTesting = true
        testStatus = nil
        Task {
            let rpc = TermLoopRPC(endpoint: endpoint)
            do {
                try await rpc.ping()
                if let pending = settings.pendingPushToken {
                    let env = WatchAppSettings.apnsEnvironment
                    try? await rpc.registerPush(deviceToken: pending, environment: env)
                    settings.registeredPushFingerprint = WatchAppSettings.pushFingerprint(
                        token: pending, endpoint: endpoint, environment: env
                    )
                    settings.pendingPushToken = nil
                }
                await MainActor.run {
                    testStatus = "OK — connected"
                    isTesting = false
                }
            } catch {
                await MainActor.run {
                    testStatus = "Failed: \(error.localizedDescription)"
                    isTesting = false
                }
            }
        }
    }
}

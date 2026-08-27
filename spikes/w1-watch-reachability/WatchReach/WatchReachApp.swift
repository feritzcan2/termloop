import SwiftUI
import WatchKit
import UserNotifications

final class AppState: ObservableObject {
    static let shared = AppState()
    @Published var pendingWorktreeCwd: String?
}

final class AppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in
            // Register even if alerts were denied: the token is still issued.
            DispatchQueue.main.async {
                WKApplication.shared().registerForRemoteNotifications()
            }
        }
    }

    func applicationDidBecomeActive() {
        AppDelegate.syncDeviceToken()
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "apnsToken")
        AppDelegate.syncDeviceToken()
    }

    func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
        UserDefaults.standard.set("registration failed: \(error.localizedDescription)", forKey: "apnsStatus")
    }

    // Tap on a notification: deep-link to the worktree whose path contains the
    // session's working directory from the push payload.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        if let cwd = response.notification.request.content.userInfo["cwd"] as? String {
            await MainActor.run { AppState.shared.pendingWorktreeCwd = cwd }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    // Idempotent: registers the stored APNs token with the gateway whenever we
    // have one plus a paired credential. Retried on every activation because
    // the launch-time attempt can race network readiness and the pair flow.
    static func syncDeviceToken() {
        let defaults = UserDefaults.standard
        guard let apnsToken = defaults.string(forKey: "apnsToken"), !apnsToken.isEmpty,
              let watchToken = defaults.string(forKey: "watchToken"), !watchToken.isEmpty,
              let base = SpikeAPI.baseURL(host: defaults.string(forKey: "host") ?? ""),
              let url = URL(string: base.absoluteString + "/push/register")
        else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(watchToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONEncoder().encode([
            "deviceToken": apnsToken,
            "environment": "development",
            "bundleId": Bundle.main.bundleIdentifier ?? "ai.termloop.watchreach",
        ])
        SpikeAPI.session.dataTask(with: request) { _, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200 {
                UserDefaults.standard.set("registered with gateway", forKey: "apnsStatus")
            } else {
                UserDefaults.standard.set("gateway registration pending", forKey: "apnsStatus")
            }
        }.resume()
    }
}

@main
struct WatchReachApp: App {
    @WKApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

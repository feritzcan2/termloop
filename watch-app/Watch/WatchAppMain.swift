// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI
import WatchKit

@main
struct TermLoopWatchAppRoot: App {
    init() { WatchSessionClient.shared.activate() }
    var body: some Scene {
        WindowGroup { WatchRootView() }
    }
}

struct WatchRootView: View {
    enum Status: Equatable {
        case idle
        case sending
        case ok(branch: String)
        case error(String)
    }

    @State private var status: Status = .idle

    var body: some View {
        VStack(spacing: 8) {
            Spacer(minLength: 4)
            statusContent
            Spacer()
            Button(action: dictateAndSend) {
                Label("New Agent", systemImage: "mic.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(status == .sending)
        }
        .padding(.horizontal, 8)
    }

    @ViewBuilder
    private var statusContent: some View {
        switch status {
        case .idle:
            Text("TermLoop").font(.headline)
            Text("Tap to dictate a prompt. Mac creates a fresh worktree.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        case .sending:
            ProgressView()
            Text("Launching agent…").font(.footnote)
        case .ok(let branch):
            Image(systemName: "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(.green)
            Text(branch)
                .font(.caption)
                .lineLimit(2)
                .multilineTextAlignment(.center)
        case .error(let msg):
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title2)
                .foregroundStyle(.orange)
            Text(msg)
                .font(.caption2)
                .lineLimit(4)
                .multilineTextAlignment(.center)
        }
    }

    private func dictateAndSend() {
        guard let controller = WKExtension.shared().rootInterfaceController else {
            return
        }
        controller.presentTextInputController(
            withSuggestions: nil,
            allowedInputMode: .plain
        ) { results in
            let transcript = (results?.first as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !transcript.isEmpty else { return }
            send(prompt: transcript)
        }
    }

    private func send(prompt: String) {
        status = .sending
        Task {
            do {
                let branch = try await WatchSessionClient.shared.sendLaunch(prompt: prompt)
                await MainActor.run { status = .ok(branch: branch) }
            } catch {
                await MainActor.run {
                    status = .error(error.localizedDescription)
                }
            }
        }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct IntegrationsDetailPane: View {
    let item: IntegrationItem
    let onTest: () -> Void
    let onConfigure: () -> Void
    let onToggleAttach: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            Divider().opacity(0.2)
            metadataGrid
            Spacer(minLength: 8)
            actionRow
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Color.black.opacity(0.08))
        .overlay(Rectangle().frame(height: 1).foregroundColor(Color.primary.opacity(0.12)),
                 alignment: .top)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("[\(item.kind.shortTag)]")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundColor(.secondary)
            Text(item.displayName)
                .font(.system(size: 13, weight: .bold, design: .monospaced))
            Spacer()
            statusBadge
        }
    }

    private var statusBadge: some View {
        let label: String
        let color: Color
        switch item.status {
        case .ok(let msg): label = "OK · \(msg)"; color = .green
        case .fail(let reason): label = "FAIL · \(reason)"; color = .red
        case .running: label = "TESTING…"; color = .yellow
        case .notConfigured: label = "NOT CONFIGURED"; color = .gray
        case .idle: label = "IDLE"; color = .secondary
        }
        return Text(label)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundColor(color)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var metadataGrid: some View {
        VStack(alignment: .leading, spacing: 2) {
            row("summary", item.summary)
            if let bin = item.binaryPath { row("binary", bin) }
            if let version = item.version { row("version", version) }
            if let auth = item.authSubject { row("auth", auth) }
            if let lastTestedAt = item.lastTestedAt {
                row("last", relative(lastTestedAt))
            }
            row("attach", item.attachedToActiveSpawn ? "on" : "off")
            if !item.capabilities.isEmpty {
                row("caps", item.capabilities.prefix(6).joined(separator: ", "))
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.secondary)
                .frame(width: 54, alignment: .leading)
            Text(value)
                .font(.system(size: 10, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(3)
        }
    }

    private var actionRow: some View {
        HStack(spacing: 8) {
            Button(action: onTest) {
                Text(String(localized: "integrations.action.runTest",
                            defaultValue: "Run test", table: "TermLoop"))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 3)
                        .stroke(Color.primary.opacity(0.3), lineWidth: 1))
            }
            .buttonStyle(.plain)
            Button(action: onConfigure) {
                Text(String(localized: "integrations.action.configure",
                            defaultValue: "Configure…", table: "TermLoop"))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 3)
                        .stroke(Color.primary.opacity(0.3), lineWidth: 1))
            }
            .buttonStyle(.plain)
            Button(action: onToggleAttach) {
                Text(item.attachedToActiveSpawn
                     ? String(localized: "integrations.action.detachSpawn",
                              defaultValue: "Detach", table: "TermLoop")
                     : String(localized: "integrations.action.attachSpawn",
                              defaultValue: "Attach to spawn", table: "TermLoop"))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 3)
                        .fill(item.attachedToActiveSpawn ? Color.yellow.opacity(0.2) : Color.clear)
                        .overlay(RoundedRectangle(cornerRadius: 3)
                            .stroke(Color.primary.opacity(0.3), lineWidth: 1)))
            }
            .buttonStyle(.plain)
            Spacer()
        }
    }

    private func relative(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

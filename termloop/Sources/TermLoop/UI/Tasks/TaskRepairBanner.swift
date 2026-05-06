// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Compact repair callout shown when the selected task's provision state is
/// `.failed`. Surfaces three actions: rebind, unbind, archive.
struct TaskRepairBanner: View {
    let reason: String
    let onRebind: () -> Void
    let onUnbind: () -> Void
    let onArchive: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "wrench.and.screwdriver")
                    .foregroundColor(.orange)
                Text(reason)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.primary)
            }
            Text(String(localized: "tasks.repair.hint",
                        defaultValue: "Repair the binding, detach stale metadata, or archive this task.",
                        table: "TermLoop"))
                .font(.system(size: 10))
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Button(String(localized: "tasks.repair.rebind",
                              defaultValue: "Rebind", table: "TermLoop"),
                       action: onRebind)
                Button(String(localized: "tasks.repair.unbind",
                              defaultValue: "Unbind", table: "TermLoop"),
                       action: onUnbind)
                Button(String(localized: "tasks.repair.archive",
                              defaultValue: "Archive", table: "TermLoop"),
                       action: onArchive)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(9)
        .background(Color.orange.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.orange.opacity(0.22), lineWidth: 1)
        )
    }
}

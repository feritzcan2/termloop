// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Yellow banner shown in the sidebar drill-in when the selected task's
/// provision state is `.failed`. Surfaces three actions: rebind, unbind,
/// archive.
struct TaskRepairBanner: View {
    let reason: String
    let onRebind: () -> Void
    let onUnbind: () -> Void
    let onArchive: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(reason).font(.system(size: 11)).foregroundColor(.primary)
            HStack(spacing: 6) {
                Button(String(localized: "tasks.repair.rebind",
                              defaultValue: "Rebind…", table: "TermLoop"),
                       action: onRebind)
                Button(String(localized: "tasks.repair.unbind",
                              defaultValue: "Unbind", table: "TermLoop"),
                       action: onUnbind)
                Button(String(localized: "tasks.repair.archive",
                              defaultValue: "Archive", table: "TermLoop"),
                       action: onArchive)
            }
            .font(.system(size: 11))
        }
        .padding(8)
        .background(Color.yellow.opacity(0.18))
        .cornerRadius(4)
    }
}

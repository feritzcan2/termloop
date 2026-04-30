// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

@MainActor
struct SidebarDeleteConfirmationPopover: View {
    let title: String
    let message: String
    let confirmLabel: String
    let cancelLabel: String
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(message)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer()
                Button(cancelLabel) { onCancel() }
                    .keyboardShortcut(.cancelAction)
                Button(role: .destructive) { onConfirm() } label: {
                    Text(confirmLabel)
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .frame(minWidth: 240, idealWidth: 260, maxWidth: 300, alignment: .leading)
    }
}

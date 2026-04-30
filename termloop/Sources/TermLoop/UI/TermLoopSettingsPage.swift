// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Full-bleed page that hosts `TermLoopSettingsView` inside the main-area
/// overlay slot. Adds a header with title + close button so the user can
/// dismiss back to the terminal without leaving the keyboard.
struct TermLoopSettingsPage: View {
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(String(
                    localized: "termloop.settings.page.title",
                    defaultValue: "TermLoop Settings",
                    table: "TermLoop"
                ))
                .font(.system(size: 14, weight: .semibold))

                Spacer()

                Button {
                    onClose()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.secondary)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help(String(
                    localized: "termloop.settings.page.close",
                    defaultValue: "Close (Esc)",
                    table: "TermLoop"
                ))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color(nsColor: .windowBackgroundColor))

            Divider()

            TermLoopSettingsView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}

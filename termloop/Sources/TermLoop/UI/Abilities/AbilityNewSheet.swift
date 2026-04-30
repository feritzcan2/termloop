// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Mini "+ New Ability" sheet. Collects name + one-line description, derives
/// a kebab-case slug, writes a skeleton bundle, and hands off to the detail
/// page. The Customize-with-agent flow on the detail page then fills the
/// instructions body.
@MainActor
struct AbilityNewSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var description: String = ""

    let onCreate: (_ name: String, _ description: String) -> Void

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSubmit: Bool {
        !trimmedName.isEmpty && !slugify(trimmedName).isEmpty
    }

    private var slugPreview: String {
        let slug = slugify(trimmedName)
        return slug.isEmpty ? "—" : slug
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("New ability")
                .font(.system(size: 18, weight: .semibold, design: .monospaced))

            VStack(alignment: .leading, spacing: 4) {
                Text("Name")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                TextField("e.g. Working With Stripe", text: $name)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("One-line description (optional)")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                TextField("Use when…", text: $description)
                    .textFieldStyle(.roundedBorder)
            }

            HStack(spacing: 6) {
                Text("Bundle slug:")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                Text(slugPreview)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.primary)
            }

            HStack {
                Spacer(minLength: 0)
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create") {
                    onCreate(trimmedName, description.trimmingCharacters(in: .whitespacesAndNewlines))
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
            }
        }
        .padding(20)
        .frame(width: 380)
    }

    private func slugify(_ text: String) -> String {
        let lowered = text.lowercased()
        let parts = lowered.components(separatedBy: CharacterSet.alphanumerics.inverted)
        return parts.filter { !$0.isEmpty }.joined(separator: "-")
    }
}

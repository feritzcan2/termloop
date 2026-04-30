// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct IntegrationsRecommendedGroup: View {
    let recommendations: [Recommendation]
    @Binding var expanded: Bool
    let onDismiss: (String) -> Void
    let onActivate: (Recommendation) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 9))
                        .foregroundColor(.yellow)
                    Text(String(localized: "integrations.recommended.title",
                                defaultValue: "Recommended", table: "TermLoop"))
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .tracking(1.4)
                    Spacer()
                    Text("\(recommendations.count)")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundColor(.secondary)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(Color.accentColor.opacity(0.05))

            if expanded {
                if recommendations.isEmpty {
                    Text(String(localized: "integrations.recommended.empty",
                                defaultValue: "No suggestions for this workspace.",
                                table: "TermLoop"))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ForEach(recommendations) { rec in
                        recRow(rec)
                    }
                }
            }
            Divider().opacity(0.2)
        }
    }

    @ViewBuilder
    private func recRow(_ rec: Recommendation) -> some View {
        HStack(spacing: 8) {
            Text("[\(rec.kind.shortTag)]")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundColor(.secondary)
            Text(rec.itemName)
                .font(.system(size: 11, design: .monospaced))
            Spacer()
            Button(action: { onActivate(rec) }) {
                Text(actionLabel(rec.action))
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 3)
                        .stroke(Color.accentColor.opacity(0.5), lineWidth: 1))
            }
            .buttonStyle(.plain)
            Button(action: { onDismiss(rec.id) }) {
                Image(systemName: "xmark").font(.system(size: 9))
            }
            .buttonStyle(.plain)
            .foregroundColor(.secondary)
        }
        .help(rec.reason)
        .padding(.horizontal, 20)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func actionLabel(_ action: Recommendation.Action) -> String {
        switch action {
        case .add:
            return String(localized: "integrations.action.add",
                          defaultValue: "+ Add", table: "TermLoop")
        case .fix:
            return String(localized: "integrations.action.fix",
                          defaultValue: "Fix", table: "TermLoop")
        case .configure:
            return String(localized: "integrations.action.configure",
                          defaultValue: "Configure…", table: "TermLoop")
        }
    }
}

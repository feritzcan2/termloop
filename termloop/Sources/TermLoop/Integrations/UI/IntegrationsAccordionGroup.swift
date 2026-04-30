// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct IntegrationsAccordionGroup: View {
    let kind: IntegrationKind
    let items: [IntegrationItem]
    @Binding var expanded: Bool
    @Binding var selectedItemId: String?

    private var okCount: Int {
        items.reduce(into: 0) { acc, item in
            if case .ok = item.status { acc += 1 }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                    Text(kind.displayTitle)
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .tracking(1.4)
                    Spacer()
                    Text(summaryBadge)
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(spacing: 0) {
                    if items.isEmpty {
                        Text(String(localized: "integrations.group.empty",
                                    defaultValue: "No integrations in this category.",
                                    table: "TermLoop"))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary)
                            .padding(.horizontal, 24)
                            .padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ForEach(items) { item in
                            IntegrationsRowView(
                                item: item,
                                isSelected: selectedItemId == item.id,
                                onSelect: { selectedItemId = item.id },
                                onTest: { Task { await IntegrationTester.shared.test(id: item.id) } }
                            )
                        }
                    }
                }
            }
            Divider().opacity(0.2)
        }
    }

    private var summaryBadge: String {
        if items.isEmpty { return "0" }
        if okCount > 0 { return "\(items.count) · \(okCount) ok" }
        return "\(items.count)"
    }
}

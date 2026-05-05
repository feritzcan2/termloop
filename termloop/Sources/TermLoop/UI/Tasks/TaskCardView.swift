// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Single kanban card. Pure projection of `TaskCardSummary`. Selection state
/// is read from the per-window `TaskSelectionStore`. Drag is enabled only when
/// the card is not in `.pending` state — pending cards are mid-bind and must
/// not be raced.
struct TaskCardView: View {
    let card: TaskCardSummary
    @ObservedObject var selection: TaskSelectionStore
    var onCommandClick: ((TaskCardSummary) -> Void)?
    var onArchive: ((UUID) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 6) {
                provisionDot
                Text(card.title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(2)
                    .foregroundColor(.primary)
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                if let branch = card.branch {
                    Text(branch)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if card.agentCount > 0 {
                    Text("\(card.agentCount) ◆")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }
            }
            if case .failed(let reason) = card.provisionState {
                Text(reason)
                    .font(.system(size: 10))
                    .foregroundColor(.red)
                    .lineLimit(1)
            }
        }
        .padding(8)
        .background(background)
        .cornerRadius(4)
        .overlay(
            RoundedRectangle(cornerRadius: 4)
                .stroke(isSelected ? Color.accentColor : Color.clear, lineWidth: 1.5)
        )
        .opacity(card.provisionState == .pending ? 0.7 : 1.0)
        .contentShape(Rectangle())
        .onTapGesture {
            if NSEvent.modifierFlags.contains(.command), let onCommandClick {
                onCommandClick(card)
            } else {
                selection.select(card.id)
            }
        }
        .onDrag {
            // Pending cards still produce a provider but the column drop handler
            // is responsible for ignoring stale ids; we expose the id either way.
            NSItemProvider(object: card.id.uuidString as NSString)
        }
        .contextMenu {
            Button(String(localized: "tasks.card.menu.openInWorkTab",
                          defaultValue: "Open in Work tab", table: "TermLoop")) {
                onCommandClick?(card)
            }
            Button(String(localized: "tasks.card.menu.archive",
                          defaultValue: "Archive", table: "TermLoop")) {
                onArchive?(card.id)
            }
        }
    }

    private var isSelected: Bool { selection.selectedTaskId == card.id }

    private var background: Color {
        switch card.provisionState {
        case .pending: return Color.gray.opacity(0.18)
        case .failed: return Color.red.opacity(0.12)
        case .ready, .none: return Color(nsColor: .controlBackgroundColor)
        }
    }

    @ViewBuilder
    private var provisionDot: some View {
        Circle()
            .fill(provisionDotColor)
            .frame(width: 8, height: 8)
            .padding(.top, 4)
    }

    private var provisionDotColor: Color {
        switch card.provisionState {
        case .pending: return .orange
        case .failed: return .red
        case .ready: return .green
        case .none: return .gray
        }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

@MainActor
final class QuickActionAutocompleteModel: ObservableObject {
    @Published var items: [QuickActionAutocompleteItem] = []
    @Published var selectedIndex: Int = 0

    func clampSelection() {
        if items.isEmpty {
            selectedIndex = 0
        } else if selectedIndex >= items.count {
            selectedIndex = items.count - 1
        } else if selectedIndex < 0 {
            selectedIndex = 0
        }
    }

    func moveUp() {
        guard !items.isEmpty else { return }
        selectedIndex = (selectedIndex - 1 + items.count) % items.count
    }

    func moveDown() {
        guard !items.isEmpty else { return }
        selectedIndex = (selectedIndex + 1) % items.count
    }

    var selectedItem: QuickActionAutocompleteItem? {
        guard selectedIndex >= 0, selectedIndex < items.count else { return nil }
        return items[selectedIndex]
    }
}

struct QuickActionAutocompleteRow: View {
    let item: QuickActionAutocompleteItem
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: iconName)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(iconTint)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.displayName)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let subtitle = item.subtitle, !subtitle.isEmpty, subtitle != item.displayName {
                    Text(subtitle)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(rowBackground)
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
    }

    private var iconName: String {
        switch item.kind {
        case .folder: return "folder"
        case .workspace: return "square.stack.3d.up"
        case .markdown: return "doc.text"
        }
    }

    private var iconTint: Color {
        switch item.kind {
        case .folder: return Color(red: 0.73, green: 0.55, blue: 1.0)
        case .workspace: return Color(red: 0.30, green: 0.82, blue: 0.76)
        case .markdown: return Color.secondary
        }
    }

    @ViewBuilder
    private var rowBackground: some View {
        if isSelected {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color.accentColor.opacity(0.25))
        } else {
            Color.clear
        }
    }
}

struct QuickActionAutocompleteView: View {
    @ObservedObject var model: QuickActionAutocompleteModel
    var onSelect: (QuickActionAutocompleteItem) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(model.items.enumerated()), id: \.element.id) { pair in
                        QuickActionAutocompleteRow(
                            item: pair.element,
                            isSelected: pair.offset == model.selectedIndex,
                            onTap: { onSelect(pair.element) }
                        )
                        .id(pair.element.id)
                    }
                }
                .padding(4)
            }
            .onChange(of: model.selectedIndex) { _, new in
                guard new >= 0, new < model.items.count else { return }
                let target = model.items[new].id
                withAnimation(.easeInOut(duration: 0.08)) {
                    proxy.scrollTo(target, anchor: .center)
                }
            }
        }
        .frame(minWidth: 280, idealWidth: 340, maxWidth: 420, minHeight: 40, maxHeight: 260)
        .background(popupBackground)
    }

    @ViewBuilder
    private var popupBackground: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(.regularMaterial)
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.secondary.opacity(0.25), lineWidth: 1)
        }
    }
}

final class QuickActionAutocompletePanel: NSPanel {
    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 200),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        self.isFloatingPanel = true
        self.level = .popUpMenu
        self.becomesKeyOnlyIfNeeded = true
        self.hidesOnDeactivate = false
        self.isOpaque = false
        self.backgroundColor = .clear
        self.hasShadow = true
        self.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        self.animationBehavior = .utilityWindow
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

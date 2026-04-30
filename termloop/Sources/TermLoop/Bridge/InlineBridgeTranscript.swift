// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

// termloop/Sources/TermLoop/Bridge/InlineBridgeTranscript.swift
import SwiftUI

/// Scrollable transcript rendered inline between the two linked
/// workspace rows. Left-aligns messages from the left side, right-
/// aligns right-side messages, centers interventions. Auto-scrolls to
/// newest on append.
///
/// Owns its own `WorkspaceBridgeStore` subscription so transcript-append
/// ticks (which mutate `store.bridges` on every turn) stay scoped to this
/// view — the parent bridge row subscribes only to `$overviewVersion` and
/// stops re-rendering on per-message appends.
@MainActor
struct InlineBridgeTranscript: View {
    let bridgeId: UUID
    @ObservedObject private var store = WorkspaceBridgeStore.shared

    init(bridgeId: UUID) {
        self.bridgeId = bridgeId
    }

    var body: some View {
        if let bridge = store.bridge(id: bridgeId) {
            content(for: bridge)
        } else {
            EmptyView()
        }
    }

    @ViewBuilder
    private func content(for bridge: WorkspaceBridge) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(bridge.messages) { msg in
                        messageRow(msg).id(msg.id)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            }
            .frame(minHeight: 100, idealHeight: 220, maxHeight: 280)
            .background(Color.black.opacity(0.15))
            .cornerRadius(6)
            .padding(.horizontal, 8)
            .onChange(of: bridge.messages.count) { _ in
                if let last = bridge.messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    @ViewBuilder
    private func messageRow(_ msg: BridgeMessage) -> some View {
        HStack {
            if msg.sender == .right { Spacer(minLength: 16) }
            VStack(alignment: alignment(for: msg.sender), spacing: 2) {
                Text(label(for: msg.sender))
                    .font(.system(size: 9))
                    .foregroundStyle(color(for: msg.sender).opacity(0.7))
                Text(msg.text)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(color(for: msg.sender))
                    .lineLimit(10)
                    .truncationMode(.tail)
            }
            .padding(6)
            .background(color(for: msg.sender).opacity(0.12))
            .cornerRadius(4)
            if msg.sender == .left { Spacer(minLength: 16) }
        }
    }

    private func alignment(for sender: BridgeSender) -> HorizontalAlignment {
        switch sender {
        case .left:  return .leading
        case .right: return .trailing
        }
    }

    private func label(for sender: BridgeSender) -> String {
        switch sender {
        case .left:
            return String(localized: "bridge.transcript.left", defaultValue: "Left", table: "TermLoop")
        case .right:
            return String(localized: "bridge.transcript.right", defaultValue: "Right", table: "TermLoop")
        }
    }

    private func color(for sender: BridgeSender) -> Color {
        switch sender {
        case .left:  return .blue
        case .right: return .pink
        }
    }
}

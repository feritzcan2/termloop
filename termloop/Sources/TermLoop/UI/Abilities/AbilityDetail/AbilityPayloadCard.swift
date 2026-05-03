// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

@MainActor
struct AbilityPayloadCard: View {
    let ability: Ability

    @ObservedObject private var abilityStore = AbilityStore.shared
    @State private var drafts: [String: Draft] = [:]

    private struct Draft: Equatable {
        var title: String
        var description: String
        var enabled: Bool
        var body: String

        init(block: AbilityPayloadBlock) {
            self.title = block.title
            self.description = block.description
            self.enabled = block.enabled
            self.body = block.body
        }

        func applying(to block: AbilityPayloadBlock) -> AbilityPayloadBlock {
            var updated = block
            updated.title = title
            updated.description = description
            updated.enabled = enabled
            updated.body = body
            return updated
        }

        func isDirty(comparedTo block: AbilityPayloadBlock) -> Bool {
            self != Draft(block: block)
        }
    }

    var body: some View {
        AbilityDetailCard(
            title: "Agent payload",
            subtitle: "These blocks will be sent as `--append-system-prompt` when this ability is active."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                if ability.payloadBlocks.isEmpty {
                    Text("No payload blocks yet.")
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                } else {
                    ForEach(ability.payloadBlocks) { block in
                        blockEditor(block)
                    }
                }
            }
        } footer: {
            Button {
                abilityStore.addPayloadBlock(abilityId: ability.id)
            } label: {
                Label("Add block", systemImage: "plus")
            }
            .buttonStyle(.borderless)
        }
        .onAppear {
            syncDrafts(with: ability.payloadBlocks)
        }
        .onChange(of: ability.payloadBlocks) { _, blocks in
            syncDrafts(with: blocks)
        }
    }

    private func blockEditor(_ block: AbilityPayloadBlock) -> some View {
        let draft = drafts[block.id] ?? Draft(block: block)
        let dirty = draft.isDirty(comparedTo: block)

        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                TextField(
                    "Title",
                    text: binding(for: block, keyPath: \.title)
                )
                .textFieldStyle(.plain)
                .font(TermLoopSidebarTheme.bodyMonoStrong)

                Spacer(minLength: 8)

                Toggle(
                    "",
                    isOn: binding(for: block, keyPath: \.enabled)
                )
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
            }

            TextField(
                "Description",
                text: binding(for: block, keyPath: \.description),
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(TermLoopSidebarTheme.tinyMono)
            .foregroundStyle(TermLoopSidebarTheme.dim)

            TextEditor(text: binding(for: block, keyPath: \.body))
                .font(.system(size: 12, design: .monospaced))
                .scrollContentBackground(.hidden)
                .frame(minHeight: 92)
                .padding(6)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.primary.opacity(0.035))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(TermLoopSidebarTheme.ruleStrong.opacity(0.7), lineWidth: 1)
                )

            HStack(spacing: 8) {
                Text(block.fileURL.path)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dimmer)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Button("Revert") {
                    drafts[block.id] = Draft(block: block)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(!dirty)
                Button("Save") {
                    abilityStore.savePayloadBlock(
                        abilityId: ability.id,
                        block: draft.applying(to: block)
                    )
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                .disabled(!dirty)
                Button("Delete", role: .destructive) {
                    drafts.removeValue(forKey: block.id)
                    abilityStore.deletePayloadBlock(abilityId: ability.id, block: block)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.018))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func binding<Value>(
        for block: AbilityPayloadBlock,
        keyPath: WritableKeyPath<Draft, Value>
    ) -> Binding<Value> {
        Binding(
            get: {
                let draft = drafts[block.id] ?? Draft(block: block)
                return draft[keyPath: keyPath]
            },
            set: { value in
                var draft = drafts[block.id] ?? Draft(block: block)
                draft[keyPath: keyPath] = value
                drafts[block.id] = draft
            }
        )
    }

    private func syncDrafts(with blocks: [AbilityPayloadBlock]) {
        let ids = Set(blocks.map(\.id))
        drafts = drafts.filter { ids.contains($0.key) }
        for block in blocks where drafts[block.id] == nil {
            drafts[block.id] = Draft(block: block)
        }
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Empty-state nudge for abilities that don't yet declare any required
/// skills. Payload blocks carry launch instructions; skills carry
/// agent-discoverable project workflows.
@MainActor
struct AbilityInstructionsCard: View {
    let ability: Ability
    let onCustomize: () -> Void

    var body: some View {
        AbilityDetailCard(
            title: "Project skills",
            subtitle: "This ability hasn't declared any required skills yet."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Add required skills to `ability.json`, or customize with the agent to author the workflow.")
                    .font(TermLoopSidebarTheme.bodyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                Button(action: onCustomize) {
                    Label("Customize with agent", systemImage: "sparkles")
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
}

@MainActor
struct AbilityRequiredSkillsCard: View {
    let ability: Ability
    let projectFolderPath: String?
    let onCustomize: () -> Void

    @State private var refreshTick: UInt = 0
    @State private var errorMessage: String? = nil

    private struct SkillPreview {
        let name: String
        let description: String?
        let body: String
    }

    var body: some View {
        AbilityDetailCard(
            title: "Project skills",
            subtitle: "Ability-specific workflow lives in skill files. Agents read and update these alongside payload blocks."
        ) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(ability.requiredSkillIDs, id: \.self) { id in
                    skillSection(id)
                }
            }
        } footer: {
            Button {
                onCustomize()
            } label: {
                Label("Customize skill with agent", systemImage: "sparkles")
            }
            .buttonStyle(.borderless)
        }
        .alert(
            "Skill update failed",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            ),
            presenting: errorMessage
        ) { _ in
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: { message in
            Text(message)
        }
    }

    @ViewBuilder
    private func skillSection(_ id: String) -> some View {
        let projectRoot = projectFolderPath.map { URL(fileURLWithPath: $0, isDirectory: true) }
        let probe = AbilitySkillProbe.resolve(id: id, projectRoot: projectRoot)
        let preview = loadSkillPreview(probe.fileURL)

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TermLoopSidebarToken(label: "Skill", tone: .muted)
                Text(preview?.name ?? id)
                    .font(TermLoopSidebarTheme.bodyMonoStrong)
                Spacer(minLength: 8)
                if probe.canCopyToProject {
                    Button("Copy to project") {
                        copySkillToProject(id: id, probe: probe)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
                if let fileURL = probe.fileURL {
                    Button("Edit skill") {
                        editSkill(fileURL, title: preview?.name ?? id)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
                TermLoopSidebarToken(
                    label: probe.statusLabel,
                    tone: probe.exists ? .accent : .warning,
                    emphasized: !probe.exists
                )
            }

            Text(probe.detail)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .fixedSize(horizontal: false, vertical: true)

            if let description = preview?.description,
               !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(description)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let preview, !preview.body.isEmpty {
                MarkdownRenderer(content: preview.body)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(MarkdownTheme.insetBg)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else if probe.exists {
                Text("Skill file exists but has no body yet. Use Customize skill with agent or Edit skill.")
                    .font(TermLoopSidebarTheme.bodyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("This project does not have this skill yet.")
                        .font(TermLoopSidebarTheme.bodyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                    Button {
                        onCustomize()
                    } label: {
                        Label("Create with agent", systemImage: "sparkles")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }

            nativeCopiesSection(id)
        }
        .padding(10)
        .id(refreshTick)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.018))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    @ViewBuilder
    private func nativeCopiesSection(_ id: String) -> some View {
        let locations = ProjectSkillMaterializer.skillLocations(
            projectFolderPath: projectFolderPath,
            skillId: id,
            ability: ability
        )
        if !locations.isEmpty {
            let canonicalExists = locations.first(where: { $0.isCanonical })?.exists == true
            let nativeLocations = locations.filter { !$0.isCanonical }
            let canSync = nativeLocations.contains { $0.isSyncable && !$0.isSynced }
            let hasOutOfSync = nativeLocations.contains { !$0.isSynced }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text("Skill files")
                        .font(TermLoopSidebarTheme.sectionCaps)
                        .foregroundStyle(Color.primary)
                    Spacer(minLength: 8)
                    Button(nativeSyncButtonLabel(canSync: canSync, hasOutOfSync: hasOutOfSync)) {
                        ProjectSkillMaterializer.materialize(
                            projectFolderPath: projectFolderPath,
                            skillId: id,
                            ability: ability
                        )
                        refreshTick &+= 1
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .disabled(!canonicalExists || !canSync)
                }
                Text("Canonical is the source of truth. Native skill files are linked when the agent supports it; Codex uses a managed real copy because it ignores symlinked SKILL.md files.")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dimmer)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(locations) { location in
                    skillFileRow(location)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.02))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }

    private func skillFileRow(_ location: ProjectSkillMaterializer.SkillLocation) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            TermLoopSidebarToken(
                label: location.isCanonical ? "source" : copyStatusLabel(location),
                tone: copyStatusTone(location),
                emphasized: !location.exists || (!location.isCanonical && !location.isSynced)
            )
            Text(location.label)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(Color.primary)
                .frame(width: 96, alignment: .leading)
            Text(location.fileURL.path)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(location.exists ? TermLoopSidebarTheme.dim : TermLoopSidebarTheme.dimmer)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            Button("Open") {
                openSkillFile(location.editURL, title: location.label)
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)
            .disabled(!location.exists)
        }
    }

    private func copyStatusLabel(_ location: ProjectSkillMaterializer.SkillLocation) -> String {
        if !location.exists { return "missing" }
        if !location.isSynced {
            if location.isManagedCopy || location.isLinkedCopy { return "stale" }
            return "unmanaged"
        }
        if location.isLinkedCopy { return "linked" }
        return location.isManagedCopy ? "synced" : "unmanaged"
    }

    private func copyStatusTone(_ location: ProjectSkillMaterializer.SkillLocation) -> TermLoopSidebarTokenTone {
        if location.isCanonical {
            return location.exists ? .accent : .warning
        }
        return location.exists && location.isSynced ? .accent : .warning
    }

    private func nativeSyncButtonLabel(canSync: Bool, hasOutOfSync: Bool) -> String {
        if canSync { return "Sync native files" }
        return hasOutOfSync ? "Native files unmanaged" : "Native files synced"
    }

    private func loadSkillPreview(_ fileURL: URL?) -> SkillPreview? {
        guard let fileURL,
              let raw = try? String(contentsOf: fileURL, encoding: .utf8) else {
            return nil
        }
        let parsed = SkillFrontmatterParser.parse(raw)
        let fallbackName = fileURL.deletingLastPathComponent().lastPathComponent
        let name = parsed.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = parsed.body.trimmingCharacters(in: .whitespacesAndNewlines)
        return SkillPreview(
            name: (name?.isEmpty == false ? name : fallbackName) ?? fallbackName,
            description: parsed.description,
            body: body
        )
    }

    private func copySkillToProject(id: String, probe: AbilitySkillProbe) {
        guard let source = probe.fileURL else { return }
        do {
            try ProjectSkillMaterializer.adoptSkillToProject(
                projectFolderPath: projectFolderPath,
                skillId: id,
                sourceSkillFile: source
            )
            refreshTick &+= 1
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func editSkill(_ url: URL, title: String) {
        openSkillFile(url, title: title)
    }

    private func openSkillFile(_ url: URL, title: String) {
        MarkdownDocumentStore.shared.open(
            fileURL: url.resolvingSymlinksInPath(),
            folderName: "SKILLS",
            displayTitle: title
        )
    }
}

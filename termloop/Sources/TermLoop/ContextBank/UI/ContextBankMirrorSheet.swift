// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct ContextBankMirrorSheet: View {
    let projectRoot: URL
    let onFinished: () -> Void

    @AppStorage("contextBank.mirror.tracked")
    private var trackedCSV: String = ContextBankFile.Kind.allFileNames.joined(separator: ",")

    /// Empty string means "mirror (per folder)".
    @AppStorage("contextBank.mirror.canonical")
    private var canonicalName: String = ""

    @AppStorage("contextBank.mirror.forceFix")
    private var forceFixDivergent: Bool = false

    @State private var plan: ContextBankMirrorPlan? = nil
    @State private var isApplying = false
    @State private var resultMessage: String?
    @State private var recomputeTask: Task<Void, Never>?

    private var trackedFiles: Set<String> {
        Set(trackedCSV
            .split(separator: ",")
            .map(String.init)
            .filter { ContextBankFile.Kind.allFileNames.contains($0) })
    }

    private var config: ContextBankMirrorConfig {
        ContextBankMirrorConfig(
            tracked: trackedFiles,
            canonical: canonicalName.isEmpty ? nil : canonicalName,
            forceOverwriteDivergent: forceFixDivergent
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    trackedSection
                    Divider()
                    canonicalSection
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
            }
            .frame(maxHeight: 260)
            Divider()
            previewSection
            Divider()
            footer
        }
        .frame(width: 640, height: 660)
        .task { recomputePlan() }
        .onChange(of: trackedCSV) { _ in syncCanonicalWithTracked(); recomputePlan() }
        .onChange(of: canonicalName) { _ in recomputePlan() }
        .onChange(of: forceFixDivergent) { _ in
            // Toggle only changes which action divergent rows produce; if there
            // are none in the current plan, skip the full tree walk.
            let relevant = (plan?.divergentCount ?? 0) + (plan?.forceCount ?? 0)
            if relevant > 0 { recomputePlan() }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.on.doc")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(String(
                localized: "contextBank.mirror.sheet.title",
                defaultValue: "Mirror Files",
                table: "TermLoop"
            ))
            .font(.system(size: 13, weight: .semibold, design: .monospaced))
            Spacer()
            Button(action: onFinished) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .padding(6)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(NSColor.windowBackgroundColor))
    }

    // MARK: - Tracked files section

    private var trackedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(String(
                localized: "contextBank.mirror.section.tracked",
                defaultValue: "FILES TO MIRROR",
                table: "TermLoop"
            ))
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                ForEach(ContextBankFile.Kind.allFileNames, id: \.self) { name in
                    trackedCheckbox(name: name)
                }
                Spacer()
            }
        }
    }

    private func trackedCheckbox(name: String) -> some View {
        let isOn = trackedFiles.contains(name)
        return Button {
            toggleTracked(name)
        } label: {
            CheckboxChip(isOn: isOn, tint: .accentColor) {
                Text(name)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Canonical picker

    private var canonicalSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(String(
                localized: "contextBank.mirror.section.source",
                defaultValue: "SOURCE FILE",
                table: "TermLoop"
            ))
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(.secondary)

            canonicalRadio(name: "", title: String(
                localized: "contextBank.mirror.option.mirror",
                defaultValue: "Mirror (per folder)",
                table: "TermLoop"
            ), subtitle: String(
                localized: "contextBank.mirror.option.mirror.subtitle",
                defaultValue: "In each folder, fill in the missing tracked files from whichever exists. Identical pairs merge using the newer file.",
                table: "TermLoop"
            ))

            ForEach(ContextBankFile.Kind.allFileNames, id: \.self) { name in
                canonicalRadio(name: name, title: "\(name) is the source", subtitle: "Every other tracked file in the folder becomes a real copy of \(name).")
                    .opacity(trackedFiles.contains(name) ? 1.0 : 0.35)
                    .disabled(!trackedFiles.contains(name))
            }
        }
    }

    private func canonicalRadio(name: String, title: String, subtitle: String) -> some View {
        let isSelected = canonicalName == name
        return Button {
            canonicalName = name
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(isSelected ? Color.accentColor : .secondary)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    Text(subtitle)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isSelected ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? Color.accentColor.opacity(0.35) : Color.primary.opacity(0.10), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Preview

    @ViewBuilder
    private var previewSection: some View {
        if let plan {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    summaryRow(plan: plan).padding(.bottom, 4)
                    if plan.items.isEmpty {
                        Text(String(
                            localized: "contextBank.mirror.preview.empty",
                            defaultValue: "No tracked files found in this project.",
                            table: "TermLoop"
                        ))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                    } else {
                        ForEach(plan.items) { item in
                            row(for: item)
                        }
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            HStack { Spacer(); ProgressView().controlSize(.small); Spacer() }
                .padding(14)
        }
    }

    private func summaryRow(plan: ContextBankMirrorPlan) -> some View {
        HStack(spacing: 12) {
            if plan.createCount > 0 {
                Label("\(plan.createCount) create", systemImage: "plus.circle.fill")
                    .foregroundStyle(.green)
            }
            if plan.convertCount > 0 {
                Label("\(plan.convertCount) replace", systemImage: "arrow.triangle.2.circlepath")
                    .foregroundStyle(.orange)
            }
            if plan.forceCount > 0 {
                Label("\(plan.forceCount) force", systemImage: "trash.fill")
                    .foregroundStyle(.red)
            }
            if plan.alreadyMirroredCount > 0 {
                Label("\(plan.alreadyMirroredCount) mirrored", systemImage: "doc.on.doc")
                    .foregroundStyle(.secondary)
            }
            if plan.divergentCount > 0 {
                Label("\(plan.divergentCount) divergent", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            }
            if plan.mismatchCount > 0 {
                Label("\(plan.mismatchCount) n/a", systemImage: "minus.circle")
                    .foregroundStyle(.tertiary)
            }
        }
        .font(.system(size: 11, weight: .semibold, design: .monospaced))
    }

    private func row(for item: ContextBankMirrorPlanItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            icon(for: item.action).frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(relativePath(for: item))
                    .font(.system(size: 11, design: .monospaced))
                Text(describe(item))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(describeColor(for: item.action))
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private func icon(for action: ContextBankMirrorPlanItem.Action) -> some View {
        Image(systemName: action.symbolName)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(actionTint(for: action))
    }

    private func actionTint(for action: ContextBankMirrorPlanItem.Action) -> Color {
        switch action {
        case .createCopy: return .green
        case .replaceWithCopy: return .orange
        case .forceOverwriteDivergent: return .red
        case .skipAlreadyMirrored: return .secondary
        case .skipDivergentPair: return .red
        case .skipDirectionMismatch: return .secondary.opacity(0.7)
        }
    }

    private func describe(_ item: ContextBankMirrorPlanItem) -> String {
        switch item.action {
        case .createCopy:
            return "+ copy \(item.targetName) to \(item.linkName)"
        case .replaceWithCopy:
            return "replace symlink \(item.linkName) with copy of \(item.targetName)"
        case .forceOverwriteDivergent:
            return "force: trash \(item.linkName) and copy from \(item.targetName)"
        case .skipAlreadyMirrored:
            return "already mirrored (\(item.linkName) matches \(item.targetName))"
        case .skipDivergentPair:
            return "\(item.linkName) differs from \(item.targetName) — reconcile manually"
        case .skipDirectionMismatch:
            return "canonical source not in this folder"
        }
    }

    private func describeColor(for action: ContextBankMirrorPlanItem.Action) -> Color {
        switch action {
        case .replaceWithCopy, .forceOverwriteDivergent, .skipDivergentPair:
            return actionTint(for: action)
        case .createCopy, .skipAlreadyMirrored, .skipDirectionMismatch:
            return .secondary
        }
    }

    private func relativePath(for item: ContextBankMirrorPlanItem) -> String {
        let rootPath = projectRoot.standardizedFileURL.path
        if item.directoryPath.hasPrefix(rootPath) {
            let tail = String(item.directoryPath.dropFirst(rootPath.count))
            let cleaned = tail.hasPrefix("/") ? String(tail.dropFirst()) : tail
            return cleaned.isEmpty ? "(root)" : cleaned
        }
        return item.directoryPath
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 10) {
            if let message = resultMessage {
                Text(message)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if shouldShowForceToggle {
                forceFixToggle
            }
            Button(String(
                localized: "contextBank.mirror.cancel",
                defaultValue: "Cancel",
                table: "TermLoop"
            )) { onFinished() }
                .keyboardShortcut(.cancelAction)
            Button {
                apply()
            } label: {
                Text(applyButtonLabel)
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!(plan?.hasWork ?? false) || isApplying)
            .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(NSColor.windowBackgroundColor))
    }

    private var shouldShowForceToggle: Bool {
        if forceFixDivergent { return true }
        return (plan?.divergentCount ?? 0) > 0 || (plan?.forceCount ?? 0) > 0
    }

    private var forceFixToggle: some View {
        Button {
            forceFixDivergent.toggle()
        } label: {
            CheckboxChip(
                isOn: forceFixDivergent,
                tint: .red,
                iconSize: 11,
                horizontalPadding: 8,
                verticalPadding: 4
            ) {
                Text(String(
                    localized: "contextBank.mirror.option.force.title",
                    defaultValue: "Force fix divergent (move to Trash)",
                    table: "TermLoop"
                ))
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(forceFixDivergent ? Color.red : Color.primary)
            }
        }
        .buttonStyle(.plain)
        .help(String(
            localized: "contextBank.mirror.option.force.help",
            defaultValue: "Replace divergent files with real copies of the canonical sibling. Originals go to the system Trash so you can recover them.",
            table: "TermLoop"
        ))
    }

    private var applyButtonLabel: String {
        if isApplying {
            return String(localized: "contextBank.mirror.applying",
                          defaultValue: "Applying…",
                          table: "TermLoop")
        }
        let count = plan?.actionableCount ?? 0
        let template = String(localized: "contextBank.mirror.apply",
                              defaultValue: "Apply (%d changes)",
                              table: "TermLoop")
        return String(format: template, count)
    }

    // MARK: - Actions

    private func toggleTracked(_ name: String) {
        var current = trackedFiles
        if current.contains(name) {
            current.remove(name)
        } else {
            current.insert(name)
        }
        trackedCSV = ContextBankFile.Kind.allFileNames
            .filter { current.contains($0) }
            .joined(separator: ",")
    }

    private func syncCanonicalWithTracked() {
        if !canonicalName.isEmpty, !trackedFiles.contains(canonicalName) {
            canonicalName = ""
        }
    }

    private func recomputePlan() {
        recomputeTask?.cancel()
        let snapshot = config
        let root = projectRoot
        recomputeTask = Task.detached(priority: .userInitiated) {
            if Task.isCancelled { return }
            let next = ContextBankMirrorPlanner.plan(projectRoot: root, config: snapshot)
            if Task.isCancelled { return }
            await MainActor.run {
                if self.config == snapshot {
                    self.plan = next
                }
            }
        }
    }

    private func apply() {
        guard let plan, plan.hasWork else { return }
        isApplying = true
        resultMessage = nil
        let snapshot = plan
        Task.detached(priority: .userInitiated) {
            let applied = ContextBankMirrorPlanner.apply(snapshot)
            await MainActor.run {
                isApplying = false
                resultMessage = "Applied \(applied) change\(applied == 1 ? "" : "s")"
                ContextBankStore.shared.refresh()
                recomputePlan()
            }
        }
    }
}

private struct CheckboxChip<Label: View>: View {
    let isOn: Bool
    let tint: Color
    var iconSize: CGFloat = 13
    var horizontalPadding: CGFloat = 10
    var verticalPadding: CGFloat = 6
    @ViewBuilder let label: () -> Label

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: isOn ? "checkmark.square.fill" : "square")
                .font(.system(size: iconSize))
                .foregroundStyle(isOn ? tint : Color.secondary)
            label()
        }
        .padding(.horizontal, horizontalPadding)
        .padding(.vertical, verticalPadding)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isOn ? tint.opacity(0.10) : Color.primary.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(isOn ? tint.opacity(0.35) : Color.primary.opacity(0.10), lineWidth: 1)
        )
        .contentShape(Rectangle())
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

// termloop/Sources/TermLoop/Bridge/BridgeKickoffSheet.swift
import SwiftUI

extension Notification.Name {
    static let termLoopOpenBridgeKickoff = Notification.Name("termLoopOpenBridgeKickoff")
}

/// Payload for `.termLoopOpenBridgeKickoff`.
struct BridgeKickoffRequest: Identifiable {
    let id = UUID()
    let leftWorkspaceId: UUID
    let rightWorkspaceId: UUID

    static func from(notification: Notification) -> BridgeKickoffRequest? {
        let info = notification.userInfo as? [String: Any] ?? [:]
        guard let l = (info["leftWorkspaceId"] as? String).flatMap(UUID.init(uuidString:)),
              let r = (info["rightWorkspaceId"] as? String).flatMap(UUID.init(uuidString:))
        else { return nil }
        return BridgeKickoffRequest(leftWorkspaceId: l, rightWorkspaceId: r)
    }
}

@MainActor
struct BridgeKickoffSheet: View {
    let request: BridgeKickoffRequest
    let tabManager: TabManager
    @Environment(\.dismiss) private var dismiss

    @State private var kickoff: String = ""
    @State private var rolePrompt: String = ""
    @State private var firstSpeaker: BridgeSender = .left

    private var leftWorkspace: Workspace? {
        tabManager.tabs.first { $0.id == request.leftWorkspaceId }
    }
    private var rightWorkspace: Workspace? {
        tabManager.tabs.first { $0.id == request.rightWorkspaceId }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(titleText)
                .font(.title3)

            Text(String(localized: "bridge.kickoff.message",
                        defaultValue: "Kickoff message",
                        table: "TermLoop"))
                .font(.subheadline)
            PromptTextEditor(text: $kickoff, minHeight: 80, maxHeight: 160)

            Text(String(localized: "bridge.kickoff.firstSpeaker",
                        defaultValue: "Who speaks first",
                        table: "TermLoop"))
                .font(.subheadline)
            Picker("", selection: $firstSpeaker) {
                Text(leftLabel).tag(BridgeSender.left)
                Text(rightLabel).tag(BridgeSender.right)
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text(String(localized: "bridge.kickoff.rolePrompt",
                        defaultValue: "Role prompt (optional)",
                        table: "TermLoop"))
                .font(.subheadline)
            PromptTextEditor(text: $rolePrompt, minHeight: 60, maxHeight: 130)

            HStack {
                Spacer()
                Button(String(localized: "bridge.kickoff.cancel",
                              defaultValue: "Cancel", table: "TermLoop")) {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button(String(localized: "bridge.kickoff.start",
                              defaultValue: "Start bridge", table: "TermLoop")) {
                    submit()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    kickoff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || leftWorkspace == nil || rightWorkspace == nil
                )
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private var leftLabel: String {
        leftWorkspace?.customTitle ?? leftWorkspace?.title ?? "left"
    }
    private var rightLabel: String {
        rightWorkspace?.customTitle ?? rightWorkspace?.title ?? "right"
    }
    private var titleText: String {
        let fmt = String(localized: "bridge.kickoff.title",
                         defaultValue: "Link %@ ⇄ %@", table: "TermLoop")
        return String(format: fmt, leftLabel, rightLabel)
    }

    private func submit() {
        let bridge = WorkspaceBridge(
            leftWorkspaceId: request.leftWorkspaceId,
            rightWorkspaceId: request.rightWorkspaceId,
            rolePrompt: rolePrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil : rolePrompt,
            kickoffMessage: kickoff,
            firstSpeaker: firstSpeaker
        )
        let added = WorkspaceBridgeStore.shared.add(bridge)
        if added {
            BridgeCoordinator.shared.kickoff(bridgeId: bridge.id)
        }
        dismiss()
    }
}

extension Notification.Name {
    static let termLoopOpenAskTo = Notification.Name("termLoopOpenAskTo")
}

struct AskAgentRequest: Identifiable {
    let id = UUID()
    let sourceId: UUID
    /// Click location in the key window's top-left coordinate space (SwiftUI
    /// .global). Used to anchor the Ask To popover near the click.
    let windowPoint: CGPoint?

    static func from(notification: Notification) -> AskAgentRequest? {
        let info = notification.userInfo as? [String: Any] ?? [:]
        guard let sourceIdString = info["sourceId"] as? String,
              let sourceId = UUID(uuidString: sourceIdString) else {
            return nil
        }
        let point: CGPoint?
        if let x = info["globalPointX"] as? Double,
           let y = info["globalPointY"] as? Double {
            // Already converted to SwiftUI .global top-left at post time.
            point = CGPoint(x: x, y: y)
        } else {
            point = nil
        }
        return AskAgentRequest(sourceId: sourceId, windowPoint: point)
    }
}

// AskTargetAgent / AskAgentPreset live in
// Sources/TermLoop/AgentInputs/BridgePromptCatalog.swift.


/// Transparent anchor view that fills the sidebar overlay and positions the
/// Ask To popover at the click location via `attachmentAnchor: .rect(...)`.
///
/// Why `attachmentAnchor` instead of a positioned marker: SwiftUI's
/// `.popover` modifier anchors to the attached view's *layout bounds* — not
/// to `.offset(...)` or `.position(...)` visuals. So we attach the popover
/// to a sidebar-sized invisible view and pass the click point as a rect in
/// that view's local coordinate space.
@MainActor
struct AskToPopoverAnchor: View {
    @Binding var request: AskAgentRequest?
    let tabManager: TabManager

    @State private var sidebarFrame: CGRect = .zero

    var body: some View {
        Color.clear
            .background(
                GeometryReader { proxy in
                    Color.clear
                        .preference(
                            key: AskToSidebarFramePreferenceKey.self,
                            value: proxy.frame(in: .global)
                        )
                }
            )
            .onPreferenceChange(AskToSidebarFramePreferenceKey.self) { frame in
                sidebarFrame = frame
            }
            .popover(
                item: $request,
                attachmentAnchor: .rect(.rect(anchorRect())),
                arrowEdge: .trailing
            ) { req in
                AskToSheet(
                    request: req,
                    tabManager: tabManager,
                    onClose: { request = nil }
                )
            }
            .allowsHitTesting(false)
    }

    private func anchorRect() -> CGRect {
        // Default to right edge near the top when we have no click location.
        guard let windowPoint = request?.windowPoint, sidebarFrame.width > 0 else {
            return CGRect(x: max(0, sidebarFrame.width - 8), y: 40, width: 1, height: 1)
        }
        let localX = windowPoint.x - sidebarFrame.minX
        let localY = windowPoint.y - sidebarFrame.minY
        let clampedX = max(0, min(sidebarFrame.width, localX))
        let clampedY = max(0, min(sidebarFrame.height, localY))
        return CGRect(x: clampedX, y: clampedY, width: 1, height: 1)
    }
}

private struct AskToSidebarFramePreferenceKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}

@MainActor
struct AskToSheet: View {
    let request: AskAgentRequest
    let tabManager: TabManager
    var panelWidth: CGFloat = 420
    var panelHeight: CGFloat = 0 // retained for call-site compatibility; layout is intrinsic
    var onClose: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    @State private var selectedTarget: AskTargetAgent = .codex
    @State private var selectedPreset: AskAgentPreset = .ask
    @State private var sourcePrompt: String = ""
    @State private var targetPrompt: String = ""
    // Last preset/target text applied for the source editor, used to detect
    // whether the current content is a pristine preset result (overwrite on
    // preset/target switch) or a user edit (preserve across switches). The
    // target editor no longer seeds from presets — it's a freeform override
    // appended after the anti-preamble — so edit detection is just
    // "non-empty".
    @State private var lastAppliedSource: String = ""

    private var source: Workspace? {
        tabManager.tabs.first { $0.id == request.sourceId }
    }

    private var sourceTitle: String {
        source.flatMap { workspaceTitle($0) } ?? "Claude workspace"
    }

    private var sourceAgentId: String {
        guard let source else { return TerminalAgent.claudeId }
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: source.id)
        return metadata.persistedAgentSession?.agentId
            ?? metadata.terminalAgentId
            ?? TerminalAgentResolver.resolve(workspaceId: source.id)?.id
            ?? TerminalAgent.claudeId
    }

    private var sourceAgentName: String {
        TerminalAgentRegistry.shared.agent(id: sourceAgentId)?.displayName ?? sourceAgentId.capitalized
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider()
            agentSection
            Divider()
            modeSection
            Divider()
            promptEditors
            Divider()
            footer
        }
        .padding(12)
        .frame(width: panelWidth, alignment: .leading)
        .onAppear {
            selectedTarget = defaultTarget(for: sourceAgentId)
            applyPreset(selectedPreset, target: selectedTarget, force: true)
        }
        .onChange(of: selectedTarget) { applyPreset(selectedPreset, target: $0, force: false) }
        .onChange(of: selectedPreset) { applyPreset($0, target: selectedTarget, force: false) }
    }

    // User-edited = current editor text diverges from the last value
    // applied by a preset/target change. Derived, not stored.
    private var sourcePromptEdited: Bool { sourcePrompt != lastAppliedSource }
    private var targetPromptEdited: Bool { !targetPrompt.isEmpty }

    private func defaultSourcePrompt() -> String {
        selectedPreset.sourcePrompt(
            target: selectedTarget,
            workspaceTitle: sourceTitle,
            cwd: source?.currentDirectory
        )
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(TermLoopSidebarTheme.caps("Ask To"))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
            Text(verbatim: sourceTitle)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dimmer)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
            }
            .buttonStyle(.plain)
            .help("Close")
        }
    }

    private var agentSection: some View {
        HStack(spacing: 4) {
            ForEach(AskTargetAgent.allCases) { target in
                AskChip(
                    label: target.title,
                    isSelected: target == selectedTarget,
                    isEnabled: target.isRuntimeSupported,
                    hint: target.availabilityNote
                ) {
                    selectedTarget = target
                }
            }
        }
    }

    private var modeSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(TermLoopSidebarTheme.caps("Mode"))
                .font(TermLoopSidebarTheme.sectionCaps)
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .padding(.bottom, 2)
            ForEach(AskAgentPreset.allCases) { preset in
                AskModeRow(
                    title: preset.title,
                    isSelected: preset == selectedPreset
                ) {
                    selectedPreset = preset
                }
            }
        }
    }

    private var promptEditors: some View {
        VStack(alignment: .leading, spacing: 8) {
            promptEditor(
                caption: "Source (to \(sourceAgentName))",
                binding: $sourcePrompt,
                edited: sourcePromptEdited,
                reset: { resetSourcePrompt() },
                minHeight: 72
            )
            promptEditor(
                caption: "Target system prompt · optional (\(selectedTarget.title))",
                binding: $targetPrompt,
                edited: targetPromptEdited,
                reset: { resetTargetPrompt() },
                minHeight: 96
            )
        }
    }

    private func promptEditor(
        caption: String,
        binding: Binding<String>,
        edited: Bool,
        reset: @escaping () -> Void,
        minHeight: CGFloat
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(TermLoopSidebarTheme.caps(caption))
                    .font(TermLoopSidebarTheme.sectionCaps)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                if edited {
                    Text(verbatim: "· edited")
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dimmer)
                    Button(action: reset) {
                        Text(verbatim: "reset")
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .underline()
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 0)
            }
            PromptTextEditor(text: binding, minHeight: minHeight)
        }
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Spacer()
            Button("Cancel") { close() }
                .buttonStyle(.plain)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .keyboardShortcut(.cancelAction)
            Button("Start") { submit() }
                .controlSize(.small)
                .keyboardShortcut(.defaultAction)
                .disabled(isStartDisabled)
        }
    }

    private var isStartDisabled: Bool {
        source == nil
            || !selectedTarget.isRuntimeSupported
            || sourcePrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || source.map {
                WorkspaceBridgeStore.shared.activeBridge(forWorkspaceId: $0.id) != nil
            } == true
    }

    private func workspaceTitle(_ workspace: Workspace) -> String {
        let trimmed = workspace.customTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false) ? trimmed! : workspace.title
    }

    // force=true (onAppear): overwrite. force=false (preset/target
    // change): overwrite only if current text matches the previously
    // applied preset output — that means the user hasn't edited it.
    private func applyPreset(_ preset: AskAgentPreset, target: AskTargetAgent, force: Bool) {
        let newSource = preset.sourcePrompt(
            target: target,
            workspaceTitle: sourceTitle,
            cwd: source?.currentDirectory
        )
        if force || sourcePrompt == lastAppliedSource {
            sourcePrompt = newSource
            lastAppliedSource = newSource
        }
    }

    private func resetSourcePrompt() {
        let fresh = defaultSourcePrompt()
        sourcePrompt = fresh
        lastAppliedSource = fresh
    }

    private func resetTargetPrompt() {
        targetPrompt = ""
    }

    private func defaultTarget(for sourceAgentId: String) -> AskTargetAgent {
        sourceAgentId == AskTargetAgent.codex.agentId ? .claude : .codex
    }

    private func submit() {
        guard let source else {
            dismiss()
            return
        }
        let sourceId = source.id
        let target = selectedTarget
        let sourcePrompt = sourcePrompt
        let targetPrompt = targetPrompt
        let tabManager = tabManager
        close()

        // Bypass QuickAction for ask-agent flow — AskToSheet already owns all
        // authoring (target pick, preset, source/target prompts). A second
        // Quick Action review sheet just adds friction and a timing window
        // in which the helper CLI's startup reminders can provoke a
        // "Standing by..." noise reply before the real handoff arrives.
        DispatchQueue.main.async {
            do {
                _ = try AskToBridgeLauncher.launch(
                    sourceWorkspaceId: sourceId,
                    target: target,
                    sourcePrompt: sourcePrompt,
                    targetPrompt: targetPrompt,
                    tabManager: tabManager
                )
                MainAreaActivation.activateWorkspaceTerminal(sourceId, on: tabManager)
            } catch {
                #if DEBUG
                dlog("askTo.submit error=\(error)")
                #endif
            }
        }
    }

    private func close() {
        if let onClose {
            onClose()
        } else {
            dismiss()
        }
    }
}

private struct AskChip: View {
    let label: String
    let isSelected: Bool
    let isEnabled: Bool
    let hint: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(TermLoopSidebarTheme.bodyMonoStrong)
                .foregroundStyle(foreground)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
                .background(background)
                .overlay(border)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.45)
        .help(hint ?? label)
    }

    private var foreground: Color {
        if !isEnabled { return TermLoopSidebarTheme.dim }
        return isSelected ? TermLoopSidebarTheme.accent : Color.primary
    }

    private var background: some View {
        Rectangle()
            .fill(isSelected ? TermLoopSidebarTheme.activeBg : TermLoopSidebarTheme.hoverBg)
    }

    private var border: some View {
        Rectangle()
            .stroke(
                isSelected ? TermLoopSidebarTheme.accent.opacity(0.6) : TermLoopSidebarTheme.rule,
                lineWidth: 1
            )
    }
}

private struct AskModeRow: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: isSelected ? "circle.inset.filled" : "circle")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(isSelected ? TermLoopSidebarTheme.accent : TermLoopSidebarTheme.dimmer)
                Text(title)
                    .font(TermLoopSidebarTheme.bodyMono)
                    .foregroundStyle(Color.primary)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 3)
            .padding(.horizontal, 4)
            .background(isSelected ? TermLoopSidebarTheme.activeBg : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

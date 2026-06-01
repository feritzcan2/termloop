// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI
import AppKit

/// Typed trailing-slot data. Kept Equatable so panels memoizing on their
/// snapshot `==` stay stable; the tap action is a separate closure on the core
/// view so the enum does not need to hold closures.
enum AgentRowTrailingSlot: Equatable {
    case none
    case gitChangeBadge(count: Int)
    /// Same badge-tap semantics as `.gitChangeBadge` (opens the full Git
    /// Changes sheet), paired with a disclosure chevron that toggles an
    /// inline preview below the row. `isExpanded` drives the chevron
    /// orientation only — truth lives in the caller's expansion store so
    /// panels memoizing on `trailingSlot == trailingSlot` stay correct.
    case gitChangeBadgeExpandable(count: Int, isExpanded: Bool)
    /// Worktree rows need both Git affordances and the process-teardown
    /// collapse action. Badge taps still go through `onTrailingSlotTap`, the
    /// chevron uses `onTrailingExpandTap`, and the archive icon uses
    /// `onCollapseTap`.
    case gitChangeBadgeExpandableWithCollapse(count: Int, isExpanded: Bool)
    /// Stops the live terminal process and moves the workspace into the
    /// collapsed footer, where reopening restores saved agent sessions.
    case collapseButton
}

/// Dismiss-button behavior for `AgentRowCoreView`.
///
/// The `==` ignores associated closures on purpose: closure identity can
/// churn per parent render, and including it would defeat the `.equatable()`
/// memoization used on sidebar hot paths.
enum AgentRowDismissBehavior {
    case none
    /// × opens a "Delete agent?" popover; Yes fires `onConfirm`.
    case confirmClose(onConfirm: () -> Void)

    var isActive: Bool {
        if case .none = self { return false }
        return true
    }
}

extension AgentRowDismissBehavior: Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.none, .none), (.confirmClose, .confirmClose):
            return true
        default:
            return false
        }
    }
}

/// Unified agent-row renderer used by ActiveAgents, Worktree, and Ticket.
///
/// Data contract: `AgentRowPresentationSnapshot` core + typed extras. Interaction
/// hooks are typed closures, intentionally excluded from Equatable (presence-only
/// check) so stable parent-state captures do not bust memoization on every
/// sidebar telemetry tick (see `termloop/CLAUDE.md` perf discipline).
@MainActor
struct AgentRowCoreView: View, Equatable {
    let core: AgentRowPresentationSnapshot
    let isSelected: Bool
    let trailingSlot: AgentRowTrailingSlot
    let dismissBehavior: AgentRowDismissBehavior
    /// `onActivate` is intentionally required (non-optional) — every panel
    /// needs a selection target. That's why it is not presence-checked in
    /// `==` the way the optional closures are.
    let onActivate: () -> Void
    let onAcknowledgeAttention: (() -> Void)?
    let onTrailingSlotTap: (() -> Void)?
    /// Secondary tap wired to the disclosure chevron rendered inside
    /// `.gitChangeBadgeExpandable`. Ignored for every other trailing slot
    /// case. Kept out of Equatable for the same reason as the other
    /// closures — see the `==` implementation below.
    let onTrailingExpandTap: (() -> Void)?
    /// Dedicated archive action for slots that also need `onTrailingSlotTap`
    /// for another affordance (for example Worktree Git badges). Plain
    /// `.collapseButton` falls back to `onTrailingSlotTap` for compatibility.
    let onCollapseTap: (() -> Void)?

    init(
        core: AgentRowPresentationSnapshot,
        isSelected: Bool,
        trailingSlot: AgentRowTrailingSlot,
        dismissBehavior: AgentRowDismissBehavior,
        onActivate: @escaping () -> Void,
        onAcknowledgeAttention: (() -> Void)? = nil,
        onTrailingSlotTap: (() -> Void)? = nil,
        onTrailingExpandTap: (() -> Void)? = nil,
        onCollapseTap: (() -> Void)? = nil
    ) {
        self.core = core
        self.isSelected = isSelected
        self.trailingSlot = trailingSlot
        self.dismissBehavior = dismissBehavior
        self.onActivate = onActivate
        self.onAcknowledgeAttention = onAcknowledgeAttention
        self.onTrailingSlotTap = onTrailingSlotTap
        self.onTrailingExpandTap = onTrailingExpandTap
        self.onCollapseTap = onCollapseTap
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.core == rhs.core
            && lhs.isSelected == rhs.isSelected
            && lhs.trailingSlot == rhs.trailingSlot
            && lhs.dismissBehavior == rhs.dismissBehavior
            && (lhs.onAcknowledgeAttention == nil) == (rhs.onAcknowledgeAttention == nil)
            && (lhs.onTrailingSlotTap == nil) == (rhs.onTrailingSlotTap == nil)
            && (lhs.onTrailingExpandTap == nil) == (rhs.onTrailingExpandTap == nil)
            && (lhs.onCollapseTap == nil) == (rhs.onCollapseTap == nil)
    }

    @State private var isHovering = false
    @State private var isDeletePopoverPresented = false
    @State private var hasBeenTapped = false
    @FocusState private var isDeletePopoverFocused: Bool

    private var isAcknowledgeable: Bool {
        switch core.displayState {
        case .needsInput, .completed: return true
        default: return false
        }
    }

    private var statusColor: Color {
        TermLoopSidebarTheme.color(for: core.displayState)
    }

    /// Resting rows now sit on the panel's own background — no status-tinted
    /// fill, no per-row card borders. The `gray-on-gray` cards-in-cards look
    /// of the previous row chrome buried the actual signal (status, agent).
    /// Hover and selection still bring the row forward; status is carried by
    /// the leading accent strip + pill alone.
    ///
    /// Only states that demand attention (`needsInput`, `error`) keep a faint
    /// tint so the user notices them even with the panel scrolled past.
    private var rowBackground: Color {
        if isSelected { return Color.accentColor.opacity(0.20) }
        if isHovering { return TermLoopSidebarTheme.hoverBg }
        switch core.displayState {
        case .needsInput:          return statusColor.opacity(0.07)
        case .error:               return statusColor.opacity(0.08)
        default:                   return Color.clear
        }
    }

    private var borderColor: Color {
        if isSelected { return Color.accentColor.opacity(0.55) }
        // Attention states keep a hairline so they remain noticeable while
        // scrolled past. Everything else stays borderless to drop the
        // cards-in-cards effect.
        switch core.displayState {
        case .needsInput, .error:  return statusColor.opacity(0.32)
        default:                   return Color.clear
        }
    }

    private var borderWidth: CGFloat {
        if isSelected { return 1 }
        switch core.displayState {
        case .needsInput, .error:  return 1
        default:                   return 0
        }
    }

    private var horizontalPadding: CGFloat {
        isSelected ? 8 : 7
    }

    private var verticalPadding: CGFloat {
        isSelected ? 6 : 5
    }

    /// 2pt vertical accent strip on the row's leading edge. Carries status
    /// signal without tinting the entire row. Transparent for ready/idle so
    /// the resting list stays calm; pulses softly for `.running`.
    private var accentStripColor: Color {
        switch core.displayState {
        case .running, .needsInput, .completed, .error:
            return statusColor
        case .ready, .idle:
            return Color.clear
        }
    }

    private var xButtonTooltip: String {
        String(
            localized: "activeAgents.inlineDelete.agentTooltip",
            defaultValue: "Delete agent",
            table: "TermLoop"
        )
    }

    private func dismissPressed() {
        if case .confirmClose = dismissBehavior {
            isDeletePopoverPresented = true
        }
    }

    private func activate() {
        if isAcknowledgeable {
            hasBeenTapped = true
            onAcknowledgeAttention?()
        }
        onActivate()
    }

    private func confirmDelete() {
        guard isDeletePopoverPresented else { return }
        isDeletePopoverPresented = false
        if case .confirmClose(let onConfirm) = dismissBehavior {
            onConfirm()
        }
    }

    private var descriptionText: String? {
        // In dense sections, previews make every ready row look active. Keep
        // previews only for rows that are currently doing something or need
        // attention; ready/idle rows collapse back to a clean single-line
        // title + metadata shape.
        switch core.displayState {
        case .running, .needsInput, .error:
            break
        case .ready, .idle, .completed:
            return nil
        }
        let trimmed = core.preview?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private var statusAgentLabelText: String? {
        let trimmed = core.agentLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == "—" ? nil : trimmed
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            prominentMainRow
                .contentShape(Rectangle())
                .onTapGesture(perform: activate)
        }
        .padding(.horizontal, horizontalPadding)
        .padding(.vertical, verticalPadding)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(rowBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(borderColor, lineWidth: borderWidth)
        )
        // Leading status strip — replaces the old full-row tint as the
        // primary status carrier. 2pt wide, vertically inset to feel like a
        // tab marker rather than a full-height bar. Soft glow on running.
        .overlay(alignment: .leading) {
            Capsule(style: .continuous)
                .fill(accentStripColor)
                .frame(width: 2)
                .padding(.vertical, 4)
                .padding(.leading, 1)
                .shadow(
                    color: accentStripColor.opacity(core.displayState == .running ? 0.55 : 0),
                    radius: 3,
                    x: 0,
                    y: 0
                )
                .allowsHitTesting(false)
        }
        .opacity(isAcknowledgeable && hasBeenTapped && !isSelected ? 0.92 : 1.0)
        .animation(.easeInOut(duration: 0.15), value: isSelected)
        .animation(.easeInOut(duration: 0.18), value: hasBeenTapped)
        .animation(.easeInOut(duration: 0.20), value: core.displayState)
        .onChange(of: core.displayState) { _ in
            hasBeenTapped = false
        }
        .onHover { isHovering = $0 }
        .safeHelp(core.preview ?? core.agentLabel)
    }

    /// Resting rows use a small, dimmed dot — once the status pill stopped
    /// rendering for `.ready`/`.idle`, the bullet was the row's only state
    /// anchor and felt too prominent at full size + full status color. Active
    /// states keep the larger semibold icon so they still stand out.
    private var statusIcon: some View {
        let isResting: Bool
        switch core.displayState {
        case .ready, .idle: isResting = true
        default:            isResting = false
        }
        return Image(systemName: TermLoopSidebarTheme.iconName(for: core.displayState))
            .font(.system(size: isResting ? 6 : 8, weight: isResting ? .regular : .semibold))
            .foregroundStyle(statusColor.opacity(isResting ? 0.45 : 1.0))
            .frame(width: 12, height: 12)
            .padding(.top, isResting ? 3 : 2)
    }

    private var prominentMainRow: some View {
        HStack(alignment: .top, spacing: 8) {
            statusIcon
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top, spacing: 6) {
                    Text(core.title)
                        .font(TermLoopSidebarTheme.bodyMonoStrong)
                        .foregroundStyle(Color.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .layoutPriority(3)
                    Spacer(minLength: 4)
                    if showsTitleCollapseButton {
                        collapseButton
                    }
                    if dismissBehavior.isActive {
                        dismissButton
                    }
                }
                if let descriptionText {
                    Text(descriptionText)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(alignment: .center, spacing: 6) {
                    if let branch = core.branchLabel, !branch.isEmpty {
                        Text(branch)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dimmer)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .layoutPriority(1)
                    }
                    Spacer(minLength: 4)
                    trailingSlotView
                    prominentStateAndElapsed
                }
            }
        }
    }

    private var showsTitleCollapseButton: Bool {
        switch trailingSlot {
        case .collapseButton, .gitChangeBadgeExpandableWithCollapse:
            return true
        case .none, .gitChangeBadge, .gitChangeBadgeExpandable:
            return false
        }
    }

    @ViewBuilder
    private var trailingSlotView: some View {
        switch trailingSlot {
        case .none:
            EmptyView()
        case .gitChangeBadge(let count):
            gitChangeBadgeButton(count: count)
        case .gitChangeBadgeExpandable(let count, let isExpanded),
             .gitChangeBadgeExpandableWithCollapse(let count, let isExpanded):
            HStack(spacing: 4) {
                gitChangeBadgeButton(count: count)
                SidebarGitChangesChevron(
                    isExpanded: isExpanded,
                    action: { onTrailingExpandTap?() }
                )
            }
            .fixedSize(horizontal: true, vertical: false)
        case .collapseButton:
            EmptyView()
        }
    }

    private var collapseButton: some View {
        Button {
            (onCollapseTap ?? onTrailingSlotTap)?()
        } label: {
            Image(systemName: "archivebox")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .frame(width: 14, height: 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isHovering ? 1 : 0.72)
        .help(String(
            localized: "agentRow.collapse.tooltip",
            defaultValue: "Collapse and stop agent",
            table: "TermLoop"
        ))
    }

    @ViewBuilder
    private func gitChangeBadgeButton(count: Int) -> some View {
        Button {
            onTrailingSlotTap?()
        } label: {
            Text(verbatim: "\(count)")
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(count > 0 ? TermLoopSidebarTheme.gitDirty : TermLoopSidebarTheme.dim)
                .monospacedDigit()
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(count == 1 ? "1 git change" : "\(count) git changes")
        .fixedSize(horizontal: true, vertical: false)
    }

    private var prominentStateAndElapsed: some View {
        HStack(spacing: 6) {
            statusBadge
            if let statusAgentLabelText {
                Text(statusAgentLabelText)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(
                        TermLoopSidebarTheme.agentAccent(for: statusAgentLabelText)
                            .opacity(0.78)
                    )
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if let since = core.since {
                Text(TermLoopSidebarTheme.elapsedLabel(since: since))
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .monospacedDigit()
            }
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    /// Status pill is omitted for `.ready` and `.idle` — those states cover
    /// the vast majority of rows, so rendering the pill makes it the visual
    /// wallpaper rather than a signal. The leading accent strip + per-row
    /// agent label still carry enough context for resting rows; the state
    /// word returns only when the row needs attention or is actively doing
    /// work.
    ///
    /// Capsule chrome was dropped in both modes — state renders as plain
    /// colored text so the row reads as one quiet metadata line. Color is
    /// the only signal that differs (statusColor adapts per appearance).
    @ViewBuilder
    private var statusBadge: some View {
        switch core.displayState {
        case .ready, .idle:
            EmptyView()
        case .running, .needsInput, .completed, .error:
            Text(core.stateText)
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(statusColor)
        }
    }

    @ViewBuilder
    private var dismissButton: some View {
        Button(action: dismissPressed) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .frame(width: 14, height: 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Keep the close affordance discoverable even when hover updates are
        // missed by SwiftUI's memoization path. The button stays visible at a
        // low opacity and becomes fully opaque while hovered / confirming.
        .opacity(isDeletePopoverPresented ? 1 : (isHovering ? 1 : 0.72))
        .allowsHitTesting(true)
        .help(xButtonTooltip)
        .popover(isPresented: $isDeletePopoverPresented, arrowEdge: .trailing) {
            deleteAgentPopover
        }
    }

    @ViewBuilder
    private var deleteAgentPopover: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(String(
                localized: "activeAgents.inlineDelete.agentPrompt",
                defaultValue: "Delete agent?",
                table: "TermLoop"
            ))
            .font(.system(size: 13, weight: .semibold))

            HStack(spacing: 8) {
                Button(String(
                    localized: "activeAgents.inlineDelete.no",
                    defaultValue: "No",
                    table: "TermLoop"
                )) {
                    isDeletePopoverPresented = false
                }
                .keyboardShortcut(.cancelAction)

                Spacer()

                Button(role: .destructive) {
                    confirmDelete()
                } label: {
                    Text(String(
                        localized: "activeAgents.inlineDelete.yes",
                        defaultValue: "Yes",
                        table: "TermLoop"
                    ))
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(12)
        .frame(minWidth: 220, alignment: .leading)
        .focusable()
        .focused($isDeletePopoverFocused)
        .onAppear {
            isDeletePopoverFocused = true
        }
        .onKeyPress(.return) {
            confirmDelete()
            return .handled
        }
        .background(
            AgentDeletePopoverKeyMonitor(
                onConfirm: confirmDelete,
                onCancel: { isDeletePopoverPresented = false }
            )
            .frame(width: 0, height: 0)
        )
    }
}

private struct AgentDeletePopoverKeyMonitor: NSViewRepresentable {
    let onConfirm: () -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onConfirm: onConfirm, onCancel: onCancel)
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        context.coordinator.attach(to: view)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onConfirm = onConfirm
        context.coordinator.onCancel = onCancel
        context.coordinator.attach(to: nsView)
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class Coordinator {
        var onConfirm: () -> Void
        var onCancel: () -> Void

        private weak var window: NSWindow?
        private var keyMonitor: Any?

        init(onConfirm: @escaping () -> Void, onCancel: @escaping () -> Void) {
            self.onConfirm = onConfirm
            self.onCancel = onCancel
        }

        deinit {
            detach()
        }

        func attach(to view: NSView) {
            DispatchQueue.main.async { [weak self, weak view] in
                guard let self, let view, let window = view.window else { return }
                self.window = window
                if let panel = window as? NSPanel {
                    panel.becomesKeyOnlyIfNeeded = false
                }
                window.makeKeyAndOrderFront(nil)
                self.installMonitorIfNeeded()
            }
        }

        func detach() {
            if let keyMonitor {
                NSEvent.removeMonitor(keyMonitor)
                self.keyMonitor = nil
            }
            window = nil
        }

        private func installMonitorIfNeeded() {
            guard keyMonitor == nil else { return }
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, let window = self.window, window.isVisible else { return event }

                let shortcutModifiers = event.modifierFlags.intersection([.command, .control, .option])
                guard shortcutModifiers.isEmpty else { return event }

                if Self.isReturn(event) {
                    DispatchQueue.main.async { [weak self] in self?.onConfirm() }
                    return nil
                }
                if Self.isEscape(event) {
                    DispatchQueue.main.async { [weak self] in self?.onCancel() }
                    return nil
                }
                return event
            }
        }

        private static func isReturn(_ event: NSEvent) -> Bool {
            event.keyCode == 36
                || event.keyCode == 76
                || event.charactersIgnoringModifiers == "\r"
                || event.charactersIgnoringModifiers == "\u{3}"
        }

        private static func isEscape(_ event: NSEvent) -> Bool {
            event.keyCode == 53 || event.charactersIgnoringModifiers == "\u{1b}"
        }
    }
}

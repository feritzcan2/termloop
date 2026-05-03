// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Combine
import SwiftUI

@MainActor
struct QuickActionPresentationRequest {
    var initialSurface: QuickActionSurface = .run
    var targetWorkspaceId: UUID? = nil
    var worktreeIntent: QuickActionWorktreeIntent = .createWorkspace
    var composition: QuickActionCompositionSource? = nil
    var promptText: String? = nil
    var promptDocumentId: String? = nil
    var advancedSystemPrompt: String? = nil
    var systemPromptDocumentId: String? = nil
    var advancedTitle: String? = nil
    var advancedTerminalAgentId: String? = nil
    var advancedPermission: AgentTemplate.PermissionMode? = nil
    var advancedModel: AgentModelOption? = nil
    var advancedReasoning: AgentReasoningOption? = nil
    var variableValues: [String: String]? = nil
    var launchSource: AgentInvocationSource? = nil
    var reasonTag: String? = nil
    var projectId: UUID? = nil
    var placementOverride: NewWorkspacePlacement? = nil
    var suggestedBranchName: String? = nil
    var openAdvanced: Bool = false
    var onLaunchedWorkspace: ((Workspace) -> Void)? = nil
}

/// Owns the palette's lifecycle. Single instance per app; installed once at
/// launch via `TermLoopHooks.installQuickActionHotkey()`.
@MainActor
final class QuickActionController {
    static let shared = QuickActionController()

    private let detector = DoubleShiftDetector()
    private var panel: QuickActionPanel?
    private var viewModel: QuickActionViewModel?
    private var didInstall = false
    private var cancellables: Set<AnyCancellable> = []

    private init() {}

    // MARK: Install

    func install() {
        guard !didInstall else { return }
        didInstall = true
        QuickActionSettings.seedDefaultsIfNeeded()
        detector.onFire = { [weak self] in
            self?.toggle()
        }
        detector.install()
    }

    // MARK: Toggle

    func toggle() {
        if let panel = panel, panel.isVisible {
            dismiss()
        } else {
            present()
        }
    }

    func present(
        initialSurface: QuickActionSurface = .run,
        targetWorkspaceId: UUID? = nil,
        worktreeIntent: QuickActionWorktreeIntent = .createWorkspace
    ) {
        presentPrepared(
            defaultTargetWorkspaceId: targetWorkspaceId,
            worktreeIntent: worktreeIntent
        ) { viewModel in
            viewModel.activeSurface = initialSurface
        }
    }

    func present(prefill: QuickActionPresentationRequest) {
        presentPrepared(
            defaultTargetWorkspaceId: prefill.targetWorkspaceId,
            worktreeIntent: prefill.worktreeIntent
        ) { viewModel in
            viewModel.activeSurface = prefill.initialSurface
            viewModel.applyPrefill(prefill)
        }
    }

    func dismiss() {
        viewModel?.onDismiss()
        panel?.orderOut(nil)
    }

    /// Called from the view's submit path. If auto-close is enabled, runs
    /// the launch toast + fade animation before orderOut. The view calls
    /// this in place of the plain `dismiss` callback after a successful
    /// submit.
    func dismissAfterLaunch() {
        guard let panel, let viewModel else {
            dismiss()
            return
        }

        let toastTitle = launchToastTitle(for: viewModel)
        let toastSubtitle = launchToastSubtitle(for: viewModel)

        guard QuickActionSettings.autoCloseOnLaunch() else {
            viewModel.onDismiss()
            panel.orderOut(nil)
            QuickActionLaunchToastController.shared.show(title: toastTitle, subtitle: toastSubtitle)
            return
        }

        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.14
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                self?.viewModel?.onDismiss()
                self?.panel?.orderOut(nil)
                self?.panel?.alphaValue = 1
                QuickActionLaunchToastController.shared.show(title: toastTitle, subtitle: toastSubtitle)
            }
        })
    }

    private func launchToastTitle(for viewModel: QuickActionViewModel) -> String {
        switch viewModel.composition {
        case .freePrompt:
            return String(
                localized: "quickAction.toast.freePrompt",
                defaultValue: "Free prompt launched",
                table: "TermLoop"
            )
        case .template(let id):
            let name = AgentTemplateStore.shared.template(id: id)?.name ?? id
            return String(
                localized: "quickAction.toast.template",
                defaultValue: "\(name) launched",
                table: "TermLoop"
            )
        }
    }

    private func launchToastSubtitle(for viewModel: QuickActionViewModel) -> String? {
        switch viewModel.advancedRunMode {
        case .terminal:
            return String(
                localized: "quickAction.toast.subtitle.terminal",
                defaultValue: "Terminal workspace opened",
                table: "TermLoop"
            )
        }
    }

    private func ensurePanel() -> (QuickActionPanel, QuickActionViewModel)? {
        if panel == nil {
            let vm = QuickActionViewModel()
            let view = QuickActionView(
                viewModel: vm,
                onDismiss: { [weak self] in
                    self?.dismissAfterLaunch()
                },
                onWorktreeCreated: { [weak self] in
                    self?.dismiss()
                }
            )
            panel = QuickActionPanel(rootView: view)
            viewModel = vm
            vm.$isAdvancedOpen
                .sink { [weak self] _ in
                    self?.schedulePanelLayout()
                }
                .store(in: &cancellables)
            vm.$activeSurface
                .sink { [weak self] _ in
                    self?.schedulePanelLayout()
                }
                .store(in: &cancellables)
        }
        guard let panel, let viewModel else { return nil }
        return (panel, viewModel)
    }

    private func schedulePanelLayout() {
        guard let panel, let viewModel else { return }
        DispatchQueue.main.async {
            guard panel.isVisible else { return }
            panel.applyCanonicalLayout(surface: viewModel.activeSurface, isAdvancedOpen: viewModel.isAdvancedOpen)
            panel.centerOnMouseScreen()
        }
    }

    private func presentPrepared(
        defaultTargetWorkspaceId: UUID?,
        worktreeIntent: QuickActionWorktreeIntent,
        configure: (QuickActionViewModel) -> Void
    ) {
        guard let (panel, viewModel) = ensurePanel() else { return }
        viewModel.onPresent(
            defaultTargetWorkspaceId: defaultTargetWorkspaceId,
            worktreeIntent: worktreeIntent
        )
        configure(viewModel)
        panel.applyCanonicalLayout(surface: viewModel.activeSurface, isAdvancedOpen: viewModel.isAdvancedOpen)
        show(panel)
    }

    private func show(_ panel: QuickActionPanel) {
        panel.alphaValue = 1
        panel.centerOnMouseScreen()
        panel.makeKeyAndOrderFront(nil)
    }
}

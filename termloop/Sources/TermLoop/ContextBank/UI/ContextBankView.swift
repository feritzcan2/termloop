// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Sub-tab entry point. Rendered inside the sidebar column, so everything is
/// stacked vertically: toolbar → file tree → pending suggestions.
/// Per-file open keeps the user inside Context Bank. The right pane owns
/// selected file/suggestion display; opening a row must not create a separate
/// markdown overlay that would shadow later tree selections.
struct ContextBankView: View {
    let projectRoot: URL?

    @ObservedObject private var store = ContextBankStore.shared
    @State private var showSymlinkSheet = false

    var body: some View {
        Group {
            if projectRoot != nil {
                mainContent
            } else {
                emptyState
            }
        }
        .onAppear { store.bind(to: projectRoot) }
        .onChange(of: projectRoot) { newRoot in
            store.bind(to: newRoot)
        }
        .sheet(isPresented: $showSymlinkSheet) {
            if let projectRoot {
                ContextBankSymlinkSheet(
                    projectRoot: projectRoot,
                    onFinished: { showSymlinkSheet = false }
                )
            }
        }
    }

    @ViewBuilder
    private var mainContent: some View {
        // Sidebar holds the tree + agents panel only. The right pane
        // (file viewer / suggestion diff) is rendered as a full-area
        // main-area swap via `AgentMainAreaOverlayMode.contextBank` —
        // that's what
        // replaces the previously-selected workspace's terminal when the
        // user enters the Context Bank sub-tab.
        VStack(spacing: 0) {
            toolbar
            Divider()
            ContextBankTreeView(
                files: store.files,
                tree: store.tree,
                selection: $store.selection,
                onOpen: { file in
                    MarkdownDocumentStore.shared.close()
                    store.selection = .file(file.url)
                }
            )
            .frame(maxHeight: .infinity)
            Divider()
            ContextBankAgentsPanel(
                runs: store.activeRuns,
                phase: store.analyzerPhase,
                onCancel: { ContextBankAnalysisCoordinator.shared.cancel(forkWorkspaceId: $0) },
                onDismiss: { id in
                    if let root = store.activeProjectRootURL {
                        store.removeRun(forkWorkspaceId: id, forProjectRoot: root)
                    }
                },
                onClearError: { store.clearError() },
                onOpen: { forkId in
                    // Curator forks were created with select:false so the
                    // user could keep working on their source tab. When
                    // the user clicks an agent row, we honor that intent
                    // by switching them to the fork's terminal: Loop
                    // sub-tab takes the main area back, and the fork
                    // becomes the selected workspace. The Loop filter
                    // still hides the fork from the row list — reaching
                    // it stays a Context-Bank-Analysis-Agents thing.
                    UserDefaults.standard.set(WorkSubTab.loop.rawValue,
                                              forKey: WorkSubTab.storageKey)
                    AppDelegate.shared?.tabManager?.selectedTabId = forkId
                }
            )
            .frame(minHeight: 140, idealHeight: 200, maxHeight: 300)
        }
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            Image(systemName: "books.vertical")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            Text(String(
                localized: "contextBank.title",
                defaultValue: "Context Bank",
                table: "TermLoop"
            ))
            .font(.system(size: 11, weight: .semibold, design: .monospaced))

            Spacer()

            Text("\(store.files.count)")
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .foregroundStyle(.tertiary)

            Button {
                store.refresh()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(3)
            }
            .buttonStyle(.plain)
            .help(String(localized: "contextBank.button.refresh",
                         defaultValue: "Rescan project", table: "TermLoop"))

            Button {
                showSymlinkSheet = true
            } label: {
                Image(systemName: "link")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(3)
            }
            .buttonStyle(.plain)
            .disabled(projectRoot == nil)
            .help(String(localized: "contextBank.button.symlink",
                         defaultValue: "Symlink options — mirror CLAUDE.md and AGENTS.md",
                         table: "TermLoop"))

            if store.isAnalyzing {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini)
                    Text(String(
                        localized: "contextBank.header.analyzing",
                        defaultValue: "Analyzing…",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .help(String(
                    localized: "contextBank.header.analyzing.help",
                    defaultValue: "A curator analysis is in progress. Triggered from a workspace's Send to Analyze menu.",
                    table: "TermLoop"
                ))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color(NSColor.windowBackgroundColor).opacity(0.7))
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "books.vertical")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(.secondary)
            Text(String(
                localized: "contextBank.empty.noProject",
                defaultValue: "Open a project to view its Context Bank.",
                table: "TermLoop"
            ))
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

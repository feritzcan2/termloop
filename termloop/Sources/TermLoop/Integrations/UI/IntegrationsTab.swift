// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct IntegrationsTab: View {
    let projectRoot: URL?
    @StateObject private var store = IntegrationsStore.shared
    @State private var selectedItemId: String?
    @State private var expandedKinds: Set<IntegrationKind> = Set(IntegrationKind.allCases)
    @State private var configSheet: ConfigSheetContext? = nil

    private struct ConfigSheetContext: Identifiable {
        let id = UUID()
        let presetId: String
    }

    var body: some View {
        VStack(spacing: 0) {
            IntegrationsHeader(
                onRefresh: { store.refresh() },
                onTestAll: { Task { await IntegrationTester.shared.testAll() } },
                isRefreshing: store.isRefreshing
            )
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(IntegrationKind.allCases, id: \.rawValue) { kind in
                        IntegrationsAccordionGroup(
                            kind: kind,
                            items: store.items(of: kind),
                            expanded: Binding(
                                get: { expandedKinds.contains(kind) },
                                set: { open in
                                    if open { expandedKinds.insert(kind) }
                                    else { expandedKinds.remove(kind) }
                                }
                            ),
                            selectedItemId: $selectedItemId
                        )
                    }
                }
            }
            if let id = selectedItemId, let item = store.item(id: id) {
                IntegrationsDetailPane(
                    item: item,
                    onTest: { Task { await IntegrationTester.shared.test(id: id) } },
                    onConfigure: {
                        let presetId = item.configRef?.presetId
                            ?? IntegrationPresetRegistry.presets(for: item.kind)
                                .first(where: { $0.displayName == item.displayName })?.id
                        if let presetId {
                            configSheet = ConfigSheetContext(presetId: presetId)
                        }
                    },
                    onToggleAttach: { toggleAttach(id: id) }
                )
                .frame(maxHeight: 260)
            }
        }
        .onAppear {
            store.setActiveProjectRoot(projectRoot)
            store.refresh()
        }
        .onChange(of: projectRoot) { newRoot in
            store.setActiveProjectRoot(newRoot)
        }
        .sheet(item: $configSheet) { ctx in
            if let preset = IntegrationPresetRegistry.preset(id: ctx.presetId) {
                IntegrationsConfigSheet(preset: preset, onDismiss: { configSheet = nil })
            }
        }
    }

    private func toggleAttach(id: String) {
        store.updateItem(id: id) { $0.attachedToActiveSpawn.toggle() }
    }

}

struct IntegrationsHeader: View {
    let onRefresh: () -> Void
    let onTestAll: () -> Void
    let isRefreshing: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(String(localized: "integrations.header.title",
                        defaultValue: "Integrations", table: "TermLoop"))
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .tracking(1.6)
            Spacer()
            if isRefreshing {
                ProgressView().controlSize(.small)
            }
            Button(action: onTestAll) {
                Text(String(localized: "integrations.action.testAll",
                            defaultValue: "Test all", table: "TermLoop"))
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
            }
            .buttonStyle(.plain)
            Button(action: onRefresh) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(Color.black.opacity(0.10))
        .overlay(Rectangle().frame(height: 1).foregroundColor(Color.primary.opacity(0.1)),
                 alignment: .bottom)
    }
}

private struct IntegrationInstallGuide {
    struct Snippet: Identifiable {
        let id = UUID()
        let title: String
        let body: String
    }

    let title: String
    let summary: String
    let steps: [String]
    let snippets: [Snippet]
    let notes: [String]

    static func make(for recommendation: Recommendation, projectRoot: URL?) -> IntegrationInstallGuide {
        let projectPath = projectRoot?.path ?? "<project-path>"
        switch (recommendation.kind, recommendation.itemName.lowercased()) {
        case (.cli, "app-insights-logs"):
            return IntegrationInstallGuide(
                title: "app-insights-logs",
                summary: "This integration is for reading/querying Application Insights logs from Azure CLI.",
                steps: [
                    "Install Azure CLI if `az` is not already available.",
                    "Sign in with `az login`.",
                    "Install the extension with `az extension add -n application-insights`.",
                    "Return to Integrations, refresh, and run `Test`.",
                    "If you want resource-specific validation, open `Configure…` and fill subscription, resource group, and app name.",
                    "Then query logs with `az monitor app-insights query`."
                ],
                snippets: [
                    .init(title: "Install Azure CLI",
                          body: "brew install azure-cli"),
                    .init(title: "Sign in",
                          body: "az login"),
                    .init(title: "Install extension",
                          body: "az extension add -n application-insights"),
                    .init(title: "Query traces",
                          body: "az monitor app-insights query --app <app-name-or-id> --resource-group <rg> --analytics-query \"traces | take 20\""),
                    .init(title: "Query exceptions",
                          body: "az monitor app-insights query --app <app-name-or-id> --resource-group <rg> --analytics-query \"exceptions | take 20\"")
                ],
                notes: [
                    "Microsoft Learn documents log querying under `az monitor app-insights query`, and the `application-insights` extension is required.",
                    "This integration is modeled as a logical logs/query surface backed by `az`, not as a separate standalone binary."
                ]
            )
        case (.cli, "wrangler"):
            return IntegrationInstallGuide(
                title: "wrangler",
                summary: "Install the CLI, authenticate it, then return here and run a test.",
                steps: [
                    "Install `wrangler` with your package manager.",
                    "Sign in with `wrangler login`.",
                    "Refresh the Integrations tab and run `Test`.",
                    "If needed, open `Configure…` and store the account id or token."
                ],
                snippets: [
                    .init(title: "Common install",
                          body: "npm install -g wrangler"),
                    .init(title: "Auth",
                          body: "wrangler login")
                ],
                notes: [
                    "The app does not install binaries automatically.",
                    "The `Test` action checks whether the installed CLI is reachable and authenticated."
                ]
            )
        case (.cli, "gh"):
            return IntegrationInstallGuide(
                title: "gh",
                summary: "Install GitHub CLI, authenticate it, then test it here.",
                steps: [
                    "Install `gh` with your package manager.",
                    "Run `gh auth login` in a terminal.",
                    "Return to Integrations, refresh, and run `Test`.",
                    "If you prefer token-based auth, use `Configure…` after install."
                ],
                snippets: [
                    .init(title: "Common install",
                          body: "brew install gh"),
                    .init(title: "Auth",
                          body: "gh auth login")
                ],
                notes: [
                    "If `gh` is already installed but unauthenticated, you only need the auth step."
                ]
            )
        case (.cli, "aws"):
            return IntegrationInstallGuide(
                title: "aws",
                summary: "Install AWS CLI, configure credentials, then test it here.",
                steps: [
                    "Install `aws` with your package manager.",
                    "Run `aws configure` or sign in with your normal SSO flow.",
                    "Refresh the Integrations tab and run `Test`.",
                    "If needed, store region and keys via `Configure…`."
                ],
                snippets: [
                    .init(title: "Common install",
                          body: "brew install awscli"),
                    .init(title: "Auth",
                          body: "aws configure")
                ],
                notes: [
                    "The test runner checks whether the current credentials can call STS."
                ]
            )
        case (.mcp, "context7"):
            return IntegrationInstallGuide(
                title: "context7",
                summary: "Add the MCP server to your agent config, then refresh this tab.",
                steps: [
                    "Choose the agent config you want to wire first: Codex or Claude.",
                    "Add a server named `context7` to that config.",
                    "Refresh the Integrations tab and run `Test`.",
                    "Attach it to spawn once it shows as healthy."
                ],
                snippets: [
                    .init(title: "Codex `~/.codex/config.toml`",
                          body: """
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp", "--api-key", "<YOUR_CONTEXT7_API_KEY>"]
"""),
                    .init(title: "Claude project MCP snippet",
                          body: """
{
  "context7": {
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp", "--api-key", "<YOUR_CONTEXT7_API_KEY>"]
  }
}
""")
                ],
                notes: [
                    "For Claude project scope, add the snippet under `projects[\"\(projectPath)\"].mcpServers` in `~/.claude.json`, or use your normal Claude MCP add flow.",
                    "Keep your API key in the agent config you already use; this sheet does not write MCP config yet."
                ]
            )
        case (.mcp, "atlassian"):
            return IntegrationInstallGuide(
                title: "atlassian",
                summary: "Register Atlassian's official remote MCP (Jira/Confluence/Compass) under the server name `atlassian`. Self-hosted Jira MCP packages also work — just keep the name stable.",
                steps: [
                    "Pick one: Atlassian's official remote MCP (`https://mcp.atlassian.com/v1/mcp`) or any self-hosted Jira MCP package.",
                    "Register it under the server name `atlassian` in your agent config.",
                    "Refresh the Integrations tab and run `Test`.",
                    "Attach it to spawn once discovery finds it."
                ],
                snippets: [
                    .init(title: "Claude project MCP (Atlassian official remote)",
                          body: """
{
  "atlassian": {
    "type": "http",
    "url": "https://mcp.atlassian.com/v1/mcp"
  }
}
"""),
                    .init(title: "Codex `~/.codex/config.toml` (self-hosted package)",
                          body: """
[mcp_servers.atlassian]
command = "<your-command>"
args = ["<arg1>", "<arg2>"]
""")
                ],
                notes: [
                    "This app deliberately avoids auto-installing MCP packages.",
                    "The important part for discovery is the stable server name: `atlassian`."
                ]
            )
        default:
            return IntegrationInstallGuide(
                title: recommendation.itemName,
                summary: "Install or register this integration outside the app, then come back here to refresh and test it.",
                steps: [
                    "Install the underlying binary or service with your usual workflow.",
                    "If this is an MCP integration, add it to Claude or Codex config.",
                    "Refresh the Integrations tab and run `Test`."
                ],
                snippets: [],
                notes: [
                    recommendation.reason
                ]
            )
        }
    }
}

private struct IntegrationsInstallGuideSheet: View {
    let guide: IntegrationInstallGuide
    let canConfigure: Bool
    let onDismiss: () -> Void
    let onConfigure: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(guide.title) · Install Help")
                .font(.system(size: 13, weight: .bold, design: .monospaced))
            Text(guide.summary)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.secondary)

            if !guide.steps.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Steps")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    ForEach(Array(guide.steps.enumerated()), id: \.offset) { idx, step in
                        Text("\(idx + 1). \(step)")
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }

            ForEach(guide.snippets) { snippet in
                VStack(alignment: .leading, spacing: 6) {
                    Text(snippet.title)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    ScrollView(.horizontal) {
                        Text(snippet.body)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(Color.black.opacity(0.12))
                            )
                    }
                }
            }

            if !guide.notes.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Notes")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    ForEach(Array(guide.notes.enumerated()), id: \.offset) { _, note in
                        Text(note)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }

            HStack {
                Button("Close") { onDismiss() }
                Spacer()
                if canConfigure {
                    Button("Configure…") { onConfigure() }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(20)
        .frame(width: 560)
    }
}

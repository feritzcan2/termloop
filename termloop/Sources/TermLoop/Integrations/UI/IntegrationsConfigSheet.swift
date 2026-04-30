// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct IntegrationsConfigSheet: View {
    let preset: IntegrationPreset
    let onDismiss: () -> Void

    @State private var values: [String: String] = [:]
    @State private var isTesting: Bool = false
    @State private var resultMessage: String? = nil
    @State private var resultSuccess: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(preset.displayName) · \(preset.summary)")
                .font(.system(size: 13, weight: .bold, design: .monospaced))

            ForEach(preset.fields) { field in
                fieldView(field)
            }

            if let message = resultMessage {
                Text(message)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(resultSuccess ? .green : .red)
                    .lineLimit(4)
            }

            HStack {
                Button(String(localized: "integrations.action.cancel",
                              defaultValue: "Cancel", table: "TermLoop")) {
                    onDismiss()
                }
                Spacer()
                Button {
                    Task { await testAndSave() }
                } label: {
                    if isTesting {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(String(localized: "integrations.config.save",
                                    defaultValue: "Test & Save", table: "TermLoop"))
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(isTesting)
            }
        }
        .padding(20)
        .frame(width: 420)
        .onAppear {
            for field in preset.fields {
                if let def = field.defaultValue { values[field.id] = def }
            }
        }
    }

    @ViewBuilder
    private func fieldView(_ field: ConfigField) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(field.label)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
            switch field.kind {
            case .text, .path:
                TextField(field.placeholder ?? "",
                          text: Binding(get: { values[field.id] ?? "" },
                                        set: { values[field.id] = $0 }))
                    .textFieldStyle(.roundedBorder)
            case .password:
                SecureField(field.placeholder ?? "",
                            text: Binding(get: { values[field.id] ?? "" },
                                          set: { values[field.id] = $0 }))
                    .textFieldStyle(.roundedBorder)
            case .toggle:
                Toggle(isOn: Binding(
                    get: { values[field.id] == "true" },
                    set: { values[field.id] = $0 ? "true" : "false" }
                )) { EmptyView() }
            case .select:
                Picker("", selection: Binding(
                    get: { values[field.id] ?? field.options.first ?? "" },
                    set: { values[field.id] = $0 }
                )) {
                    ForEach(field.options, id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden()
            }
        }
    }

    private func testAndSave() async {
        isTesting = true
        let result = await preset.runPreview(values: values)
        resultMessage = result.message
        resultSuccess = result.success
        if result.success {
            do {
                try preset.persist(values: values)
                IntegrationsStore.shared.refresh()
                onDismiss()
            } catch {
                resultMessage = error.localizedDescription
                resultSuccess = false
            }
        }
        isTesting = false
    }
}

// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Thin back-compat wrapper around `QuickActionAdvancedTable`. Pre-redesign
/// callers referenced this type directly; we keep the filename so external
/// references (tests, docs) don't churn. All real content lives in
/// `QuickActionAdvancedTable`.
struct QuickActionAdvancedPane: View {
    @ObservedObject var viewModel: QuickActionViewModel
    let template: AgentTemplate?

    var body: some View {
        QuickActionAdvancedTabs(viewModel: viewModel)
    }
}

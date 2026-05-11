import SwiftUI

// MARK: - WorktreeChangesSheet rendering helpers

extension WorktreeChangesSheet {

    func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundStyle(TermLoopSidebarTheme.dim)
            .padding(.horizontal, 6)
            .padding(.bottom, 2)
    }

    @ViewBuilder
    func sourceChip(source: WorktreeChangesSource, index: Int, isSpecial: Bool) -> some View {
        let isSelected = selectedSourceID == source.id
        HStack(spacing: 8) {
            if let iconName = sourceIconName(source) {
                Image(systemName: iconName)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(sourceAccentColor(source))
                    .frame(width: 14, height: 14)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(sourcePrimaryLabel(source, index: index))
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let secondary = sourceSecondaryLabel(source) {
                    Text(secondary)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dimmer)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 4)
            let count = sourceCountLabel(source)
            if !count.isEmpty {
                Text(count)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(width: isSpecial ? 230 : 260, alignment: .leading)
        .frame(minHeight: 44, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(sourceBackgroundColor(source: source, isSpecial: isSpecial))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(
                    isSelected ? sourceAccentColor(source).opacity(0.55) : Color.primary.opacity(0.04),
                    lineWidth: 1
                )
        )
        .contentShape(Rectangle())
    }

    @ViewBuilder
    func sourceRow(source: WorktreeChangesSource, index: Int, isSpecial: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if let iconName = sourceIconName(source) {
                    Image(systemName: iconName)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(sourceAccentColor(source))
                        .frame(width: 14, height: 14)
                }
                Text(sourcePrimaryLabel(source, index: index))
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                Text(sourceCountLabel(source))
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
            }
            if let secondary = sourceSecondaryLabel(source) {
                Text(secondary)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dimmer)
                    .lineLimit(2)
                    .truncationMode(.tail)
            }
            if case .commit(let commit) = source,
               let merged = mergedBranchesBySHA[commit.sha], !merged.isEmpty {
                HStack(spacing: 4) {
                    ForEach(merged, id: \.self) { branch in
                        Text("merged → \(branch)")
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(Color.green.opacity(0.9))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.green.opacity(0.12), in: Capsule())
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(sourceBackgroundColor(source: source, isSpecial: isSpecial))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(
                    selectedSourceID == source.id ? sourceAccentColor(source).opacity(0.55) : Color.clear,
                    lineWidth: 1
                )
        )
        .contentShape(Rectangle())
    }

    func sourcePrimaryLabel(_ source: WorktreeChangesSource, index: Int) -> String {
        switch source {
        case .local:
            return "Local changes"
        case .baseComparison(let target):
            return baseComparisonLabel(for: target)
        case .commit:
            return "Commit \(commitSourcePosition(index))"
        }
    }

    func sourceSecondaryLabel(_ source: WorktreeChangesSource) -> String? {
        switch source {
        case .local:
            return "Uncommitted worktree state"
        case .baseComparison(let target):
            return "Compare HEAD to \(target.branch) from merge base \(target.shortMergeBase)"
        case .commit(let commit):
            return "\(commit.shortSHA) · \(commit.subject)"
        }
    }

    func sourceCountLabel(_ source: WorktreeChangesSource) -> String {
        switch source {
        case .local:
            return fileCountLabel(localChanges.count)
        case .baseComparison(let target):
            guard let count = baseComparisonChangesByTarget[target]?.count else { return "" }
            return fileCountLabel(count)
        case .commit(let commit):
            let count: Int
            if let loaded = commitChangesBySHA[commit.sha] {
                count = loaded.count
            } else if let preloaded = commitFileCountBySHA[commit.sha] {
                count = preloaded
            } else {
                return ""
            }
            return fileCountLabel(count)
        }
    }

    private func fileCountLabel(_ count: Int) -> String {
        count == 1 ? "1 file" : "\(count) files"
    }

    var emptyFilesIconName: String {
        switch currentSource {
        case .local:
            return "checkmark.circle"
        case .baseComparison:
            return "arrow.left.arrow.right.circle"
        case .commit:
            return "point.topleft.down.curvedto.point.bottomright.up"
        }
    }

    func sourceIconName(_ source: WorktreeChangesSource) -> String? {
        switch source {
        case .local:
            return "square.and.pencil"
        case .baseComparison:
            return "arrow.left.arrow.right"
        case .commit:
            return "point.topleft.down.curvedto.point.bottomright.up"
        }
    }

    func sourceAccentColor(_ source: WorktreeChangesSource) -> Color {
        switch source {
        case .local:
            return .orange
        case .baseComparison:
            return .blue
        case .commit:
            return .accentColor
        }
    }

    func sourceBackgroundColor(source: WorktreeChangesSource, isSpecial: Bool) -> Color {
        if selectedSourceID == source.id {
            return sourceAccentColor(source).opacity(isSpecial ? 0.18 : 0.16)
        }
        if isSpecial {
            return sourceAccentColor(source).opacity(0.08)
        }
        // `Color.primary` resolves to black in light mode and white in dark
        // mode, so a tiny opacity gives a faint resting tint that works in
        // both. The previous `Color.white.opacity(0.03)` was invisible on
        // a light surface.
        return Color.primary.opacity(0.04)
    }

    func commitIndex(_ commit: WorktreeRecentCommit) -> Int {
        recentCommits.firstIndex(where: { $0.sha == commit.sha }) ?? 0
    }

    func commitSourcePosition(_ commitListIndex: Int) -> Int {
        commitListIndex + 1
    }

    func baseComparisonLabel(for target: WorktreeBaseComparisonTarget) -> String {
        "All changes vs \(target.branch)"
    }

    func currentSourceIndex() -> Int {
        availableSources.firstIndex(where: { $0.id == currentSource.id }) ?? 0
    }

    func canMoveSource(offset: Int) -> Bool {
        let next = currentSourceIndex() + offset
        return availableSources.indices.contains(next)
    }

    func moveToSource(offset: Int) {
        let next = currentSourceIndex() + offset
        guard availableSources.indices.contains(next) else { return }
        selectedSourceID = availableSources[next].id
    }

    @ViewBuilder
    func statusBadge(for status: GitFileStatus) -> some View {
        Text(status.sidebarSymbol)
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(status.sidebarTint)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(status.sidebarTint.opacity(0.12), in: Capsule())
    }

    func diffKindLabel(for status: GitFileStatus) -> String {
        switch status {
        case .modified:
            return "Modified file"
        case .added:
            return "Added file"
        case .deleted:
            return "Deleted file"
        case .renamed:
            return "Renamed file"
        case .untracked:
            return "Untracked file"
        }
    }

    @ViewBuilder
    func diffLineView(_ line: String) -> some View {
        let style = diffLineStyle(line)
        Text(line.isEmpty ? " " : line)
            .font(.system(size: 11.5, weight: .regular, design: .monospaced))
            .foregroundStyle(style.foreground)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 1)
            .background(style.background)
    }

    func diffLineStyle(_ line: String) -> (foreground: Color, background: Color) {
        if line.hasPrefix("@@") { return (.blue.opacity(0.95), Color.blue.opacity(0.12)) }
        if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff --git") ||
            line.hasPrefix("index ") || line.hasPrefix("new file mode") ||
            line.hasPrefix("deleted file mode") || line.hasPrefix("rename from ") ||
            line.hasPrefix("rename to ") {
            return (TermLoopSidebarTheme.dim, Color.primary.opacity(0.05))
        }
        if line.hasPrefix("+") { return (.green.opacity(0.98), Color.green.opacity(0.14)) }
        if line.hasPrefix("-") { return (.red.opacity(0.95), Color.red.opacity(0.12)) }
        return (Color.primary, Color.clear)
    }
}

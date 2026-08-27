import SwiftUI

// TermLoop's watch identity: a terminal set for the wrist. True-black ground,
// graphite cards drawn from the desktop rail's palette, cyan reserved for Stew
// and the primary action, green and amber only as agent status. UI chrome
// speaks the watch's rounded system voice; everything that is machine truth —
// statuses, counters, branches, paths — is monospaced. The recurring mark is
// the ❯ prompt glyph.
enum Theme {
    static let graphite = Color(red: 0.102, green: 0.125, blue: 0.137) // #1A2023
    static let stew = Color(red: 0.373, green: 0.831, blue: 0.902)     // #5FD4E6
    static let phosphor = Color(red: 0.443, green: 0.871, blue: 0.549) // #71DE8C
    static let amber = Color(red: 1.0, green: 0.706, blue: 0.329)      // #FFB454

    static var card: some ShapeStyle { graphite }
}

extension Font {
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

// One rounded graphite card per row, consistently across every list.
struct CardRow: ViewModifier {
    func body(content: Content) -> some View {
        content.listRowBackground(RoundedRectangle(cornerRadius: 12).fill(Theme.graphite))
    }
}

extension View {
    func cardRow() -> some View { modifier(CardRow()) }
}

enum AgentStatusStyle {
    static func color(_ status: String) -> Color {
        switch status {
        case "awaitingInput": return Theme.amber
        case "working": return Theme.phosphor
        case "idle": return .gray
        default: return .secondary
        }
    }

    static func label(_ status: String) -> String {
        switch status {
        case "awaitingInput": return "girdi bekliyor"
        case "working": return "çalışıyor"
        case "idle": return "boşta"
        default: return status
        }
    }
}

struct EmptyStateView: View {
    let icon: String
    let text: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 22))
                .foregroundStyle(.tertiary)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .listRowBackground(Color.clear)
    }
}

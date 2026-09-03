import ActivityKit
import StewardLiveActivityWidgetModel
import SwiftUI
import WidgetKit

@main
struct TermLoopLiveActivityBundle: WidgetBundle {
  var body: some Widget {
    StewardVoiceActivityWidget()
  }
}

private struct StewardVoiceActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: StewardVoiceActivityAttributes.self) { context in
      StewardVoiceLockScreenView(context: context)
        .activityBackgroundTint(Color(red: 0.10, green: 0.12, blue: 0.13))
        .activitySystemActionForegroundColor(.white)
        .widgetURL(activityURL(projectId: context.attributes.projectId))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label("Steward", systemImage: "waveform")
            .font(.caption.bold())
            .foregroundStyle(.green)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.attributes.startedAt, style: .timer)
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 10) {
            Image(systemName: context.state.microphoneEnabled ? "mic.fill" : "mic.slash.fill")
              .foregroundStyle(context.state.microphoneEnabled ? .red : .secondary)
            VStack(alignment: .leading, spacing: 2) {
              Text(context.attributes.projectName)
                .font(.subheadline.bold())
                .lineLimit(1)
              Text(context.state.status)
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
          }
        }
      } compactLeading: {
        Image(systemName: "waveform")
          .foregroundStyle(.green)
      } compactTrailing: {
        Image(systemName: context.state.microphoneEnabled ? "mic.fill" : "mic.slash.fill")
          .foregroundStyle(context.state.microphoneEnabled ? .red : .secondary)
      } minimal: {
        Image(systemName: context.state.microphoneEnabled ? "mic.fill" : "waveform")
          .foregroundStyle(context.state.microphoneEnabled ? .red : .green)
      }
      .widgetURL(activityURL(projectId: context.attributes.projectId))
      .keylineTint(.purple)
    }
  }
}

private struct StewardVoiceLockScreenView: View {
  let context: ActivityViewContext<StewardVoiceActivityAttributes>

  var body: some View {
    HStack(spacing: 13) {
      ZStack {
        Circle()
          .fill(Color.purple.opacity(0.28))
          .frame(width: 44, height: 44)
        Image(systemName: "waveform")
          .font(.title3.bold())
          .foregroundStyle(.green)
      }
      VStack(alignment: .leading, spacing: 3) {
        Text("STEWARD • CANLI")
          .font(.caption2.bold())
          .tracking(1.1)
          .foregroundStyle(.green)
        Text(context.attributes.projectName)
          .font(.headline)
          .lineLimit(1)
        Text(context.state.status)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 6) {
        Image(systemName: context.state.microphoneEnabled ? "mic.fill" : "mic.slash.fill")
          .font(.title3)
          .foregroundStyle(context.state.microphoneEnabled ? .red : .secondary)
          .accessibilityLabel(context.state.microphoneEnabled ? "Mikrofon açık" : "Mikrofon kapalı")
        Text(context.attributes.startedAt, style: .timer)
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
  }
}

private func activityURL(projectId: String) -> URL? {
  URL(string: "termloop://steward/\(projectId)")
}

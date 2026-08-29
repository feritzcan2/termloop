import ActivityKit
import ExpoModulesCore
import Foundation

public final class StewardLiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StewardLiveActivity")

    AsyncFunction("sync") {
      (projectId: String, projectName: String, status: String, microphoneEnabled: Bool, promise: Promise) in
      Task { @MainActor in
        do {
          let synced = try await StewardLiveActivityController.sync(
            projectId: projectId,
            projectName: projectName,
            status: status,
            microphoneEnabled: microphoneEnabled
          )
          promise.resolve(synced)
        } catch {
          promise.reject(error)
        }
      }
    }

    AsyncFunction("end") { (promise: Promise) in
      Task { @MainActor in
        await StewardLiveActivityController.endAll()
        promise.resolve(nil)
      }
    }
  }
}

@MainActor
private enum StewardLiveActivityController {
  static func sync(
    projectId: String,
    projectName: String,
    status: String,
    microphoneEnabled: Bool
  ) async throws -> Bool {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
    let cleanProjectId = String(projectId.prefix(64))
    let cleanProjectName = String(projectName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
    let cleanStatus = String(status.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
    guard !cleanProjectId.isEmpty, !cleanProjectName.isEmpty, !cleanStatus.isEmpty else { return false }

    let state = StewardVoiceActivityAttributes.ContentState(
      status: cleanStatus,
      microphoneEnabled: microphoneEnabled
    )
    let activities = Activity<StewardVoiceActivityAttributes>.activities
    if let current = activities.first(where: { $0.attributes.projectId == cleanProjectId }) {
      for activity in activities where activity.id != current.id {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      await current.update(ActivityContent(state: state, staleDate: nil))
      return true
    }

    for activity in activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
    let attributes = StewardVoiceActivityAttributes(
      projectId: cleanProjectId,
      projectName: cleanProjectName,
      startedAt: Date()
    )
    _ = try Activity.request(
      attributes: attributes,
      content: ActivityContent(state: state, staleDate: nil),
      pushType: nil
    )
    return true
  }

  static func endAll() async {
    for activity in Activity<StewardVoiceActivityAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }
}

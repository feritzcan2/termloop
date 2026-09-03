import ActivityKit
import Foundation

public struct StewardVoiceActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public let status: String
    public let microphoneEnabled: Bool

    public init(status: String, microphoneEnabled: Bool) {
      self.status = status
      self.microphoneEnabled = microphoneEnabled
    }
  }

  public let projectId: String
  public let projectName: String
  public let startedAt: Date

  public init(projectId: String, projectName: String, startedAt: Date) {
    self.projectId = projectId
    self.projectName = projectName
    self.startedAt = startedAt
  }
}

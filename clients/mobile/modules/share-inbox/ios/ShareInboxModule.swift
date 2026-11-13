import ExpoModulesCore

/// The app side of the share extension's App Group inbox. A batch is one
/// directory holding an image and its manifest; the identifier arrives through
/// the `termloop://share` URL and is validated before it names a path.
public class ShareInboxModule: Module {
  private static let appGroup = "group.ai.termloop.mobile"
  /// Batches nobody opened (a cancelled share, a crash) are not kept forever.
  private static let maxAge: TimeInterval = 24 * 60 * 60

  public func definition() -> ModuleDefinition {
    Name("ShareInbox")

    Function("read") { (batchId: String) -> [String: Any]? in
      Self.pruneStale(except: batchId)
      guard let directory = Self.directory(for: batchId),
            let data = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")),
            let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let file = manifest["file"] as? String,
            !file.contains("/"),
            FileManager.default.fileExists(atPath: directory.appendingPathComponent(file).path)
      else { return nil }
      return [
        "uri": directory.appendingPathComponent(file).absoluteString,
        "mediaType": manifest["mediaType"] as? String ?? NSNull(),
        "width": manifest["width"] as? Double ?? 0,
        "height": manifest["height"] as? Double ?? 0,
      ]
    }

    Function("remove") { (batchId: String) in
      guard let directory = Self.directory(for: batchId) else { return }
      try? FileManager.default.removeItem(at: directory)
    }
  }

  private static func inbox() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent("ShareInbox", isDirectory: true)
  }

  private static func directory(for batchId: String) -> URL? {
    guard UUID(uuidString: batchId) != nil else { return nil }
    return inbox()?.appendingPathComponent(batchId.lowercased(), isDirectory: true)
  }

  private static func pruneStale(except batchId: String) {
    guard let inbox = inbox(),
          let entries = try? FileManager.default.contentsOfDirectory(
            at: inbox, includingPropertiesForKeys: [.creationDateKey], options: [.skipsHiddenFiles])
    else { return }
    let cutoff = Date().addingTimeInterval(-maxAge)
    for entry in entries where entry.lastPathComponent != batchId.lowercased() {
      let created = (try? entry.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast
      if created < cutoff { try? FileManager.default.removeItem(at: entry) }
    }
  }
}

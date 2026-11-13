import UIKit
import UniformTypeIdentifiers

/// Receives one shared image, stages it in the App Group inbox, and hands the
/// batch to TermLoop through its URL scheme. The extension never talks to a Mac
/// and never reads credentials: choosing the Project, the agent, and the prompt
/// all happen in the app, which owns the paired connection.
final class ShareViewController: UIViewController {
  private static let appGroup = "group.ai.termloop.mobile"
  /// The Mac accepts at most 10 MB; stay under it with headroom for re-encoding.
  private static let maxBytes = 9_500_000
  private var started = false
  private let status = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let spinner = UIActivityIndicatorView(style: .medium)
    spinner.startAnimating()
    status.text = "Opening TermLoop…"
    status.font = .preferredFont(forTextStyle: .subheadline)
    status.textColor = .secondaryLabel
    status.numberOfLines = 0
    status.textAlignment = .center
    let stack = UIStackView(arrangedSubviews: [spinner, status])
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
    ])
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    Task { @MainActor in await self.handle() }
  }

  @MainActor
  private func handle() async {
    do {
      guard let provider = imageProvider() else { throw ShareFailure.noImage }
      let image = try await loadImage(from: provider)
      let batch = try stage(image)
      guard let url = URL(string: "termloop://share?batch=\(batch)") else { throw ShareFailure.noImage }
      openContainingApp(url)
      extensionContext?.completeRequest(returningItems: nil)
    } catch {
      let message = (error as? ShareFailure)?.message ?? "TermLoop could not read this image."
      let alert = UIAlertController(title: "Could not share", message: message, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
        self?.extensionContext?.cancelRequest(withError: error)
      })
      present(alert, animated: true)
    }
  }

  private func imageProvider() -> NSItemProvider? {
    let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
    return items
      .flatMap { $0.attachments ?? [] }
      .first { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
  }

  private func loadImage(from provider: NSItemProvider) async throws -> StagedImage {
    let item: NSSecureCoding? = try await withCheckedThrowingContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: item) }
      }
    }
    let data: Data?
    let declaredType: UTType?
    switch item {
    case let url as URL:
      data = try? Data(contentsOf: url)
      declaredType = UTType(filenameExtension: url.pathExtension)
    case let image as UIImage:
      data = image.pngData()
      declaredType = .png
    case let raw as Data:
      data = raw
      declaredType = provider.registeredTypeIdentifiers.compactMap(UTType.init).first { $0.conforms(to: .image) }
    default:
      data = nil
      declaredType = nil
    }
    guard let data, let image = UIImage(data: data) else { throw ShareFailure.noImage }
    let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
    // PNG and JPEG travel as they are; anything else (HEIC, GIF, …) and anything
    // too large is re-encoded as JPEG so the Mac's image endpoint accepts it.
    if data.count <= Self.maxBytes, declaredType?.conforms(to: .png) == true {
      return StagedImage(data: data, mediaType: "image/png", fileExtension: "png", size: size)
    }
    if data.count <= Self.maxBytes, declaredType?.conforms(to: .jpeg) == true {
      return StagedImage(data: data, mediaType: "image/jpeg", fileExtension: "jpg", size: size)
    }
    var candidate = image
    for quality in [0.9, 0.8, 0.7] as [CGFloat] {
      if let jpeg = candidate.jpegData(compressionQuality: quality), jpeg.count <= Self.maxBytes {
        let pixels = CGSize(width: candidate.size.width * candidate.scale, height: candidate.size.height * candidate.scale)
        return StagedImage(data: jpeg, mediaType: "image/jpeg", fileExtension: "jpg", size: pixels)
      }
      candidate = Self.downscaled(candidate, by: 0.75)
    }
    throw ShareFailure.tooLarge
  }

  private func stage(_ image: StagedImage) throws -> String {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) else {
      throw ShareFailure.noContainer
    }
    let batch = UUID().uuidString.lowercased()
    let directory = container.appendingPathComponent("ShareInbox", isDirectory: true).appendingPathComponent(batch, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let fileName = "image.\(image.fileExtension)"
    try image.data.write(to: directory.appendingPathComponent(fileName), options: .atomic)
    let manifest: [String: Any] = [
      "file": fileName,
      "mediaType": image.mediaType,
      "width": Double(image.size.width),
      "height": Double(image.size.height),
    ]
    let json = try JSONSerialization.data(withJSONObject: manifest)
    try json.write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
    return batch
  }

  /// Extensions cannot call `UIApplication.open` directly. The hosting
  /// application is reachable through the responder chain, so its open method is
  /// invoked through the Objective-C runtime.
  private func openContainingApp(_ url: URL) {
    var responder: UIResponder? = self
    let selector = sel_registerName("openURL:options:completionHandler:")
    while let current = responder {
      if current.isKind(of: UIApplication.self), current.responds(to: selector) {
        typealias OpenURL = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
        let open = unsafeBitCast(current.method(for: selector), to: OpenURL.self)
        open(current, selector, url as NSURL, NSDictionary(), nil)
        return
      }
      responder = current.next
    }
  }

  private static func downscaled(_ image: UIImage, by factor: CGFloat) -> UIImage {
    let size = CGSize(width: image.size.width * factor, height: image.size.height * factor)
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = image.scale
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }
}

private struct StagedImage {
  let data: Data
  let mediaType: String
  let fileExtension: String
  let size: CGSize
}

private enum ShareFailure: Error {
  case noImage
  case tooLarge
  case noContainer

  var message: String {
    switch self {
    case .noImage: return "Share a PNG, JPEG, or screenshot to send it to an agent."
    case .tooLarge: return "This image is too large to send. Try a smaller image."
    case .noContainer: return "TermLoop's shared inbox is unavailable. Reinstall TermLoop and try again."
    }
  }
}

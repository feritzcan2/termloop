import XCTest
import AppKit

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class QuickActionComposerTests: XCTestCase {
    private func make1x1PNG(color: NSColor) throws -> Data {
        let image = NSImage(size: NSSize(width: 1, height: 1))
        image.lockFocus()
        color.setFill()
        NSRect(x: 0, y: 0, width: 1, height: 1).fill()
        image.unlockFocus()
        let tiffData = try XCTUnwrap(image.tiffRepresentation)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: tiffData))
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }

    func testImageOnlyPasteboardBecomesPromptImageReference() throws {
        let pasteboard = NSPasteboard(name: .init("cmux-test-quickaction-image-\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.setData(try make1x1PNG(color: .systemBlue), forType: .png)

        let insertion = try XCTUnwrap(cmuxQuickActionImagePasteInsertionForTesting(pasteboard))
        XCTAssertTrue(insertion.hasPrefix("Please inspect this image: "))

        let path = String(insertion.dropFirst("Please inspect this image: ".count))
        defer { try? FileManager.default.removeItem(atPath: path) }

        XCTAssertTrue(path.hasSuffix(".png"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    }

    func testVisibleTextPasteboardDoesNotBecomePromptImageReference() throws {
        let pasteboard = NSPasteboard(name: .init("cmux-test-quickaction-text-\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.setString("<p>Hello <img src=\"https://example.com/test.png\"></p>", forType: .html)
        pasteboard.setData(try make1x1PNG(color: .systemRed), forType: .png)

        XCTAssertNil(cmuxQuickActionImagePasteInsertionForTesting(pasteboard))
    }
}

import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

final class AgentTemplateStoreTests: XCTestCase {
    private var tmp: URL!

    override func setUp() async throws {
        tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    private func write(_ name: String, id: String, scope: String = "workspace") throws -> URL {
        let url = tmp.appendingPathComponent(name)
        let text = """
        ---
        id: \(id)
        name: \(id.uppercased())
        scope: \(scope)
        ---
        body
        """
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    @MainActor
    func testLoadsAllFromOneDir() throws {
        _ = try write("a.md", id: "a")
        _ = try write("b.md", id: "b")
        let reg = AgentTemplateStore()
        reg.reloadSynchronously(builtinDir: nil, userDir: tmp, projectDir: nil)
        XCTAssertEqual(Set(reg.templates.map(\.id)), Set(["a", "b"]))
    }

    @MainActor
    func testProjectOverridesUserOverridesBuiltin() throws {
        let builtin = tmp.appendingPathComponent("builtin", isDirectory: true)
        let user = tmp.appendingPathComponent("user", isDirectory: true)
        let proj = tmp.appendingPathComponent("proj", isDirectory: true)
        for d in [builtin, user, proj] {
            try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        }
        try "---\nid: same\nname: BUILTIN\n---\n"
            .write(to: builtin.appendingPathComponent("x.md"), atomically: true, encoding: .utf8)
        try "---\nid: same\nname: USER\n---\n"
            .write(to: user.appendingPathComponent("x.md"), atomically: true, encoding: .utf8)
        try "---\nid: same\nname: PROJECT\n---\n"
            .write(to: proj.appendingPathComponent("x.md"), atomically: true, encoding: .utf8)
        let reg = AgentTemplateStore()
        reg.reloadSynchronously(builtinDir: builtin, userDir: user, projectDir: proj)
        XCTAssertEqual(reg.templates.count, 1)
        XCTAssertEqual(reg.templates[0].name, "PROJECT")
        XCTAssertEqual(reg.templates[0].source, .project)
    }

    @MainActor
    func testSkipsMalformedFilesAndReportsErrors() throws {
        _ = try write("good.md", id: "good")
        let bad = tmp.appendingPathComponent("bad.md")
        try "---\nname: no id\n---\n".write(to: bad, atomically: true, encoding: .utf8)
        let reg = AgentTemplateStore()
        reg.reloadSynchronously(builtinDir: nil, userDir: tmp, projectDir: nil)
        XCTAssertEqual(reg.templates.map(\.id), ["good"])
        XCTAssertEqual(reg.loadErrors.count, 1)
        XCTAssertTrue(reg.loadErrors[0].path.hasSuffix("bad.md"))
    }
}

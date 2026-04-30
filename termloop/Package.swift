// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "termloop",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "termloop", targets: ["termloop"])
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0")
    ],
    targets: [
        .executableTarget(
            name: "termloop",
            dependencies: ["SwiftTerm"],
            path: "Sources"
        )
    ]
)

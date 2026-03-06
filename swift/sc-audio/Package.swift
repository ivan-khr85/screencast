// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "sc-audio",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "sc-audio",
            path: "Sources"
        )
    ]
)

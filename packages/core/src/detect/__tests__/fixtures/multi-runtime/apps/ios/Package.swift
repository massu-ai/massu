// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ios",
    platforms: [.iOS(.v15)],
    targets: [
        .target(name: "iosApp", path: "Sources/iosApp")
    ]
)

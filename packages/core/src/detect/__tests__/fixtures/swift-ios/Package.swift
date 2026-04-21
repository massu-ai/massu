// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "swift-ios-fixture",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "App", targets: ["App"])
    ],
    targets: [
        .target(name: "App", path: "Sources/App"),
        .testTarget(name: "AppTests", dependencies: ["App"], path: "Tests/AppTests")
    ]
)

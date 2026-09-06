// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Supertonic",
    platforms: [
        .macOS(.v13)
    ],
    dependencies: [
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager.git", exact: "1.20.0"),
    ],
    targets: [
        .executableTarget(
            name: "example_onnx",
            dependencies: [
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager")
            ],
            path: "Sources"
        )
    ]
)

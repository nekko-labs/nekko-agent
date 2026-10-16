// swift-tools-version: 5.9
import PackageDescription

// On Apple platforms the package uses only the system frameworks (CryptoKit,
// CommonCrypto, URLSession). The Linux build, used to run the protocol tests
// without a Mac (`scripts/linux-test.sh`), takes swift-crypto for the same
// CryptoKit API. The manifest is evaluated on the host, so Xcode never sees it.
#if os(Linux)
let dependencies: [Package.Dependency] = [.package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"5.0.0")]
let cryptoDeps: [Target.Dependency] = [.product(name: "Crypto", package: "swift-crypto")]
// Swift 6.1's Linux libswiftObservation references a runtime symbol it doesn't export.
let kitLinker: [LinkerSetting] = [.unsafeFlags(["-Xlinker", "--allow-shlib-undefined"])]
#else
let kitLinker: [LinkerSetting] = []
let dependencies: [Package.Dependency] = []
let cryptoDeps: [Target.Dependency] = []
#endif

let package = Package(
    name: "NekkoProtocol",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "NekkoProtocol", targets: ["NekkoProtocol"]),
        .library(name: "NekkoKit", targets: ["NekkoKit"]),
    ],
    dependencies: dependencies,
    targets: [
        .target(name: "NekkoProtocol", dependencies: cryptoDeps),
        // The app's state (computers, connection, chats) without UIKit/SwiftUI, so it is tested here too.
        .target(name: "NekkoKit", dependencies: ["NekkoProtocol"]),
        .testTarget(name: "NekkoKitTests", dependencies: ["NekkoKit"], linkerSettings: kitLinker),
        .testTarget(name: "NekkoProtocolTests", dependencies: ["NekkoProtocol"], resources: [.copy("Fixtures")]),
    ]
)

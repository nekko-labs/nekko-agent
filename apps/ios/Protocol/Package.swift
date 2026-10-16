// swift-tools-version: 5.9
import PackageDescription

// On Apple platforms the package uses only the system frameworks (CryptoKit,
// CommonCrypto, URLSession). The Linux build, used to run the protocol tests
// without a Mac (`scripts/linux-test.sh`), takes swift-crypto for the same
// CryptoKit API. The manifest is evaluated on the host, so Xcode never sees it.
#if os(Linux)
let dependencies: [Package.Dependency] = [.package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"5.0.0")]
let cryptoDeps: [Target.Dependency] = [.product(name: "Crypto", package: "swift-crypto")]
#else
let dependencies: [Package.Dependency] = []
let cryptoDeps: [Target.Dependency] = []
#endif

let package = Package(
    name: "NekkoProtocol",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "NekkoProtocol", targets: ["NekkoProtocol"])],
    dependencies: dependencies,
    targets: [
        .target(name: "NekkoProtocol", dependencies: cryptoDeps),
        .testTarget(name: "NekkoProtocolTests", dependencies: ["NekkoProtocol"], resources: [.copy("Fixtures")]),
    ]
)

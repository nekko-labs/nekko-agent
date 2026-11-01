import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// The phone's device key for the relay HELLO (protocol 5, decision 0036). The
/// computer enrolls its public half with the pairing code and requires every
/// later HELLO to be signed with it, so the pairing secret alone is not enough
/// to connect as this phone. It signs without asking the owner (every
/// connection uses it); the Change key (`ChangeSigner`) is the one that asks.
public protocol HelloSigner: AnyObject, Sendable {
    /// X9.63 uncompressed P-256 public key (65 bytes).
    func publicKey() throws -> Data
    /// ECDSA P-256 SHA-256 signature of `message`, raw r||s (64 bytes).
    func sign(_ message: Data) throws -> Data
}

public enum HelloKey {
    /// The first line of the signed text (crates/nekko-remote `HELLO_KEY_VERSION`).
    public static let version = "nekko-hello-v1"

    /// What a HELLO answering `challenge` signs: the version, deviceId, room and challenge, one per line.
    public static func text(deviceId: String, room: String, challenge: String) -> String {
        [version, deviceId, room, challenge].joined(separator: "\n")
    }

    /// The HELLO's `helloKey` and `sig`, both base64.
    public static func proof(_ signer: HelloSigner, deviceId: String, room: String, challenge: String) throws -> (key: String, sig: String) {
        let message = Data(text(deviceId: deviceId, room: room, challenge: challenge).utf8)
        return (try signer.publicKey().base64EncodedString(), try signer.sign(message).base64EncodedString())
    }
}

/// A P-256 device key in memory: for tests, and the simulator, which has no Secure Enclave.
public final class SoftwareHelloSigner: HelloSigner, @unchecked Sendable {
    public let key: P256.Signing.PrivateKey

    public init(key: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) { self.key = key }

    public func publicKey() throws -> Data { key.publicKey.x963Representation }

    public func sign(_ message: Data) throws -> Data { try key.signature(for: message).rawRepresentation }
}

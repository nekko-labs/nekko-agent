import CryptoKit
import Foundation
import NekkoKit
import NekkoProtocol

/// This iPhone's device key for the relay HELLO (decision 0036): a P-256 key
/// made in the Secure Enclave. The computer enrolls its public half when this
/// iPhone pairs and requires every later HELLO to be signed with it, so the
/// pairing secret alone is not enough to connect as this iPhone.
///
/// No Face ID on use (`.privateKeyUsage` only): every connection signs with it,
/// in the background too. The Change key is the one behind Face ID. The
/// Enclave's blob (useless off this phone) is kept in the Keychain, this
/// device only. The simulator has no Secure Enclave: there the key is a
/// software key.
final class SecureEnclaveHelloSigner: HelloSigner, @unchecked Sendable {
    static let keyName = "nekko.helloKey"
    private let store: SecureStore
    private let lock = NSLock()

    init(store: SecureStore) { self.store = store }

    private enum Key {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)
    }

    private var cached: Key?

    /// The saved key, or a new one saved now.
    private func load() throws -> Key {
        if let cached { return cached }
        let key: Key
        if SecureEnclave.isAvailable {
            if let saved = store.get(Self.keyName), let data = Data(base64Encoded: saved) {
                key = .enclave(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data))
            } else {
                var error: Unmanaged<CFError>?
                guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else {
                    throw error!.takeRetainedValue() as Error
                }
                let k = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
                store.set(Self.keyName, k.dataRepresentation.base64EncodedString())
                key = .enclave(k)
            }
        } else if let saved = store.get(Self.keyName), let data = Data(base64Encoded: saved) {
            key = .software(try P256.Signing.PrivateKey(rawRepresentation: data))
        } else {
            let k = P256.Signing.PrivateKey()
            store.set(Self.keyName, k.rawRepresentation.base64EncodedString())
            key = .software(k)
        }
        cached = key
        return key
    }

    func publicKey() throws -> Data {
        try lock.withLock {
            switch try load() {
            case .enclave(let k): return k.publicKey.x963Representation
            case .software(let k): return k.publicKey.x963Representation
            }
        }
    }

    func sign(_ message: Data) throws -> Data {
        try lock.withLock {
            switch try load() {
            case .enclave(let k): return try k.signature(for: message).rawRepresentation
            case .software(let k): return try k.signature(for: message).rawRepresentation
            }
        }
    }
}

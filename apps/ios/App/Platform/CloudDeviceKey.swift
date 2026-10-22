import CryptoKit
import Foundation
import NekkoKit
import NekkoProtocol

/// This iPhone's Nekko Cloud sync key: a P-256 key-agreement key made in the
/// Secure Enclave, so the private half never exists outside it. The keyring
/// is wrapped to its public half; only this iPhone can unwrap it.
///
/// No Face ID on use (`.privateKeyUsage` only): sync runs in the background,
/// and the app lock already covers reading the synced chats. The Enclave's
/// blob (useless off this phone) is kept in the Keychain, this device only.
/// The simulator has no Secure Enclave: there the key is a software key.
final class CloudDeviceKey: @unchecked Sendable {
    static let keyName = "cloud.deviceKey"
    private let store: SecureStore
    private let lock = NSLock()
    private var cached: SyncAgreementKey?

    init(store: SecureStore) { self.store = store }

    func get() throws -> SyncAgreementKey {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        let key: SyncAgreementKey
        if SecureEnclave.isAvailable {
            if let saved = store.get(Self.keyName), let data = Data(base64Encoded: saved) {
                key = SyncCrypto.EnclaveKey(try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: data))
            } else {
                var error: Unmanaged<CFError>?
                guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else {
                    throw error!.takeRetainedValue() as Error
                }
                let k = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
                store.set(Self.keyName, k.dataRepresentation.base64EncodedString())
                key = SyncCrypto.EnclaveKey(k)
            }
        } else if let saved = store.get(Self.keyName), let data = Data(base64Encoded: saved) {
            key = try SyncCrypto.SoftwareKey(rawRepresentation: data)
        } else {
            let k = SyncCrypto.SoftwareKey()
            store.set(Self.keyName, k.key.rawRepresentation.base64EncodedString())
            key = k
        }
        cached = key
        return key
    }

    func forget() {
        lock.lock()
        defer { lock.unlock() }
        cached = nil
        store.set(Self.keyName, nil)
    }
}

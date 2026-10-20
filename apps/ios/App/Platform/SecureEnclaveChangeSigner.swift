import CryptoKit
import Foundation
import LocalAuthentication
import NekkoKit
import NekkoProtocol
import Security

/// This iPhone's Change key (TASKS.md IO-33): a P-256 key in the Secure
/// Enclave that signs every Change action the computer is asked to run. The
/// computer verifies the signature, so a Change needs the owner here, not just
/// the app open.
///
/// Access control is `[.privateKeyUsage, .userPresence]`: Face ID, Touch ID or
/// the passcode. Not `.biometryCurrentSet`, which destroys the key when a face
/// or finger is added, leaving the phone unable to change anything until it is
/// paired again, and has no passcode fallback; the product rule is "Face ID or
/// the passcode", as for Allow from the Lock Screen.
///
/// One check covers five minutes: the evaluated `LAContext` is reused for
/// `reuse` seconds (and `touchIDAuthenticationAllowableReuseDuration` lets a
/// recent unlock count), then dropped so the next Change asks again.
///
/// The key's Secure Enclave blob (useless off this phone) is kept in the
/// Keychain beside the pairing material, so *Forget all computers* removes it
/// too. The simulator has no Secure Enclave: there the key is a software key.
final class SecureEnclaveChangeSigner: ChangeSigner, @unchecked Sendable {
    static let keyName = "nekko.changeKey"
    static let reuse: TimeInterval = 300

    private let store: SecureStore
    private let lock = NSLock()
    private var context: LAContext?
    private var contextAt: Date?

    init(store: SecureStore) { self.store = store }

    private enum Key {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)

        var publicKey: Data {
            switch self {
            case .enclave(let k): return k.publicKey.x963Representation
            case .software(let k): return k.publicKey.x963Representation
            }
        }

        func sign(_ message: Data) throws -> Data {
            switch self {
            case .enclave(let k): return try k.signature(for: message).rawRepresentation
            case .software(let k): return try k.signature(for: message).rawRepresentation
            }
        }
    }

    /// The saved key, or a new one saved now.
    private func load(context: LAContext?) throws -> Key {
        if let saved = store.get(Self.keyName), let data = Data(base64Encoded: saved) {
            if SecureEnclave.isAvailable {
                return .enclave(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data, authenticationContext: context))
            }
            return .software(try P256.Signing.PrivateKey(rawRepresentation: data))
        }
        if SecureEnclave.isAvailable {
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                               [.privateKeyUsage, .userPresence], &error) else {
                throw error.map { $0.takeRetainedValue() as Error } ?? ChangeRefused(code: nil, message: "This iPhone can’t make a key for changes.")
            }
            let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context)
            store.set(Self.keyName, key.dataRepresentation.base64EncodedString())
            return .enclave(key)
        }
        let key = P256.Signing.PrivateKey()
        store.set(Self.keyName, key.rawRepresentation.base64EncodedString())
        return .software(key)
    }

    func publicKey() throws -> Data {
        try lock.withLock { try load(context: nil).publicKey }
    }

    func sign(_ message: Data) async throws -> Data {
        let ctx = try await authenticated()
        return try lock.withLock { try load(context: ctx).sign(message) }
    }

    /// A context the owner unlocked within the last five minutes, asking now if there is none.
    private func authenticated() async throws -> LAContext {
        if let ctx = recent() { return ctx }
        let ctx = LAContext()
        ctx.touchIDAuthenticationAllowableReuseDuration = Self.reuse
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            throw ChangeRefused(code: nil, message: "Set a passcode on this iPhone to make changes on your computer from it.")
        }
        do {
            _ = try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Confirm a change on your computer")
        } catch {
            throw ChangeRefused(code: nil, message: "Not confirmed, so nothing changed on your computer.")
        }
        lock.withLock {
            context = ctx
            contextAt = Date()
        }
        return ctx
    }

    private func recent() -> LAContext? {
        lock.withLock {
            if let ctx = context, let at = contextAt, Date().timeIntervalSince(at) < Self.reuse { return ctx }
            context?.invalidate()
            context = nil
            contextAt = nil
            return nil
        }
    }
}

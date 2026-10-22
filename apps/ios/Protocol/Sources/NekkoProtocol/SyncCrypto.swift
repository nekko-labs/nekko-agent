import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// A device's sync agreement key: a software key in tests, a Secure Enclave
/// key on the iPhone (`SyncCrypto.EnclaveKey`).
public protocol SyncAgreementKey {
    var publicKeyX963: Data { get }
    func sharedSecret(with peer: P256.KeyAgreement.PublicKey) throws -> SharedSecret
}

/// End-to-end encrypted chat sync with Nekko Cloud (Pro and Team), byte for
/// byte as `crates/nekko-sync` makes it; both are held to
/// `Fixtures/sync-crypto.json` (a copy of `crates/nekko-sync/tests/golden/sync-crypto.json`).
/// The design is `docs/SYNC-ENCRYPTION.md`; in short:
///
/// - a **keyring** (record key ‖ object id key, 64 bytes) per key epoch, held
///   in plaintext only on the user's devices;
/// - **records** sealed with AES-256-GCM under a key and nonce derived from a
///   fresh 32-byte salt, the account, epoch, collection, object id and
///   revision bound as associated data, and the plaintext Padmé-padded;
/// - the keyring **wrapped** to each device's P-256 key (ECIES; on the iPhone
///   the private key is a Secure Enclave key), authenticated by the sending
///   device's key, and to the public half of a P-256 key derived from a 256-bit
///   **recovery key** the user keeps;
/// - a one-time **join code** for approving a new device, which checks the new
///   device's key on the approver and the approver on the new device;
/// - opt-in **donations** sealed to Nekko Labs' offline research key.
public enum SyncCrypto {
    public static let version = "nekko-sync/v1"
    public static let donationVersion = "nekko-donation/v1"
    public static let objectIdLength = 43
    public static let publicKeyLength = 65
    public static let minPadded = 256
    static let blobVersion: UInt8 = 1
    static let saltBytes = 32
    static let tagBytes = 16

    public enum Failure: Error, Equatable {
        /// Too short, an unknown version byte, or not base64url.
        case malformed
        /// The tag did not verify: wrong key, wrong context, or tampered.
        case unauthentic
        /// A collection, id or key outside what the format allows.
        case invalid
        /// A recovery key whose checksum doesn't match (a typo).
        case checksum
    }

    // MARK: Keyring

    /// The account's secret for one key epoch.
    public struct Keyring: Equatable {
        let enc: Data
        let id: Data

        public init(bytes: Data) throws {
            guard bytes.count == 64 else { throw Failure.malformed }
            enc = Data(bytes.prefix(32))
            id = Data(bytes.suffix(32))
        }

        /// The first keyring of an account.
        public static func generate() -> Keyring {
            try! Keyring(bytes: E2E.randomBytes(64))
        }

        /// The next epoch's keyring: a new record key, the same id key.
        public func rotated() -> Keyring {
            try! Keyring(bytes: E2E.randomBytes(32) + id)
        }

        /// `enc ‖ id`, for wrapping and the Keychain.
        public var bytes: Data { enc + id }
    }

    // MARK: Records

    static func validCollection(_ c: String) -> Bool {
        let b = Array(c.utf8)
        guard let first = b.first, b.count <= 32, (0x61...0x7a).contains(first) else { return false }
        return b.allSatisfy { (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2d }
    }

    static func validObjectId(_ id: String) -> Bool {
        id.utf8.count == objectIdLength && id.utf8.allSatisfy { b in
            (0x41...0x5a).contains(b) || (0x61...0x7a).contains(b) || (0x30...0x39).contains(b) || b == 0x2d || b == 0x5f
        }
    }

    /// The opaque id the server files a record under.
    public static func objectId(keyring: Keyring, collection: String, localId: String) throws -> String {
        guard validCollection(collection), !localId.isEmpty else { throw Failure.invalid }
        let mac = HMAC<SHA256>.authenticationCode(for: Data("\(version) object\n\(collection)\n\(localId)".utf8),
                                                  using: SymmetricKey(data: keyring.id))
        return base64url(Data(mac))
    }

    public static func recordAAD(account: String, keyId: UInt32, collection: String, objectId: String, revision: UInt64) -> String {
        "\(version) record\n\(account)\n\(keyId)\n\(collection)\n\(objectId)\n\(revision)"
    }

    /// Seal one revision of a record. `salt` is injectable for the shared vectors only.
    public static func sealRecord(keyring: Keyring, account: String, keyId: UInt32, collection: String, objectId: String,
                                  revision: UInt64, plaintext: Data, salt: Data? = nil) throws -> String {
        guard validCollection(collection), validObjectId(objectId), revision > 0 else { throw Failure.invalid }
        let salt = salt ?? E2E.randomBytes(saltBytes)
        guard salt.count == saltBytes else { throw Failure.invalid }
        let aad = Data(recordAAD(account: account, keyId: keyId, collection: collection, objectId: objectId, revision: revision).utf8)
        let (key, nonce) = keyAndNonce(ikm: keyring.enc, salt: salt, info: Data("\(version) record".utf8))
        let box = try AES.GCM.seal(frame(plaintext), using: key, nonce: nonce, authenticating: aad)
        return base64url(Data([blobVersion]) + salt + box.ciphertext + box.tag)
    }

    /// Open a record; throws unless every field matches what it was sealed with.
    public static func openRecord(keyring: Keyring, account: String, keyId: UInt32, collection: String, objectId: String,
                                  revision: UInt64, blob: String) throws -> Data {
        guard validCollection(collection), validObjectId(objectId), revision > 0 else { throw Failure.invalid }
        let raw = try fromBase64url(blob)
        guard raw.count >= 1 + saltBytes + tagBytes, raw.first == blobVersion else { throw Failure.malformed }
        let salt = raw.subdata(in: 1..<(1 + saltBytes))
        let aad = Data(recordAAD(account: account, keyId: keyId, collection: collection, objectId: objectId, revision: revision).utf8)
        let (key, nonce) = keyAndNonce(ikm: keyring.enc, salt: salt, info: Data("\(version) record".utf8))
        return try unframe(open(raw.suffix(from: 1 + saltBytes), key: key, nonce: nonce, aad: aad))
    }

    // MARK: Padding

    /// The Padmé size for a length (leaks O(log log n) bits, at most ~12% overhead).
    public static func padme(_ len: Int) -> Int {
        if len < 2 { return len }
        let e = Int.bitWidth - 1 - len.leadingZeroBitCount // floor(log2 len)
        let s = Int.bitWidth - e.leadingZeroBitCount // floor(log2 e) + 1
        let mask = (1 << (e - s)) - 1
        return (len + mask) & ~mask
    }

    /// A 4-byte big-endian length, the bytes, zeros to the Padmé size (at least 256).
    public static func frame(_ plaintext: Data) -> Data {
        var out = Data()
        withUnsafeBytes(of: UInt32(plaintext.count).bigEndian) { out.append(contentsOf: $0) }
        out.append(plaintext)
        out.append(Data(count: padme(max(plaintext.count + 4, minPadded)) - out.count))
        return out
    }

    public static func unframe(_ framed: Data) throws -> Data {
        let f = Data(framed)
        guard f.count >= 4 else { throw Failure.malformed }
        let len = f.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
        guard f.count >= 4 + len else { throw Failure.malformed }
        return f.subdata(in: 4..<(4 + len))
    }

    // MARK: Device keys and wrapping

    public struct SoftwareKey: SyncAgreementKey {
        public let key: P256.KeyAgreement.PrivateKey
        public init(_ key: P256.KeyAgreement.PrivateKey = .init()) { self.key = key }
        public init(rawRepresentation: Data) throws { key = try .init(rawRepresentation: rawRepresentation) }
        public var publicKeyX963: Data { key.publicKey.x963Representation }
        public func sharedSecret(with peer: P256.KeyAgreement.PublicKey) throws -> SharedSecret {
            try key.sharedSecretFromKeyAgreement(with: peer)
        }
    }

    #if canImport(CryptoKit)
    /// The iPhone's device key: generated in the Secure Enclave, never leaves it.
    public struct EnclaveKey: SyncAgreementKey {
        public let key: SecureEnclave.P256.KeyAgreement.PrivateKey
        public init(_ key: SecureEnclave.P256.KeyAgreement.PrivateKey) { self.key = key }
        public var publicKeyX963: Data { key.publicKey.x963Representation }
        public func sharedSecret(with peer: P256.KeyAgreement.PublicKey) throws -> SharedSecret {
            try key.sharedSecretFromKeyAgreement(with: peer)
        }
    }
    #endif

    static func parsePublic(_ bytes: Data) throws -> P256.KeyAgreement.PublicKey {
        guard bytes.count == publicKeyLength, bytes.first == 4 else { throw Failure.invalid }
        do { return try P256.KeyAgreement.PublicKey(x963Representation: bytes) } catch { throw Failure.invalid }
    }

    /// A short code to compare on two screens before trusting a device key.
    public static func fingerprint(publicKey: Data) -> String {
        let text = crockford(Data(SHA256.hash(data: publicKey)).prefix(10))
        return stride(from: 0, to: text.count, by: 4).map { i in
            let a = text.index(text.startIndex, offsetBy: i)
            return String(text[a..<text.index(a, offsetBy: 4)])
        }.joined(separator: "-")
    }

    /// ECIES to a P-256 public key. `ephemeral` is injectable for the shared vectors only.
    public static func seal(to recipient: Data, context: String, plaintext: Data, ephemeral: SoftwareKey = SoftwareKey()) throws -> String {
        try seal(to: recipient, context: context, plaintext: plaintext, ephemeral: ephemeral, extraIKM: Data(), extraSalt: Data())
    }

    /// ECIES with extra key material: `extraIKM` follows the ephemeral ECDH
    /// secret and `extraSalt` the salt (an authenticated wrap passes the
    /// sender's static secret and public key; a join wrap the join code's key).
    static func seal(to recipient: Data, context: String, plaintext: Data, ephemeral: SoftwareKey, extraIKM: Data,
                     extraSalt: Data) throws -> String {
        let peer = try parsePublic(recipient)
        let ephPub = ephemeral.publicKeyX963
        let secret = try ephemeral.sharedSecret(with: peer)
        let (key, nonce) = keyAndNonce(ikm: raw(secret) + extraIKM, salt: ephPub + recipient + extraSalt, info: Data(context.utf8))
        let box = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: Data(context.utf8))
        return base64url(Data([blobVersion]) + ephPub + box.ciphertext + box.tag)
    }

    public static func openSealed(key: SyncAgreementKey, context: String, blob: String) throws -> Data {
        try openSealed(key: key, context: context, blob: blob, extraIKM: Data(), extraSalt: Data())
    }

    static func openSealed(key: SyncAgreementKey, context: String, blob: String, extraIKM: Data, extraSalt: Data) throws -> Data {
        let raw = try fromBase64url(blob)
        guard raw.count >= 1 + publicKeyLength + tagBytes, raw.first == blobVersion else { throw Failure.malformed }
        let ephPub = raw.subdata(in: 1..<(1 + publicKeyLength))
        guard let peer = try? parsePublic(ephPub) else { throw Failure.malformed }
        let secret = try key.sharedSecret(with: peer)
        let (k, nonce) = keyAndNonce(ikm: Self.raw(secret) + extraIKM, salt: ephPub + key.publicKeyX963 + extraSalt,
                                     info: Data(context.utf8))
        return try open(raw.suffix(from: 1 + publicKeyLength), key: k, nonce: nonce, aad: Data(context.utf8))
    }

    static func raw(_ secret: SharedSecret) -> Data {
        secret.withUnsafeBytes { Data($0) }
    }

    static func wrapContext(account: String, keyId: UInt32, recipientId: String, senderId: String) -> String {
        "\(version) wrap\n\(account)\n\(keyId)\n\(recipientId)\n\(senderId)"
    }

    /// Wrap a keyring to a device, authenticated by the sending device's own
    /// key (a static-static ECDH secret in the derivation): only the holder of
    /// `sender` could have made it, so a device takes keyrings only from
    /// devices it already trusts.
    public static func wrapKeyring(_ keyring: Keyring, account: String, keyId: UInt32, recipientId: String, recipientPublic: Data,
                                   senderId: String, sender: SyncAgreementKey, ephemeral: SoftwareKey = SoftwareKey()) throws -> String {
        let staticSecret = try raw(sender.sharedSecret(with: parsePublic(recipientPublic)))
        return try seal(to: recipientPublic, context: wrapContext(account: account, keyId: keyId, recipientId: recipientId, senderId: senderId),
                        plaintext: keyring.bytes, ephemeral: ephemeral, extraIKM: staticSecret, extraSalt: sender.publicKeyX963)
    }

    /// Open a wrap made by `senderId`, whose public key comes from this device's own trusted list.
    public static func unwrapKeyring(key: SyncAgreementKey, account: String, keyId: UInt32, deviceId: String, senderId: String,
                                     senderPublic: Data, wrap: String) throws -> Keyring {
        let staticSecret = try raw(key.sharedSecret(with: parsePublic(senderPublic)))
        return try Keyring(bytes: openSealed(key: key, context: wrapContext(account: account, keyId: keyId, recipientId: deviceId, senderId: senderId),
                                             blob: wrap, extraIKM: staticSecret, extraSalt: senderPublic))
    }

    // MARK: Join codes

    /// The one-time code a device asking to join shows, typed on a device that
    /// already syncs. Its tag (published with the new device's key) lets the
    /// approver check that key; the keyring is wrapped with a key derived from
    /// it, so the new device knows the wrap came from someone shown the code.
    public struct JoinCode: Equatable {
        let bytes: Data
        static let textLength = 16

        public init(bytes: Data) throws {
            guard bytes.count == 10 else { throw Failure.invalid }
            self.bytes = bytes
        }

        public static func generate() -> JoinCode { try! JoinCode(bytes: E2E.randomBytes(10)) }

        /// `XXXX-XXXX-XXXX-XXXX`.
        public var text: String { groups(crockford(bytes), of: 4) }

        /// What the user typed (as leniently as a recovery key; no checksum, a typo fails the tag).
        public init(text: String) throws {
            bytes = try decodeCrockford(text, chars: Self.textLength)
        }

        /// The tag the new device publishes with its key.
        public func tag(account: String, publicKey: Data) -> Data {
            let k = derive32(bytes, info: "\(version) join-tag")
            return Data(HMAC<SHA256>.authenticationCode(for: Data("\(account)\n".utf8) + publicKey, using: SymmetricKey(data: k)))
        }

        /// Does `tag` bind this code to that key? Constant time.
        public func verifies(account: String, publicKey: Data, tag: Data) -> Bool {
            let want = self.tag(account: account, publicKey: publicKey)
            guard tag.count == want.count else { return false }
            return zip(want, tag).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
        }

        func psk(account: String, deviceId: String) -> Data {
            derive32(bytes, info: "\(version) join-psk\n\(account)\n\(deviceId)")
        }
    }

    static func joinContext(account: String, keyId: UInt32, deviceId: String) -> String {
        "\(version) join-wrap\n\(account)\n\(keyId)\n\(deviceId)"
    }

    /// On the approving device: wrap the current keyring to the new device, keyed by the code the user typed.
    public static func wrapForJoin(_ keyring: Keyring, account: String, keyId: UInt32, recipientId: String, recipientPublic: Data,
                                   code: JoinCode, ephemeral: SoftwareKey = SoftwareKey()) throws -> String {
        try seal(to: recipientPublic, context: joinContext(account: account, keyId: keyId, deviceId: recipientId), plaintext: keyring.bytes,
                 ephemeral: ephemeral, extraIKM: code.psk(account: account, deviceId: recipientId), extraSalt: Data())
    }

    /// On the new device: open the wrap made with its own code.
    public static func unwrapJoin(key: SyncAgreementKey, account: String, keyId: UInt32, deviceId: String, code: JoinCode,
                                  wrap: String) throws -> Keyring {
        try Keyring(bytes: openSealed(key: key, context: joinContext(account: account, keyId: keyId, deviceId: deviceId), blob: wrap,
                                      extraIKM: code.psk(account: account, deviceId: deviceId), extraSalt: Data()))
    }

    /// HKDF-SHA256 with an empty salt, 32 bytes.
    static func derive32(_ ikm: Data, info: String) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: Data(), info: Data(info.utf8), outputByteCount: 32)
            .withUnsafeBytes { Data($0) }
    }

    static func groups(_ text: String, of n: Int) -> String {
        stride(from: 0, to: text.count, by: n).map { i in
            let a = text.index(text.startIndex, offsetBy: i)
            return String(text[a..<text.index(a, offsetBy: min(n, text.count - i))])
        }.joined(separator: "-")
    }

    /// Exactly `chars` Crockford base32 characters back to bytes: any case,
    /// dashes and ASCII spaces ignored, O read as 0, I and L as 1. ASCII only,
    /// so the iPhone reads text exactly as the computer does. The bits after
    /// the last whole byte must be zero.
    static func decodeCrockford(_ text: String, chars: Int) throws -> Data {
        var raw = Data()
        var acc: UInt32 = 0, bits: UInt32 = 0, n = 0
        for b in text.utf8 {
            if b == 0x2d || b == 0x20 || b == 0x09 || b == 0x0a || b == 0x0d { continue }
            guard b < 0x80 else { throw Failure.malformed }
            var c = Character(UnicodeScalar(b >= 0x61 && b <= 0x7a ? b - 0x20 : b))
            if c == "O" { c = "0" } else if c == "I" || c == "L" { c = "1" }
            guard let v = alphabet.firstIndex(of: c) else { throw Failure.malformed }
            n += 1
            guard n <= chars else { throw Failure.malformed }
            acc = ((acc << 5) | UInt32(v)) & 0xFFFF
            bits += 5
            if bits >= 8 {
                bits -= 8
                raw.append(UInt8((acc >> bits) & 0xFF))
            }
        }
        guard n == chars, acc & ((1 << bits) - 1) == 0 else { throw Failure.malformed }
        return raw
    }

    // MARK: Recovery key

    static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    static let recoveryTextLength = 55

    static func crockford(_ bytes: Data) -> String {
        var out = ""
        var acc: UInt32 = 0, bits: UInt32 = 0
        for b in bytes {
            acc = (acc << 8) | UInt32(b)
            bits += 8
            while bits >= 5 {
                bits -= 5
                out.append(alphabet[Int((acc >> bits) & 31)])
            }
        }
        if bits > 0 { out.append(alphabet[Int((acc << (5 - bits)) & 31)]) }
        return out
    }

    /// 256 random bits the user keeps; the only way back in if every device is lost.
    public struct RecoveryKey: Equatable {
        let bytes: Data

        public init(bytes: Data) throws {
            guard bytes.count == 32 else { throw Failure.invalid }
            self.bytes = bytes
        }

        public static func generate() -> RecoveryKey { try! RecoveryKey(bytes: E2E.randomBytes(32)) }

        /// Eleven groups of five Crockford base32 characters (the key and a 2-byte checksum).
        public var text: String {
            let t = crockford(bytes + Data(SHA256.hash(data: bytes)).prefix(2))
            return stride(from: 0, to: t.count, by: 5).map { i in
                let a = t.index(t.startIndex, offsetBy: i)
                return String(t[a..<t.index(a, offsetBy: 5)])
            }.joined(separator: "-")
        }

        /// What the user typed: any case, dashes and spaces ignored, O read as 0, I and L as 1.
        public init(text: String) throws {
            let raw = try decodeCrockford(text, chars: recoveryTextLength)
            guard raw.count == 34 else { throw Failure.malformed }
            let key = raw.prefix(32)
            guard Data(SHA256.hash(data: key)).prefix(2) == raw.suffix(2) else { throw Failure.checksum }
            bytes = Data(key)
        }
    }

    static func recoveryContext(account: String, keyId: UInt32) -> String {
        "\(version) recovery\n\(account)\n\(keyId)"
    }

    /// The recovery key's P-256 key pair: the first valid scalar among
    /// HKDF-SHA256(recovery key, info = "nekko-sync/v1 recovery-key" ‖ counter).
    /// Devices keep only its public half, so a new key epoch can be sealed for
    /// recovery without any device holding the recovery secret.
    public static func recoveryAgreementKey(_ recovery: RecoveryKey) -> SoftwareKey {
        for counter in 0...255 {
            let info = Data("\(version) recovery-key".utf8) + Data([UInt8(counter)])
            let d = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: recovery.bytes), salt: Data(), info: info,
                                           outputByteCount: 32)
            if let key = try? SoftwareKey(rawRepresentation: d.withUnsafeBytes { Data($0) }) { return key }
        }
        preconditionFailure("256 HKDF outputs are all outside the P-256 scalar range")
    }

    /// Seal a key epoch's keyring to the recovery key's public half (ECIES, like a device wrap).
    public static func sealRecovery(recoveryPublic: Data, keyring: Keyring, account: String, keyId: UInt32,
                                    ephemeral: SoftwareKey = SoftwareKey()) throws -> String {
        try seal(to: recoveryPublic, context: recoveryContext(account: account, keyId: keyId), plaintext: keyring.bytes, ephemeral: ephemeral)
    }

    public static func openRecovery(_ recovery: RecoveryKey, account: String, keyId: UInt32, blob: String) throws -> Keyring {
        try Keyring(bytes: openSealed(key: recoveryAgreementKey(recovery), context: recoveryContext(account: account, keyId: keyId), blob: blob))
    }

    // MARK: Donations

    public struct Donation: Equatable {
        public let id: String
        public let blob: String
        /// Kept on the device: the only way to withdraw this donation.
        public let deleteToken: String
        public let deleteHash: String
    }

    /// Seal an already-redacted sample to the research key. Opt-in only.
    public static func sealDonation(researchPublic: Data, payload: Data, id: Data? = nil, deleteToken: Data? = nil,
                                    ephemeral: SoftwareKey = SoftwareKey()) throws -> Donation {
        let id = base64url(id ?? E2E.randomBytes(16))
        let token = deleteToken ?? E2E.randomBytes(32)
        let blob = try seal(to: researchPublic, context: "\(donationVersion)\n\(id)", plaintext: frame(payload), ephemeral: ephemeral)
        return Donation(id: id, blob: blob, deleteToken: base64url(token), deleteHash: base64url(Data(SHA256.hash(data: token))))
    }

    /// The S256 challenge for a PKCE verifier (OAuth sign-in in the browser).
    public static func pkceChallenge(_ verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    // MARK: Primitives

    static func keyAndNonce(ikm: Data, salt: Data, info: Data) -> (SymmetricKey, AES.GCM.Nonce) {
        split(HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: 44))
    }

    static func split(_ okm: SymmetricKey) -> (SymmetricKey, AES.GCM.Nonce) {
        okm.withUnsafeBytes { buf in
            let bytes = Data(buf)
            return (SymmetricKey(data: bytes.prefix(32)), try! AES.GCM.Nonce(data: bytes.suffix(12)))
        }
    }

    static func open(_ sealed: Data, key: SymmetricKey, nonce: AES.GCM.Nonce, aad: Data) throws -> Data {
        let s = Data(sealed)
        guard s.count >= tagBytes else { throw Failure.malformed }
        do {
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: s.prefix(s.count - tagBytes), tag: s.suffix(tagBytes))
            return try AES.GCM.open(box, using: key, authenticating: aad)
        } catch {
            throw Failure.unauthentic
        }
    }

    public static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func fromBase64url(_ text: String) throws -> Data {
        guard text.utf8.allSatisfy({ b in
            (0x41...0x5a).contains(b) || (0x61...0x7a).contains(b) || (0x30...0x39).contains(b) || b == 0x2d || b == 0x5f
        }) else { throw Failure.malformed }
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        guard let d = Data(base64Encoded: s) else { throw Failure.malformed }
        return d
    }
}

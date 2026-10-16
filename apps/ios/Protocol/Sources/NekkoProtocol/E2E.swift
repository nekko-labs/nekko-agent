import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
#if canImport(CommonCrypto)
import CommonCrypto
#endif

/// End-to-end encryption for relayed traffic, wire-compatible with
/// `packages/shared/src/e2e.ts` (agent side, WebCrypto),
/// `apps/android/protocol/.../E2E.kt` and `apps/mobile/src/lib/e2e.ts`.
///
/// PBKDF2-HMAC-SHA256, 100 000 iterations, salt `nekko-relay:<room>`, derives a
/// 256-bit AES-GCM key. A sealed frame is base64(iv[12] ‖ ciphertext ‖ tag[16]),
/// which is exactly CryptoKit's `AES.GCM.SealedBox.combined` with a 12-byte nonce.
public enum E2E {
    /// PROTOCOL CONSTANTS: changing any of these breaks every existing pairing.
    public static let saltPrefix = "nekko-relay:"
    public static let iterations = 100_000
    public static let keyBytes = 32
    public static let ivBytes = 12
    static let tagBytes = 16

    public enum Failure: Error, Equatable {
        case badKey, badIV, frameTooShort, notBase64, notUTF8
    }

    /// Derive the 32-byte room key. Slow on purpose (about a second on a phone):
    /// call it once at pairing time and keep the result in the Keychain.
    public static func deriveKey(secret: String, room: String) -> Data {
        pbkdf2SHA256(password: Data(secret.utf8), salt: Data((saltPrefix + room).utf8), iterations: iterations, length: keyBytes)
    }

    /// Encrypt UTF-8 text. `iv` is injectable for deterministic tests only.
    public static func sealText(key: Data, plaintext: String, iv: Data? = nil) throws -> String {
        guard key.count == keyBytes else { throw Failure.badKey }
        let nonceBytes = iv ?? randomBytes(ivBytes)
        guard nonceBytes.count == ivBytes else { throw Failure.badIV }
        let box = try AES.GCM.seal(Data(plaintext.utf8), using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonceBytes))
        guard let combined = box.combined else { throw Failure.badIV }
        return combined.base64EncodedString()
    }

    /// Decrypt a frame sealed here or on the agent. Throws on a wrong key or tampering.
    public static func openText(key: Data, blob: String) throws -> String {
        guard key.count == keyBytes else { throw Failure.badKey }
        guard let packed = Data(base64Encoded: blob, options: .ignoreUnknownCharacters) else { throw Failure.notBase64 }
        guard packed.count >= ivBytes + tagBytes else { throw Failure.frameTooShort }
        let box = try AES.GCM.SealedBox(combined: packed)
        let plain = try AES.GCM.open(box, using: SymmetricKey(data: key))
        guard let text = String(data: plain, encoding: .utf8) else { throw Failure.notUTF8 }
        return text
    }

    public static func seal(key: Data, value: JSONValue) throws -> String {
        try sealText(key: key, plaintext: value.serialized())
    }

    public static func open(key: Data, blob: String) throws -> JSONValue {
        try JSONValue.parse(openText(key: key, blob: blob))
    }

    public static func randomBytes(_ n: Int) -> Data {
        var g = SystemRandomNumberGenerator()
        return Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
    }

    public static func toHex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    public static func fromHex(_ hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var it = hex.makeIterator()
        while let a = it.next(), let b = it.next() {
            guard let byte = UInt8(String([a, b]), radix: 16) else { return nil }
            out.append(byte)
        }
        return out
    }

    /// PBKDF2-HMAC-SHA256 (RFC 8018). CommonCrypto on Apple platforms (fast,
    /// constant-time HMAC); a straight HMAC loop elsewhere, used only by the
    /// Linux test build.
    static func pbkdf2SHA256(password: Data, salt: Data, iterations: Int, length: Int) -> Data {
        #if canImport(CommonCrypto)
        var out = Data(count: length)
        let status = out.withUnsafeMutableBytes { outBuf in
            password.withUnsafeBytes { pw in
                salt.withUnsafeBytes { s in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pw.baseAddress?.assumingMemoryBound(to: Int8.self), password.count,
                        s.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                        outBuf.baseAddress?.assumingMemoryBound(to: UInt8.self), length)
                }
            }
        }
        precondition(status == kCCSuccess, "PBKDF2 failed")
        return out
        #else
        let key = SymmetricKey(data: password)
        var out = Data()
        var block: UInt32 = 1
        while out.count < length {
            var saltBlock = salt
            withUnsafeBytes(of: block.bigEndian) { saltBlock.append(contentsOf: $0) }
            var u = Data(HMAC<SHA256>.authenticationCode(for: saltBlock, using: key))
            var t = [UInt8](u)
            for _ in 1..<iterations {
                u = Data(HMAC<SHA256>.authenticationCode(for: u, using: key))
                for (i, b) in u.enumerated() { t[i] ^= b }
            }
            out.append(contentsOf: t)
            block += 1
        }
        return out.prefix(length)
        #endif
    }
}

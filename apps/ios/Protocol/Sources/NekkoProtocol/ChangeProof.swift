import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// The signed proof a phone attaches to a Change action (TASKS.md IO-33).
///
/// The computer refuses a change-class call (editing a file, a git push, a
/// terminal keystroke, once those ship) unless it carries `proof: { ts, sig }`
/// beside `args`: an ECDSA P-256 SHA-256 signature, by the key this phone
/// registered over `device:registerKey`, of
///
///     nekko-change-v1 \n deviceId \n channel \n hex(sha256(canonical JSON of args)) \n ts
///
/// (no spaces; `ts` in milliseconds since the epoch). The computer refuses a
/// proof more than 5 minutes old or a minute ahead, and one it has seen
/// before. Must match `crates/nekko-remote/src/proof.rs`; both are tested
/// against `Fixtures/change-proof.json`.
public enum ChangeProof {
    public static let version = "nekko-change-v1"
    /// The phone channel the computer's gate answers itself (`PHONE_KEY_CHANNEL`).
    public static let keyChannel = "device:registerKey"

    /// Arguments that hold a number other than an integer within ±2^53.
    public struct Unsignable: Error, Equatable {}

    /// The canonical JSON of a call's arguments: no whitespace, object keys
    /// sorted by their UTF-8 bytes, integers in plain decimal, strings escaping
    /// only `"`, `\` and U+0000 to U+001F (as `\u00xx`).
    public static func canonicalJSON(_ v: JSONValue) throws -> String {
        var out = ""
        try write(v, into: &out)
        return out
    }

    private static let maxSafe: Int64 = 1 << 53

    private static func write(_ v: JSONValue, into out: inout String) throws {
        switch v {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i):
            guard i.magnitude <= UInt64(maxSafe) else { throw Unsignable() }
            out += String(i)
        case .double(let d):
            guard d.isFinite, d == d.rounded(), abs(d) <= Double(maxSafe) else { throw Unsignable() }
            out += String(Int64(d))
        case .string(let s): quote(s, into: &out)
        case .array(let a):
            out += "["
            for (i, x) in a.enumerated() {
                if i > 0 { out += "," }
                try write(x, into: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            let keys = o.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
            for (i, k) in keys.enumerated() {
                if i > 0 { out += "," }
                quote(k, into: &out)
                out += ":"
                try write(o[k]!, into: &out)
            }
            out += "}"
        }
    }

    private static func quote(_ s: String, into out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            default:
                if u.value < 0x20 {
                    out += "\\u00" + (u.value < 0x10 ? "0" : "") + String(u.value, radix: 16)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
    }

    /// The text this phone signs for one call.
    public static func payload(deviceId: String, channel: String, args: [JSONValue], ts: Int64) throws -> String {
        let canonical = try canonicalJSON(.array(args))
        let hex = SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
        return [version, deviceId, channel, hex, String(ts)].joined(separator: "\n")
    }

    /// `{ ts, sig }` for a call, signed by `signer`.
    public static func proof(signer: ChangeSigner, deviceId: String, channel: String, args: [JSONValue],
                             ts: Int64) async throws -> JSONValue {
        let text = try payload(deviceId: deviceId, channel: channel, args: args, ts: ts)
        let sig = try await signer.sign(Data(text.utf8))
        return ["ts": .int(ts), "sig": .string(sig.base64EncodedString())]
    }

    /// Whether `sig` (raw r||s) is `publicKey`'s (X9.63) signature of `text`.
    public static func verify(publicKey: Data, text: String, sig: Data) -> Bool {
        guard let key = try? P256.Signing.PublicKey(x963Representation: publicKey),
              let s = try? P256.Signing.ECDSASignature(rawRepresentation: sig) else { return false }
        return key.isValidSignature(s, for: Data(text.utf8))
    }
}

/// What signs this phone's Change proofs. In the app, a Secure Enclave key
/// behind Face ID or the passcode (`SecureEnclaveChangeSigner`); in tests,
/// `SoftwareChangeSigner`.
public protocol ChangeSigner: AnyObject, Sendable {
    /// The public key the computer verifies with: X9.63 uncompressed P-256 (65 bytes).
    func publicKey() throws -> Data
    /// An ECDSA P-256 SHA-256 signature of `message`, raw r||s (64 bytes).
    /// May ask for Face ID or the passcode; throws if the owner cancels.
    func sign(_ message: Data) async throws -> Data
}

/// A P-256 key in memory: for tests, and the simulator, which has no Secure Enclave.
public final class SoftwareChangeSigner: ChangeSigner, @unchecked Sendable {
    public let key: P256.Signing.PrivateKey
    public private(set) var signatures = 0
    private let lock = NSLock()

    public init(key: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) { self.key = key }

    public convenience init(rawRepresentation: Data) throws {
        self.init(key: try P256.Signing.PrivateKey(rawRepresentation: rawRepresentation))
    }

    public func publicKey() throws -> Data { key.publicKey.x963Representation }

    public func sign(_ message: Data) async throws -> Data {
        lock.withLock { signatures += 1 }
        return try key.signature(for: message).rawRepresentation
    }
}

/// Why the computer refused a phone's call: `Not allowed from a paired phone (<code>): <detail>`.
public struct PhoneRefusal: Equatable, Sendable {
    public let code: String
    public let detail: String

    public init?(_ message: String) {
        let prefix = "Not allowed from a paired phone ("
        guard message.hasPrefix(prefix) else { return nil }
        let rest = message.dropFirst(prefix.count)
        guard let close = rest.firstIndex(of: ")") else { return nil }
        code = String(rest[..<close])
        detail = String(rest[rest.index(after: close)...]).trimmingCharacters(in: CharacterSet(charactersIn: ": "))
    }

    /// The proof was missing, wrong, old or used: signing again may fix it.
    public var isProof: Bool { code.hasPrefix("proof-") }

    /// What to tell the owner, or nil to show the computer's message as is.
    public func message(computer: String) -> String? {
        switch code {
        case "read-off": return "Reading from this phone is turned off on \(computer). Turn it on in Remote access → What phones can do."
        case "change-off": return "Changes from this phone are turned off on \(computer). Turn them on in Remote access → What phones can do."
        case "key-mismatch": return "\(computer) knows a different key for this phone. Remove this phone on \(computer) and pair it again."
        case "key-missing", "key-invalid": return "\(computer) couldn’t set up Face ID for changes from this phone. Try again."
        case "proof-required", "proof-invalid", "proof-replayed": return "\(computer) couldn’t confirm it was you. Try again."
        case "proof-stale": return "\(computer) couldn’t confirm it was you: check that this phone’s clock is right, then try again."
        case "device-unknown": return "\(computer) doesn’t know this phone any more. Pair it again."
        case "channel-denied": return "\(computer) doesn’t allow this from a phone. Update Nekko on \(computer) if it’s new."
        case "value-invalid" where detail == "secret file": return "This file may hold secrets, so it never leaves \(computer)."
        default: return nil
        }
    }
}

import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Step-up (SK-6, spec `spec/platform/hardware-keys-step-up-and-remote-sign-out.md`,
/// decision 0018): a second factor the owner holds, a FIDO2 security key, a
/// platform passkey or a one-time code, asked for on top of the Change proof
/// before a phone raises a chat's mode or the default mode.
///
/// The computer is the relying party. It issues the challenge
/// (`security:challenge`, read class, single use, two minutes), holds every
/// credential's public key and counter in its `security.json`, and verifies
/// the answer itself. The phone only carries the answer inside the sealed
/// request, beside the Change proof:
///
///     { type:'req', id, channel, args, proof: { ts, sig }, stepUp }
///
/// where `stepUp` is `{ credentialId, authenticatorData, clientDataJSON,
/// signature }` (unpadded base64url, WebAuthn's JSON form) or `{ totp }`.
/// One accepted step-up covers that phone's guarded calls for five minutes,
/// in the computer's memory: the phone keeps no window of its own.
///
/// Must match `packages/shared/src/step-up.ts` and
/// `crates/nekko-remote/src/step_up.rs`. `StepUpVerifier` below is the
/// Swift twin of their verifier, run against the same golden fixture
/// (`Fixtures/step-up.json`, a copy of `crates/nekko-remote/tests/golden/step-up.json`)
/// so the phone's encodings are proven to be the ones the computer accepts.
public enum StepUp {
    /// `STEP_UP_CHALLENGE.channel`.
    public static let challengeChannel = Channels.securityChallenge
    /// `STEP_UP_CHALLENGE.ttlMs`: a challenge is refused `step-up-stale` after this.
    public static let challengeTtlMs: Int64 = 2 * 60 * 1000
    /// `STEP_UP_COVER_MS`: how long the computer lets one step-up cover this
    /// phone's guarded calls. Shown to the owner; never enforced here.
    public static let coverMs: Int64 = 5 * 60 * 1000
    /// WebAuthn's `clientDataJSON.type` for an assertion and a registration.
    public static let assertionType = "webauthn.get"
    public static let registrationType = "webauthn.create"
    /// `STEP_UP_TOTP.digits`.
    public static let totpDigits = 6
    /// How many times the sheet is shown again after a refused answer
    /// (wrong code, a key that wasn't accepted, a slow touch) before the
    /// call gives up with the computer's last word.
    public static let maxAttempts = 3

    /// The phone channels the computer may ask a step-up for
    /// (`STEP_UP_PHONE_GUARDED`): raising a chat's mode or the default mode.
    public static let guardedChannels: Set<String> = [Channels.sessionSetOptions, Channels.settingsUpdate]
    /// Never guarded, never proved (`STEP_UP_NEVER_GUARDED`): a safety exit
    /// must never be harder than the attack.
    public static let neverGuarded: Set<String> = [Channels.appQuit, Channels.deviceSignOut, Channels.remoteStop]

    /// A computer's relying-party id (`stepUpRpId`): per computer, so a
    /// credential registered on one is useless on another.
    public static func rpId(installId: String) -> String { "nekko-computer:\(installId)" }

    /// What the Watch says when it is asked for a guarded action: it has no
    /// authenticator, so the owner confirms on the iPhone (spec, Platforms).
    public static let watchRefusal = "Confirm on your phone."

    /// The owner's note on every step-up surface (2026-10-24): kept word for
    /// word, curly apostrophe and all. "let us know" opens `issuesURL`.
    public static let untestedHardwareNote =
        "The Devs don’t have a hardware security key to test this one, so we tried our best without one! If you see any issues, please let us know 🙏"
    /// The note's tap target: the repo's public issue tracker.
    public static let issuesURL = URL(string: "https://github.com/nekko-labs/nekko-agent/issues/new")!

    /// Whether a refusal code is one of the step-up refusals.
    public static func isStepUpCode(_ code: String?) -> Bool { code.flatMap(StepUpCode.init(rawValue:)) != nil }

    // MARK: Encodings (as `fromB64url` / `toB64url` in step-up.ts)

    /// Base64 or base64url, padded or not; nil when it is neither.
    public static func fromB64url(_ text: String) -> Data? {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_-")
        var body = Substring(text)
        var pad = 0
        while body.last == "=" {
            body = body.dropLast()
            pad += 1
        }
        guard pad <= 2, body.allSatisfy({ allowed.contains($0) }) else { return nil }
        let std = body.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        if std.count % 4 == 1 { return nil }
        return Data(base64Encoded: std + String(repeating: "=", count: (4 - std.count % 4) % 4))
    }

    /// Unpadded base64url.
    public static func toB64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// A DER ECDSA signature (WebAuthn's form) as raw 64-byte r||s, or nil (`derToRaw`).
    public static func derToRaw(_ der: Data) -> Data? {
        let d = [UInt8](der)
        var i = 0
        func byte() -> Int {
            guard i < d.count else { return -1 }
            defer { i += 1 }
            return Int(d[i])
        }
        guard byte() == 0x30 else { return nil }
        let total = byte()
        guard total >= 0, total & 0x80 == 0, total == d.count - 2 else { return nil }
        var out = [UInt8](repeating: 0, count: 64)
        for part in 0..<2 {
            guard byte() == 0x02 else { return nil }
            let len = byte()
            guard len >= 1, len <= 33, i + len <= d.count else { return nil }
            var int = Array(d[i..<(i + len)])
            i += len
            if int.count == 33 {
                guard int[0] == 0 else { return nil }
                int.removeFirst()
            }
            out.replaceSubrange((part * 32 + 32 - int.count)..<(part * 32 + 32), with: int)
        }
        return i == d.count ? Data(out) : nil
    }

    /// Raw r||s as DER, what an authenticator sends (`rawToDer`).
    public static func rawToDer(_ raw: Data) -> Data {
        let r = [UInt8](raw)
        func int(_ b: ArraySlice<UInt8>) -> [UInt8] {
            var v = Array(b)
            while v.count > 1, v[0] == 0 { v.removeFirst() }
            return v[0] & 0x80 != 0 ? [0x02, UInt8(v.count + 1), 0] + v : [0x02, UInt8(v.count)] + v
        }
        let body = int(r[0..<32]) + int(r[32..<64])
        return Data([0x30, UInt8(body.count)] + body)
    }

    // MARK: TOTP (RFC 6238 over HOTP, RFC 4226; SHA-1, 30 s, 6 digits)

    private static let base32 = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    /// RFC 4648 base32, spaces and padding ignored; nil on any other character.
    public static func base32Decode(_ text: String) -> Data? {
        var bits = 0
        var value = 0
        var out: [UInt8] = []
        for c in text.uppercased() where !c.isWhitespace && c != "=" {
            guard let i = base32.firstIndex(of: c) else { return nil }
            value = ((value << 5) | i) & 0xffff
            bits += 5
            if bits >= 8 {
                out.append(UInt8((value >> (bits - 8)) & 0xff))
                bits -= 8
            }
        }
        return Data(out)
    }

    /// The code for one 30-second step.
    public static func totp(secret: Data, step: Int64) -> String {
        var msg = [UInt8](repeating: 0, count: 8)
        var n = UInt64(bitPattern: step)
        for i in stride(from: 7, through: 0, by: -1) {
            msg[i] = UInt8(n & 0xff)
            n >>= 8
        }
        let mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: Data(msg), using: SymmetricKey(data: secret)))
        let off = Int(mac[mac.count - 1] & 0x0f)
        let bin = (UInt32(mac[off] & 0x7f) << 24) | (UInt32(mac[off + 1]) << 16) | (UInt32(mac[off + 2]) << 8) | UInt32(mac[off + 3])
        let code = String(bin % 1_000_000)
        return String(repeating: "0", count: totpDigits - code.count) + code
    }

    public static func totpStep(nowMs: Int64) -> Int64 { nowMs / 1000 / 30 }
}

// MARK: - Refusals

/// The step-up refusals (`StepUpCode`), as the computer names them in
/// `Not allowed from a paired phone (<code>): <channel>`.
public enum StepUpCode: String, Sendable, CaseIterable {
    case required = "step-up-required"
    case invalid = "step-up-invalid"
    case stale = "step-up-stale"
    case replayed = "step-up-replayed"

    /// The plain sentence for the owner (`STEP_UP_MESSAGES`, with the computer named).
    public func message(computer: String) -> String {
        switch self {
        case .required: return "Confirm with your security key or a code to do this on \(computer)."
        case .invalid: return "\(computer) didn’t accept that key or code. Try again."
        case .stale: return "That confirmation took too long. Try again."
        case .replayed: return "That confirmation was already used. Try again."
        }
    }
}

// MARK: - The challenge

/// A kind of registered method; the only thing a phone learns about them.
public enum StepUpMethodKind: String, Sendable, CaseIterable, Comparable {
    case passkey
    case securityKey = "security-key"
    case totp

    public static func < (a: StepUpMethodKind, b: StepUpMethodKind) -> Bool { a.rawValue < b.rawValue }

    /// The name Settings → Security lists it by.
    public var label: String {
        switch self {
        case .securityKey: return "Security key"
        case .passkey: return "Passkey"
        case .totp: return "One-time code"
        }
    }
}

/// What `security:challenge` answers (`StepUpChallengeReply`).
public struct StepUpChallenge: Equatable, Sendable {
    /// 18 random bytes, unpadded base64url.
    public let challenge: String
    public let expiresAt: Int64
    /// Whether a guarded call needs a step-up now (`security.json` has it on).
    public let required: Bool
    /// The kinds registered, sorted; kinds this version doesn't know are left out.
    public let methods: [StepUpMethodKind]
    /// The computer's relying-party id, which the FIDO2 client must name.
    /// Nil from a computer that doesn't say it: then only a code can answer.
    public let rpId: String?
    /// Set when the computer lets this phone register a key or passkey itself.
    public let registration: StepUpRegistrationOffer?

    public init(challenge: String, expiresAt: Int64, required: Bool, methods: [StepUpMethodKind], rpId: String? = nil,
                registration: StepUpRegistrationOffer? = nil) {
        self.challenge = challenge
        self.expiresAt = expiresAt
        self.required = required
        self.methods = methods
        self.rpId = rpId
        self.registration = registration
    }

    public static func from(_ v: JSONValue?) -> StepUpChallenge? {
        guard let v, let challenge = v.str("challenge"), StepUp.fromB64url(challenge) != nil else { return nil }
        let kinds = Set((v["methods"]?.array ?? []).compactMap { $0.string.flatMap(StepUpMethodKind.init(rawValue:)) })
        let rp = v.str("rpId").flatMap { $0.isEmpty ? nil : $0 }
        return StepUpChallenge(challenge: challenge, expiresAt: v.long("expiresAt") ?? 0, required: v.flag("required"),
                               methods: kinds.sorted(), rpId: rp, registration: StepUpRegistrationOffer.from(v["register"]))
    }

    /// The bytes an authenticator signs over (inside `clientDataJSON`).
    public var bytes: Data? { StepUp.fromB64url(challenge) }

    /// A key or passkey can answer: one is registered and the computer named its relying party.
    public var acceptsFido2: Bool { rpId != nil && (methods.contains(.securityKey) || methods.contains(.passkey)) }
    public var acceptsTotp: Bool { methods.contains(.totp) }
}

/// The computer's offer to register a FIDO2 credential from this phone:
/// `security:challenge`'s optional `register` field. The computer must
/// opt in; no computer does yet (SK-4 builds registration on the desktop),
/// so Settings → Security on the phone says where to add a key until one
/// does. The phone calls `channel` with one `StepUpRegistration`, signed
/// with the Change proof like any change.
public struct StepUpRegistrationOffer: Equatable, Sendable {
    public let channel: String
    public let rpId: String
    /// A fresh single-use challenge for the registration, base64url.
    public let challenge: String
    /// WebAuthn's user handle for the owner on this computer, base64url.
    public let userId: String
    /// The user name the key shows (the computer's name, usually).
    public let userName: String

    public init(channel: String, rpId: String, challenge: String, userId: String, userName: String) {
        self.channel = channel
        self.rpId = rpId
        self.challenge = challenge
        self.userId = userId
        self.userName = userName
    }

    public static func from(_ v: JSONValue?) -> StepUpRegistrationOffer? {
        guard let v, let channel = v.str("channel"), !channel.isEmpty, let rp = v.str("rpId"), !rp.isEmpty,
              let challenge = v.str("challenge"), StepUp.fromB64url(challenge) != nil,
              let user = v.str("userId"), StepUp.fromB64url(user) != nil else { return nil }
        return StepUpRegistrationOffer(channel: channel, rpId: rp, challenge: challenge, userId: user,
                                       userName: v.str("userName") ?? "Nekko Agent")
    }
}

// MARK: - The payload

/// A FIDO2 assertion as the authenticator gave it (raw bytes; the DER signature as is).
public struct StepUpAssertion: Equatable, Sendable {
    public let credentialId: Data
    public let authenticatorData: Data
    public let clientDataJSON: Data
    public let signature: Data

    public init(credentialId: Data, authenticatorData: Data, clientDataJSON: Data, signature: Data) {
        self.credentialId = credentialId
        self.authenticatorData = authenticatorData
        self.clientDataJSON = clientDataJSON
        self.signature = signature
    }

    /// WebAuthn's JSON form, every field unpadded base64url.
    public var json: JSONValue {
        ["credentialId": .string(StepUp.toB64url(credentialId)),
         "authenticatorData": .string(StepUp.toB64url(authenticatorData)),
         "clientDataJSON": .string(StepUp.toB64url(clientDataJSON)),
         "signature": .string(StepUp.toB64url(signature))]
    }

    public static func from(_ v: JSONValue?) -> StepUpAssertion? {
        guard let v, let id = v.str("credentialId").flatMap(StepUp.fromB64url),
              let auth = v.str("authenticatorData").flatMap(StepUp.fromB64url),
              let cdj = v.str("clientDataJSON").flatMap(StepUp.fromB64url),
              let sig = v.str("signature").flatMap(StepUp.fromB64url) else { return nil }
        return StepUpAssertion(credentialId: id, authenticatorData: auth, clientDataJSON: cdj, signature: sig)
    }

    /// The challenge the authenticator signed over, as `clientDataJSON` says it.
    public var challenge: String? { (try? JSONValue.parse(clientDataJSON))?.str("challenge") }
}

/// What a guarded request carries beside `proof` (`StepUpProof`).
public enum StepUpProof: Equatable, Sendable {
    case assertion(StepUpAssertion)
    case totp(String)

    public var json: JSONValue {
        switch self {
        case .assertion(let a): return a.json
        case .totp(let code): return ["totp": .string(code)]
        }
    }

    /// A typed code: digits only (spaces and dashes dropped), exactly six; nil otherwise.
    public static func code(_ typed: String) -> StepUpProof? {
        let digits = typed.filter { $0 != " " && $0 != "-" && $0 != "\u{00a0}" }
        guard digits.count == StepUp.totpDigits, digits.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
        return .totp(digits)
    }
}

/// A credential this phone registered, sent to the computer's registration
/// channel. The computer checks `clientDataJSON` (type `webauthn.create`,
/// its challenge), stores `publicKey` and `credentialId`, and adds the
/// `clientDataJSON.origin` to the origins it accepts (decision 0018).
public struct StepUpRegistration: Equatable, Sendable {
    public let kind: StepUpMethodKind
    public let name: String
    public let credentialId: Data
    /// X9.63 uncompressed P-256 (65 bytes), from the attestation's COSE key.
    public let publicKey: Data
    /// The signature counter in the attestation's authenticator data.
    public let counter: UInt32
    public let clientDataJSON: Data
    public let attestationObject: Data

    public init(kind: StepUpMethodKind, name: String, credentialId: Data, publicKey: Data, counter: UInt32,
                clientDataJSON: Data, attestationObject: Data) {
        self.kind = kind
        self.name = name
        self.credentialId = credentialId
        self.publicKey = publicKey
        self.counter = counter
        self.clientDataJSON = clientDataJSON
        self.attestationObject = attestationObject
    }

    /// From what `AuthenticationServices` hands back. Nil when the
    /// attestation holds no ES256 P-256 key (the only kind the computer verifies).
    public static func from(kind: StepUpMethodKind, name: String, credentialId: Data, clientDataJSON: Data,
                            attestationObject: Data) -> StepUpRegistration? {
        guard let parsed = StepUpAttestation.parse(attestationObject), parsed.credentialId == credentialId else { return nil }
        return StepUpRegistration(kind: kind, name: name, credentialId: credentialId, publicKey: parsed.publicKey,
                                  counter: parsed.counter, clientDataJSON: clientDataJSON, attestationObject: attestationObject)
    }

    /// As `security.json` keeps a credential: id base64url, public key base64.
    public var json: JSONValue {
        ["kind": .string(kind.rawValue), "name": .string(name), "credentialId": .string(StepUp.toB64url(credentialId)),
         "publicKey": .string(publicKey.base64EncodedString()), "counter": .int(Int64(counter)),
         "clientDataJSON": .string(StepUp.toB64url(clientDataJSON)),
         "attestationObject": .string(StepUp.toB64url(attestationObject))]
    }
}

/// Just enough CBOR to read a WebAuthn attestation object: the
/// authenticator data's attested credential and its COSE EC2 P-256 key.
public enum StepUpAttestation {
    public struct Parsed: Equatable, Sendable {
        public let rpIdHash: Data
        public let flags: UInt8
        public let counter: UInt32
        public let credentialId: Data
        /// X9.63 uncompressed P-256.
        public let publicKey: Data
    }

    public static func parse(_ attestationObject: Data) -> Parsed? {
        var r = CBORReader([UInt8](attestationObject))
        guard case .map(let top)? = r.read(), r.atEnd,
              let authData = top.first(where: { $0.0 == .text("authData") })?.1, case .bytes(let auth) = authData else { return nil }
        return parseAuthData(auth)
    }

    /// `rpIdHash(32) flags(1) counter(4) aaguid(16) idLength(2) id coseKey`.
    public static func parseAuthData(_ a: [UInt8]) -> Parsed? {
        guard a.count >= 55, a[32] & 0x40 != 0 else { return nil }
        let counter = (UInt32(a[33]) << 24) | (UInt32(a[34]) << 16) | (UInt32(a[35]) << 8) | UInt32(a[36])
        let idLength = Int(a[53]) << 8 | Int(a[54])
        guard a.count >= 55 + idLength else { return nil }
        let id = Data(a[55..<(55 + idLength)])
        var r = CBORReader(Array(a[(55 + idLength)...]))
        guard case .map(let key)? = r.read() else { return nil }
        func int(_ k: Int64) -> CBORValue? { key.first(where: { $0.0 == .int(k) })?.1 }
        // kty 2 (EC2), alg -7 (ES256), crv 1 (P-256), x and y 32 bytes each.
        guard int(1) == .int(2), int(3) == .int(-7), int(-1) == .int(1),
              case .bytes(let x)? = int(-2), case .bytes(let y)? = int(-3), x.count == 32, y.count == 32 else { return nil }
        return Parsed(rpIdHash: Data(a[0..<32]), flags: a[32], counter: counter, credentialId: id, publicKey: Data([4] + x + y))
    }
}

/// A CBOR data item, as far as attestation objects need.
indirect enum CBORValue: Equatable {
    case int(Int64)
    case bytes([UInt8])
    case text(String)
    case array([CBORValue])
    case map([(CBORValue, CBORValue)])
    case simple(UInt8)

    static func == (a: CBORValue, b: CBORValue) -> Bool {
        switch (a, b) {
        case (.int(let x), .int(let y)): return x == y
        case (.bytes(let x), .bytes(let y)): return x == y
        case (.text(let x), .text(let y)): return x == y
        case (.array(let x), .array(let y)): return x == y
        case (.map(let x), .map(let y)): return x.count == y.count && zip(x, y).allSatisfy { p in p.0.0 == p.1.0 && p.0.1 == p.1.1 }
        case (.simple(let x), .simple(let y)): return x == y
        default: return false
        }
    }
}

/// Definite-length CBOR only (WebAuthn's CTAP2 canonical form); nil on anything else.
struct CBORReader {
    private let b: [UInt8]
    private var i = 0
    private var depth = 0

    init(_ bytes: [UInt8]) { b = bytes }

    var atEnd: Bool { i == b.count }

    private mutating func uint(_ info: UInt8) -> UInt64? {
        switch info {
        case 0..<24: return UInt64(info)
        case 24, 25, 26, 27:
            let n = 1 << Int(info - 24)
            guard i + n <= b.count else { return nil }
            var v: UInt64 = 0
            for k in 0..<n { v = v << 8 | UInt64(b[i + k]) }
            i += n
            return v
        default: return nil
        }
    }

    mutating func read() -> CBORValue? {
        guard i < b.count, depth < 16 else { return nil }
        let head = b[i]
        i += 1
        let major = head >> 5
        guard let n = uint(head & 0x1f) else { return nil }
        switch major {
        case 0:
            guard n <= UInt64(Int64.max) else { return nil }
            return .int(Int64(n))
        case 1:
            guard n < UInt64(Int64.max) else { return nil }
            return .int(-1 - Int64(n))
        case 2, 3:
            guard n <= UInt64(b.count - i) else { return nil }
            let bytes = Array(b[i..<(i + Int(n))])
            i += Int(n)
            if major == 2 { return .bytes(bytes) }
            guard let s = String(bytes: bytes, encoding: .utf8) else { return nil }
            return .text(s)
        case 4:
            guard n <= UInt64(b.count - i) else { return nil }
            depth += 1
            defer { depth -= 1 }
            var items: [CBORValue] = []
            for _ in 0..<Int(n) {
                guard let v = read() else { return nil }
                items.append(v)
            }
            return .array(items)
        case 5:
            guard n <= UInt64(b.count - i) else { return nil }
            depth += 1
            defer { depth -= 1 }
            var pairs: [(CBORValue, CBORValue)] = []
            for _ in 0..<Int(n) {
                guard let k = read(), let v = read() else { return nil }
                pairs.append((k, v))
            }
            return .map(pairs)
        case 7:
            guard n < 24 else { return nil }
            return .simple(UInt8(n))
        default:
            return nil
        }
    }
}

// MARK: - The verifier's Swift twin

/// A challenge the computer issued, as its book keeps it (`StepUpIssued`).
public struct StepUpIssued: Equatable, Sendable {
    public let challenge: String
    public let issuedAt: Int64
    public var used: Bool

    public init(challenge: String, issuedAt: Int64, used: Bool = false) {
        self.challenge = challenge
        self.issuedAt = issuedAt
        self.used = used
    }

    public static func from(_ v: JSONValue) -> StepUpIssued? {
        guard let c = v.str("challenge"), let at = v.long("issuedAt") else { return nil }
        return StepUpIssued(challenge: c, issuedAt: at, used: v.flag("used"))
    }
}

/// What one check did (`StepUpOutcome`): `state` and `issued` are the
/// updated copies the computer would save, whatever the outcome.
public struct StepUpOutcome: Equatable, Sendable {
    /// `ok`, or a `StepUpCode` raw value.
    public let result: String
    public var method: String?
    public var why: String?
    public var uv: Bool?
    public var cloned: String?
    public let state: JSONValue
    public let issued: [StepUpIssued]
    public var ok: Bool { result == "ok" }
}

/// The computer's step-up check, in Swift (`checkStepUp` in step-up.ts,
/// `check` in step_up.rs). The phone never decides a step-up: this exists so
/// the golden fixture proves, in the phone's own tests, that the payloads
/// the phone builds and the bytes it decodes are the ones the computer's
/// verifier accepts, and so the tests' fake computer judges like the real one.
public enum StepUpVerifier {
    public static func check(state: JSONValue, issued: [StepUpIssued], now: Int64, stepUp: JSONValue?) -> StepUpOutcome {
        var st = state.object ?? [:]
        var book = issued
        func out(_ result: String, method: String? = nil, why: String? = nil, uv: Bool? = nil, cloned: String? = nil) -> StepUpOutcome {
            StepUpOutcome(result: result, method: method, why: why, uv: uv, cloned: cloned, state: .object(st), issued: book)
        }
        guard let stepUp, !stepUp.isNull else { return out(StepUpCode.required.rawValue) }
        guard let o = stepUp.object else { return out(StepUpCode.invalid.rawValue, why: "shape") }
        if o.keys.contains("totp") {
            var totp = st["totp"]?.object
            let r = checkTotp(&totp, now: now, code: o["totp"])
            if let totp { st["totp"] = .object(totp) }
            return out(r.result, method: r.result == "ok" ? "totp" : nil, why: r.why)
        }
        let fields = ["credentialId", "authenticatorData", "clientDataJSON", "signature"]
        guard fields.allSatisfy({ o[$0]?.string != nil }) else { return out(StepUpCode.invalid.rawValue, why: "shape") }
        let decoded = fields.map { o[$0]!.string.flatMap(StepUp.fromB64url) }
        guard let idB = decoded[0], let authData = decoded[1], let cdj = decoded[2], let sigDer = decoded[3] else {
            return out(StepUpCode.invalid.rawValue, why: "encoding")
        }
        var creds = st["credentials"]?.array ?? []
        guard let ci = creds.firstIndex(where: { $0.str("id").flatMap(StepUp.fromB64url) == idB }),
              var cred = creds[ci].object else { return out(StepUpCode.invalid.rawValue, why: "credential") }
        guard let text = String(data: cdj, encoding: .utf8), let client = try? JSONValue.parse(text), client.object != nil,
              client.str("type") == StepUp.assertionType, let said = client.str("challenge") else {
            return out(StepUpCode.invalid.rawValue, why: "clientData")
        }
        guard let saidBytes = StepUp.fromB64url(said),
              let ei = book.firstIndex(where: { StepUp.fromB64url($0.challenge) == saidBytes }) else {
            return out(StepUpCode.invalid.rawValue, why: "challenge")
        }
        if book[ei].used { return out(StepUpCode.replayed.rawValue) }
        // Single use: any answer to a live challenge spends it, good or bad.
        book[ei].used = true
        if now - book[ei].issuedAt > StepUp.challengeTtlMs { return out(StepUpCode.stale.rawValue) }
        let origins = (st["origins"]?.array ?? []).compactMap(\.string)
        guard let origin = client.str("origin"), origins.contains(origin) else { return out(StepUpCode.invalid.rawValue, why: "origin") }
        guard authData.count >= 37 else { return out(StepUpCode.invalid.rawValue, why: "authenticatorData") }
        let a = [UInt8](authData)
        let rp = st["rpId"]?.string ?? ""
        guard Data(a[0..<32]) == Data(SHA256.hash(data: Data(rp.utf8))) else { return out(StepUpCode.invalid.rawValue, why: "rpId") }
        let flags = a[32]
        guard flags & 0x01 != 0 else { return out(StepUpCode.invalid.rawValue, why: "user presence") }
        guard let raw = StepUp.derToRaw(sigDer), let keyBytes = cred["publicKey"]?.string.flatMap(StepUp.fromB64url),
              keyBytes.count == 65, keyBytes.first == 4 else { return out(StepUpCode.invalid.rawValue, why: "signature") }
        var signed = authData
        signed.append(Data(SHA256.hash(data: cdj)))
        guard let key = try? P256.Signing.PublicKey(x963Representation: keyBytes),
              let sig = try? P256.Signing.ECDSASignature(rawRepresentation: raw),
              key.isValidSignature(sig, for: signed) else { return out(StepUpCode.invalid.rawValue, why: "signature") }
        let counter = Int64((UInt32(a[33]) << 24) | (UInt32(a[34]) << 16) | (UInt32(a[35]) << 8) | UInt32(a[36]))
        let stored = cred["counter"]?.int64
        if !(counter == 0 && stored == 0), stored.map({ counter <= $0 }) ?? true {
            cred["cloned"] = .bool(true)
            creds[ci] = .object(cred)
            st["credentials"] = .array(creds)
            return out(StepUpCode.invalid.rawValue, why: "counter", cloned: cred["id"]?.string)
        }
        cred["counter"] = .int(counter)
        cred["lastUsedAt"] = .int(now)
        creds[ci] = .object(cred)
        st["credentials"] = .array(creds)
        return out("ok", method: "fido2", uv: flags & 0x04 != 0)
    }

    private static func checkTotp(_ t: inout [String: JSONValue]?, now: Int64, code: JSONValue?) -> (result: String, why: String?) {
        guard var totp = t else { return (StepUpCode.invalid.rawValue, "no totp") }
        if let until = totp["lockedUntil"]?.int64, now < until { return (StepUpCode.invalid.rawValue, "locked") }
        guard let secret = totp["secret"]?.string.flatMap(StepUp.base32Decode), !secret.isEmpty else {
            return (StepUpCode.invalid.rawValue, "secret")
        }
        let step = StepUp.totpStep(nowMs: now)
        var matched: Int64?
        if let typed = code?.string, typed.count == StepUp.totpDigits, typed.allSatisfy({ ("0"..."9").contains($0) }) {
            matched = (-1...1).map { step + Int64($0) }.first { StepUp.totp(secret: secret, step: $0) == typed }
        }
        if let matched {
            if let last = totp["lastStep"]?.int64, matched <= last { return (StepUpCode.replayed.rawValue, nil) }
            totp["lastStep"] = .int(matched)
            totp["lastUsedAt"] = .int(now)
            for k in ["wrong", "lockedUntil", "locks"] { totp.removeValue(forKey: k) }
            t = totp
            return ("ok", nil)
        }
        let wrong = (totp["wrong"]?.int64 ?? 0) + 1
        totp["wrong"] = .int(wrong)
        if wrong >= 5 {
            let locks = totp["locks"]?.int64 ?? 0
            totp["lockedUntil"] = .int(now + 60_000 * (Int64(1) << locks))
            totp["locks"] = .int(locks + 1)
            totp["wrong"] = .int(0)
        }
        t = totp
        return (StepUpCode.invalid.rawValue, "code")
    }

    /// Hex SHA-256 of a recovery code, ignoring case, spaces and dashes (`hashRecoveryCode`).
    public static func hashRecoveryCode(_ code: String) -> String {
        let clean = code.lowercased().filter { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
        return SHA256.hash(data: Data(clean.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - A software authenticator (tests only)

/// A FIDO2 authenticator in memory: a P-256 key, a counter, and the
/// WebAuthn encodings an authenticator would produce. For tests, like
/// `SoftwareChangeSigner`; the app never answers a step-up with it.
public final class SoftwareStepUpAuthenticator: @unchecked Sendable {
    public let key: P256.Signing.PrivateKey
    public let credentialId: Data
    public let rpId: String
    public let origin: String
    private let lock = NSLock()
    public private(set) var counter: UInt32

    public init(rpId: String, origin: String, credentialId: Data = Data(repeating: 1, count: 16), counter: UInt32 = 0,
                key: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) {
        self.rpId = rpId
        self.origin = origin
        self.credentialId = credentialId
        self.counter = counter
        self.key = key
    }

    public var publicKey: Data { key.publicKey.x963Representation }

    /// An assertion over `challenge` (base64url), user present and verified.
    public func assert(challenge: String, flags: UInt8 = 0x05) throws -> StepUpAssertion {
        let next: UInt32 = lock.withLock {
            counter += 1
            return counter
        }
        var auth = Data(SHA256.hash(data: Data(rpId.utf8)))
        auth.append(flags)
        auth.append(contentsOf: [UInt8(next >> 24 & 0xff), UInt8(next >> 16 & 0xff), UInt8(next >> 8 & 0xff), UInt8(next & 0xff)])
        let client: JSONValue = ["type": .string(StepUp.assertionType), "challenge": .string(challenge), "origin": .string(origin)]
        let cdj = Data(client.serialized().utf8)
        var signed = auth
        signed.append(Data(SHA256.hash(data: cdj)))
        let sig = try key.signature(for: signed)
        return StepUpAssertion(credentialId: credentialId, authenticatorData: auth, clientDataJSON: cdj, signature: sig.derRepresentation)
    }

    /// As `security.json` keeps this credential.
    public func credential(name: String = "YubiKey", kind: StepUpMethodKind = .securityKey) -> JSONValue {
        ["id": .string(StepUp.toB64url(credentialId)), "publicKey": .string(publicKey.base64EncodedString()),
         "counter": 0, "name": .string(name), "kind": .string(kind.rawValue), "addedAt": 1]
    }
}

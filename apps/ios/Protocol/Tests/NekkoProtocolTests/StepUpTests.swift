import Foundation
import XCTest
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import NekkoProtocol

/// Step-up (SK-6) against the golden the computer's verifiers are tested
/// with (`crates/nekko-remote/tests/golden/step-up.json`, copied here as
/// `Fixtures/step-up.json`; a Rust test keeps the copy identical).
final class StepUpTests: XCTestCase {
    func golden() throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "step-up", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONValue.parse(Data(contentsOf: url))
    }

    // MARK: The golden

    func testEveryGoldenCaseIsDecidedAsTheComputerDecidesIt() throws {
        let cases = try XCTUnwrap(try golden()["cases"]?.array)
        XCTAssertEqual(cases.count, 24)
        for c in cases {
            let name = c.str("name") ?? "?"
            let issued = try XCTUnwrap(c["issued"]?.array).compactMap(StepUpIssued.from)
            let out = StepUpVerifier.check(state: try XCTUnwrap(c["state"]), issued: issued, now: try XCTUnwrap(c.long("now")),
                                           stepUp: c["stepUp"])
            let want = try XCTUnwrap(c["expect"])
            XCTAssertEqual(out.result, want.str("result"), name)
            XCTAssertEqual(out.method, want.str("method"), name)
            XCTAssertEqual(out.uv, want["uv"]?.bool, name)
            XCTAssertEqual(out.cloned, want.str("cloned"), name)
            XCTAssertEqual(out.state, want["state"], "\(name): security.json as the computer would save it")
            XCTAssertEqual(out.issued, try XCTUnwrap(want["issued"]?.array).compactMap(StepUpIssued.from), "\(name): the challenge book")
        }
    }

    func testTheGoldenAssertionsRoundTripThroughThePhonesPayload() throws {
        for c in try XCTUnwrap(try golden()["cases"]?.array) {
            guard let raw = c["stepUp"], raw.str("signature") != nil, let a = StepUpAssertion.from(raw) else { continue }
            // What the phone sends is byte for byte what the fixture holds.
            XCTAssertEqual(StepUpProof.assertion(a).json, raw, c.str("name") ?? "?")
        }
        let first = try XCTUnwrap(try golden()["cases"]?.array?.first)
        let a = try XCTUnwrap(StepUpAssertion.from(first["stepUp"]))
        XCTAssertEqual(a.challenge, "BwcHBwcHBwcHBwcHBwcHBwcH", "the challenge the key signed over")
    }

    func testTotpVectorsAndRecoveryCodesMatch() throws {
        let g = try golden()
        for v in try XCTUnwrap(g["totpVectors"]?.array) {
            let secret = try XCTUnwrap(StepUp.base32Decode(try XCTUnwrap(v.str("secret"))))
            XCTAssertEqual(StepUp.totp(secret: secret, step: try XCTUnwrap(v.long("step"))), v.str("code"))
        }
        let codes = try XCTUnwrap(g["recovery"]?["codes"]?.array).compactMap(\.string)
        let hashes = try XCTUnwrap(g["recovery"]?["hashes"]?.array).compactMap(\.string)
        XCTAssertEqual(codes.count, 10)
        XCTAssertEqual(codes.map(StepUpVerifier.hashRecoveryCode), hashes)
        XCTAssertEqual(StepUpVerifier.hashRecoveryCode(codes[0].uppercased().replacingOccurrences(of: "-", with: " ")), hashes[0])
    }

    // MARK: Encodings

    func testBase64urlAndDerMatchTheComputer() throws {
        XCTAssertEqual(StepUp.toB64url(Data([0xfb, 0xff, 0xbf])), "-_-_")
        XCTAssertEqual(StepUp.fromB64url("-_-_"), Data([0xfb, 0xff, 0xbf]))
        XCTAssertEqual(StepUp.fromB64url("+/+/"), Data([0xfb, 0xff, 0xbf]), "plain base64 too")
        XCTAssertEqual(StepUp.fromB64url("AQ=="), Data([1]))
        XCTAssertEqual(StepUp.fromB64url("AQ"), Data([1]))
        XCTAssertNil(StepUp.fromB64url("A"), "one char over a multiple of four")
        XCTAssertNil(StepUp.fromB64url("AQ==="))
        XCTAssertNil(StepUp.fromB64url("A Q"))
        let key = P256.Signing.PrivateKey()
        for _ in 0..<20 {
            let sig = try key.signature(for: Data("x".utf8))
            XCTAssertEqual(StepUp.derToRaw(sig.derRepresentation), sig.rawRepresentation)
            XCTAssertEqual(StepUp.rawToDer(sig.rawRepresentation), sig.derRepresentation)
        }
        XCTAssertNil(StepUp.derToRaw(Data([0x30, 0x02, 0x02, 0x00])))
        XCTAssertNil(StepUp.derToRaw(Data()))
    }

    func testCodesAreSixDigits() {
        XCTAssertEqual(StepUpProof.code("123 456"), .totp("123456"))
        XCTAssertEqual(StepUpProof.code("123-456"), .totp("123456"))
        XCTAssertNil(StepUpProof.code("12345"))
        XCTAssertNil(StepUpProof.code("1234567"))
        XCTAssertNil(StepUpProof.code("12a456"))
        XCTAssertNil(StepUpProof.code("١٢٣٤٥٦"), "ASCII digits only, as the computer reads them")
        XCTAssertEqual(StepUpProof.totp("123456").json, ["totp": "123456"])
    }

    // MARK: The challenge

    func testTheChallengeReplyIsReadNarrowly() throws {
        let c = try XCTUnwrap(StepUpChallenge.from([
            "challenge": "BwcHBwcHBwcHBwcHBwcHBwcH", "expiresAt": 1_790_000_120_000, "required": true,
            "methods": ["totp", "security-key", "fingerprint"], "rpId": "nekko-computer:abc",
        ]))
        XCTAssertEqual(c.methods, [.securityKey, .totp], "sorted; unknown kinds dropped")
        XCTAssertEqual(c.rpId, "nekko-computer:abc")
        XCTAssertEqual(c.bytes, Data(repeating: 7, count: 18))
        XCTAssertTrue(c.required)
        XCTAssertTrue(c.acceptsFido2)
        XCTAssertTrue(c.acceptsTotp)
        XCTAssertNil(c.registration, "no computer offers registration from a phone yet")

        // A computer that doesn't name its relying party: only a code can answer.
        let old = try XCTUnwrap(StepUpChallenge.from(["challenge": "AAAA", "required": true, "methods": ["passkey", "totp"]]))
        XCTAssertFalse(old.acceptsFido2)
        XCTAssertTrue(old.acceptsTotp)
        XCTAssertNil(StepUpChallenge.from(["required": true]))
        XCTAssertNil(StepUpChallenge.from(["challenge": "not base64!"]))

        let offer = try XCTUnwrap(StepUpChallenge.from([
            "challenge": "AAAA", "required": false, "methods": [],
            "register": ["channel": "security:phoneRegister", "rpId": "nekko-computer:abc", "challenge": "BBBB", "userId": "AQID", "userName": "Studio"],
        ])?.registration)
        XCTAssertEqual(offer, StepUpRegistrationOffer(channel: "security:phoneRegister", rpId: "nekko-computer:abc", challenge: "BBBB",
                                                      userId: "AQID", userName: "Studio"))
    }

    func testTheRelyingPartyIsPerComputer() {
        XCTAssertEqual(StepUp.rpId(installId: "abc"), "nekko-computer:abc")
    }

    // MARK: A software authenticator, end to end against the verifier

    func state(_ keys: [SoftwareStepUpAuthenticator], totp: String? = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") -> JSONValue {
        ["version": 1, "enabled": true, "rpId": "nekko-computer:test", "origins": ["ios:dev.nekkolabs.nekkoagent"],
         "credentials": .array(keys.map { $0.credential() }),
         "totp": totp.map { s -> JSONValue in ["secret": .string(s), "addedAt": 1] } ?? .null, "recoveryHashes": []]
    }

    func testWhatThePhoneSendsTheComputerAccepts() throws {
        let key = SoftwareStepUpAuthenticator(rpId: "nekko-computer:test", origin: "ios:dev.nekkolabs.nekkoagent")
        let now: Int64 = 1_790_000_000_000
        let challenge = StepUp.toB64url(Data(repeating: 9, count: 18))
        var book = [StepUpIssued(challenge: challenge, issuedAt: now - 1_000)]
        let a = try key.assert(challenge: challenge)
        let ok = StepUpVerifier.check(state: state([key]), issued: book, now: now, stepUp: StepUpProof.assertion(a).json)
        XCTAssertTrue(ok.ok, ok.why ?? "")
        XCTAssertEqual(ok.uv, true)
        book = ok.issued
        // The same answer again is a replay; another computer's relying party is refused.
        XCTAssertEqual(StepUpVerifier.check(state: ok.state, issued: book, now: now, stepUp: StepUpProof.assertion(a).json).result,
                       StepUpCode.replayed.rawValue)
        let other = SoftwareStepUpAuthenticator(rpId: "nekko-computer:other", origin: "ios:dev.nekkolabs.nekkoagent", key: key.key)
        let fresh = StepUp.toB64url(Data(repeating: 8, count: 18))
        let out = StepUpVerifier.check(state: ok.state, issued: [StepUpIssued(challenge: fresh, issuedAt: now)], now: now,
                                       stepUp: StepUpProof.assertion(try other.assert(challenge: fresh)).json)
        XCTAssertEqual(out.why, "rpId")
        // A code for now.
        let secret = try XCTUnwrap(StepUp.base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"))
        let code = StepUp.totp(secret: secret, step: StepUp.totpStep(nowMs: now))
        XCTAssertTrue(StepUpVerifier.check(state: state([key]), issued: [], now: now, stepUp: StepUpProof.totp(code).json).ok)
    }

    // MARK: Registration

    /// A minimal CBOR writer for the tests' attestation objects.
    func cbor(_ v: CBORValue) -> [UInt8] {
        func head(_ major: UInt8, _ n: UInt64) -> [UInt8] {
            switch n {
            case 0..<24: return [major << 5 | UInt8(n)]
            case 24..<256: return [major << 5 | 24, UInt8(n)]
            default: return [major << 5 | 25, UInt8(n >> 8), UInt8(n & 0xff)]
            }
        }
        switch v {
        case .int(let i): return i >= 0 ? head(0, UInt64(i)) : head(1, UInt64(-1 - i))
        case .bytes(let b): return head(2, UInt64(b.count)) + b
        case .text(let t): return head(3, UInt64(t.utf8.count)) + Array(t.utf8)
        case .array(let a): return head(4, UInt64(a.count)) + a.flatMap(cbor)
        case .map(let m): return head(5, UInt64(m.count)) + m.flatMap { cbor($0.0) + cbor($0.1) }
        case .simple(let s): return [7 << 5 | s]
        }
    }

    func attestation(key: P256.Signing.PublicKey, id: [UInt8], rpId: String, alg: Int64 = -7) -> Data {
        let raw = [UInt8](key.x963Representation)
        let cose: CBORValue = .map([(.int(1), .int(2)), (.int(3), .int(alg)), (.int(-1), .int(1)),
                                    (.int(-2), .bytes(Array(raw[1..<33]))), (.int(-3), .bytes(Array(raw[33..<65])))])
        var auth = [UInt8](Data(SHA256.hash(data: Data(rpId.utf8))))
        auth.append(0x45) // UP, UV, AT
        auth += [0, 0, 0, 0]
        auth += [UInt8](repeating: 0, count: 16)
        auth += [UInt8(id.count >> 8), UInt8(id.count & 0xff)] + id
        auth += cbor(cose)
        return Data(cbor(.map([(.text("fmt"), .text("none")), (.text("attStmt"), .map([])), (.text("authData"), .bytes(auth))])))
    }

    func testARegistrationReadsTheKeyOutOfTheAttestation() throws {
        let key = P256.Signing.PrivateKey()
        let id: [UInt8] = Array(repeating: 5, count: 32)
        let att = attestation(key: key.publicKey, id: id, rpId: "nekko-computer:test")
        let parsed = try XCTUnwrap(StepUpAttestation.parse(att))
        XCTAssertEqual(parsed.publicKey, key.publicKey.x963Representation)
        XCTAssertEqual(parsed.credentialId, Data(id))
        XCTAssertEqual(parsed.rpIdHash, Data(SHA256.hash(data: Data("nekko-computer:test".utf8))))
        let cdj = Data(#"{"type":"webauthn.create","challenge":"BBBB","origin":"ios:dev.nekkolabs.nekkoagent"}"#.utf8)
        let reg = try XCTUnwrap(StepUpRegistration.from(kind: .securityKey, name: "YubiKey", credentialId: Data(id), clientDataJSON: cdj,
                                                        attestationObject: att))
        XCTAssertEqual(reg.json.str("publicKey"), key.publicKey.x963Representation.base64EncodedString(), "as security.json keeps it")
        XCTAssertEqual(reg.json.str("credentialId"), StepUp.toB64url(Data(id)))
        XCTAssertEqual(reg.json.str("kind"), "security-key")
        // Another credential's id, an RS256 key, or a truncated object: refused.
        XCTAssertNil(StepUpRegistration.from(kind: .passkey, name: "x", credentialId: Data([1]), clientDataJSON: cdj, attestationObject: att))
        XCTAssertNil(StepUpAttestation.parse(attestation(key: key.publicKey, id: id, rpId: "r", alg: -257)))
        XCTAssertNil(StepUpAttestation.parse(att.dropLast(3)))
        XCTAssertNil(StepUpAttestation.parse(Data([0xbf, 0xff])), "indefinite lengths aren't CTAP2")
    }

    // MARK: Words

    func testRefusalsAndNotesReadPlainly() {
        func msg(_ code: String) -> String? { PhoneRefusal("Not allowed from a paired phone (\(code)): session:setOptions")?.message(computer: "Studio") }
        XCTAssertEqual(msg("step-up-required"), "Confirm with your security key or a code to do this on Studio.")
        XCTAssertEqual(msg("step-up-invalid"), "Studio didn’t accept that key or code. Try again.")
        XCTAssertEqual(msg("step-up-stale"), "That confirmation took too long. Try again.")
        XCTAssertEqual(msg("step-up-replayed"), "That confirmation was already used. Try again.")
        XCTAssertEqual(PhoneRefusal("Not allowed from a paired phone (quit-disabled): app:quit")?.message(computer: "Studio"),
                       "Quitting from a phone is turned off on Studio. Turn it on there in Settings → Remote access.")
        XCTAssertTrue(StepUp.isStepUpCode("step-up-stale"))
        XCTAssertFalse(StepUp.isStepUpCode("proof-stale"))
        XCTAssertFalse(StepUp.isStepUpCode(nil))
        XCTAssertEqual(StepUp.watchRefusal, "Confirm on your phone.")
        XCTAssertEqual(StepUp.untestedHardwareNote,
                       "The Devs don’t have a hardware security key to test this one, so we tried our best without one! If you see any issues, please let us know 🙏")
        XCTAssertEqual(StepUp.issuesURL.absoluteString, "https://github.com/nekko-labs/nekko-agent/issues/new")
    }

    func testTheGuardedAndUnguardedChannelsAreTheComputersLists() {
        XCTAssertEqual(StepUp.guardedChannels, ["session:setOptions", "settings:update"])
        XCTAssertEqual(StepUp.neverGuarded, ["app:quit", "device:signOut", "remote:stop"])
        XCTAssertTrue(StepUp.neverGuarded.isSubset(of: Set(Channels.all)))
        XCTAssertTrue(Channels.all.contains(StepUp.challengeChannel))
    }
}

import Foundation
import XCTest
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import NekkoProtocol

/// The Change proof against the vector the computer's Rust gate is tested
/// with (`crates/nekko-remote/tests/golden/change-proof.json`, copied here).
final class ChangeProofTests: XCTestCase {
    func vector() throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "change-proof", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONValue.parse(Data(contentsOf: url))
    }

    func testTheCanonicalJsonMatchesTheComputer() throws {
        let v = try vector()
        XCTAssertEqual(try ChangeProof.canonicalJSON(try XCTUnwrap(v["args"])), v.str("canonical"))
        for c in try XCTUnwrap(v["canonicalCases"]?.array) {
            XCTAssertEqual(try ChangeProof.canonicalJSON(try XCTUnwrap(c["value"])), c.str("canonical"), c.serialized())
        }
        for bad in try XCTUnwrap(v["unsignable"]?.array) {
            XCTAssertThrowsError(try ChangeProof.canonicalJSON(bad), bad.serialized())
        }
        XCTAssertEqual(try ChangeProof.canonicalJSON([.double(3), .double(-0.0)]), "[3,0]")
    }

    func testThePayloadAndSignatureMatchTheComputer() throws {
        let v = try vector()
        let args = try XCTUnwrap(v["args"]?.array)
        let ts = try XCTUnwrap(v.long("ts"))
        let text = try ChangeProof.payload(deviceId: try XCTUnwrap(v.str("deviceId")), channel: try XCTUnwrap(v.str("channel")),
                                           args: args, ts: ts)
        XCTAssertEqual(text, v.str("payload"))
        let key = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(v.str("publicKey"))))
        let sig = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(v.str("sig"))))
        XCTAssertTrue(ChangeProof.verify(publicKey: key, text: text, sig: sig))
        XCTAssertFalse(ChangeProof.verify(publicKey: key, text: text + "x", sig: sig))
        let other = try ChangeProof.payload(deviceId: "phone-1", channel: "file:read", args: args, ts: ts)
        XCTAssertFalse(ChangeProof.verify(publicKey: key, text: other, sig: sig))
    }

    func testASoftwareSignerSignsWhatTheComputerVerifies() async throws {
        let v = try vector()
        let secret = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(v.str("privateKey"))))
        let signer = try SoftwareChangeSigner(rawRepresentation: secret)
        XCTAssertEqual(try signer.publicKey().base64EncodedString(), v.str("publicKey"))
        let args = try XCTUnwrap(v["args"]?.array)
        let proof = try await ChangeProof.proof(signer: signer, deviceId: "phone-1", channel: "file:write", args: args,
                                                ts: try XCTUnwrap(v.long("ts")))
        XCTAssertEqual(proof.long("ts"), v.long("ts"))
        let sig = try XCTUnwrap(proof.str("sig").flatMap { Data(base64Encoded: $0) })
        XCTAssertEqual(sig.count, 64, "raw r||s, as the computer reads it")
        XCTAssertTrue(ChangeProof.verify(publicKey: try signer.publicKey(), text: try XCTUnwrap(v.str("payload")), sig: sig))
    }
}

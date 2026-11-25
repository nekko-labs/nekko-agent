import Foundation
import XCTest
@testable import NekkoProtocol

/// Compressed records (decision 0121). Deflate output differs between Apple's Compression
/// framework and flate2, so `Fixtures/sync-compressed.json` holds blobs each side made and each
/// side opens both. `UPDATE_SWIFT_VECTORS=1` rewrites the `swift` list (and the Rust copy).
final class SyncCompressionTests: XCTestCase {
    static let account = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
    let oid = "pyzooEigcFKdbQmZUiNdKBruOHQo_z4mLG9HTzS6SR4"

    func fixture() throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "sync-compressed", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONValue.parse(Data(contentsOf: url))
    }

    func keyring(_ v: JSONValue) throws -> SyncCrypto.Keyring {
        try SyncCrypto.Keyring(bytes: SyncCrypto.fromBase64url(try XCTUnwrap(v.str("keyring"))))
    }

    func open(_ kr: SyncCrypto.Keyring, _ r: JSONValue) throws -> String {
        let plain = try SyncCrypto.openRecord(keyring: kr, account: Self.account, keyId: UInt32(try XCTUnwrap(r.long("keyId"))),
                                              collection: try XCTUnwrap(r.str("collection")), objectId: try XCTUnwrap(r.str("objectId")),
                                              revision: UInt64(try XCTUnwrap(r.long("revision"))), blob: try XCTUnwrap(r.str("blob")))
        return String(decoding: plain, as: UTF8.self)
    }

    func version(_ blob: String) throws -> UInt8 { try XCTUnwrap(SyncCrypto.fromBase64url(blob).first) }

    func kr() -> SyncCrypto.Keyring { try! SyncCrypto.Keyring(bytes: Data(repeating: 3, count: 64)) }

    func chatLike(_ n: Int) -> Data {
        var s = #"{"v":1,"chat":{"id":"s_1","messages":["#
        var i = 0
        while s.utf8.count < n {
            s += #"{"role":"tool","name":"bash","content":"line \#(i): error[E0308]: mismatched types in src/lib.rs"},"#
            i += 1
        }
        return Data((s + "{}]}}").utf8)
    }

    #if canImport(Compression)
    func testRustCompressedRecordsOpen() throws {
        let v = try fixture()
        let k = try keyring(v)
        let rust = try XCTUnwrap(v["rust"]?.array)
        XCTAssertFalse(rust.isEmpty)
        for r in rust {
            XCTAssertEqual(try version(try XCTUnwrap(r.str("blob"))), 2)
            XCTAssertEqual(try open(k, r), r.str("plaintext"))
        }
    }

    func testSwiftCompressedRecordsOpenAndAreWrittenWhenAsked() throws {
        var v = try fixture()
        let k = try keyring(v)
        let rust = try XCTUnwrap(v["rust"]?.array)
        if ProcessInfo.processInfo.environment["UPDATE_SWIFT_VECTORS"] != nil {
            var swift: [JSONValue] = []
            for (i, r) in rust.enumerated() {
                let rev = UInt64(10 + i)
                let blob = try SyncCrypto.sealRecordCompressed(keyring: k, account: Self.account, keyId: 1, collection: "chat",
                                                               objectId: try XCTUnwrap(r.str("objectId")), revision: rev,
                                                               plaintext: Data(try XCTUnwrap(r.str("plaintext")).utf8))
                swift.append(.object(["collection": .string("chat"), "objectId": .string(try XCTUnwrap(r.str("objectId"))),
                                      "revision": .int(Int64(rev)), "keyId": .int(1), "plaintext": r["plaintext"] ?? .null,
                                      "blob": .string(blob)]))
            }
            let text = try Self.render(account: try XCTUnwrap(v.str("account")), keyring: try XCTUnwrap(v.str("keyring")), rust: rust, swift: swift)
            let here = URL(fileURLWithPath: #filePath)
            let ios = here.deletingLastPathComponent().appendingPathComponent("Fixtures/sync-compressed.json")
            let rustCopy = here.deletingLastPathComponent().appendingPathComponent("../../../../../crates/nekko-sync/tests/golden/sync-compressed.json").standardized
            try text.write(to: ios, atomically: true, encoding: .utf8)
            try text.write(to: rustCopy, atomically: true, encoding: .utf8)
            v = try JSONValue.parse(Data(text.utf8))
        }
        let swift = try XCTUnwrap(v["swift"]?.array)
        XCTAssertEqual(swift.count, rust.count, "run with UPDATE_SWIFT_VECTORS=1 to make the iPhone's records")
        for r in swift {
            XCTAssertEqual(try version(try XCTUnwrap(r.str("blob"))), 2)
            XCTAssertEqual(try open(k, r), r.str("plaintext"))
        }
    }

    static func quote(_ s: String) throws -> String {
        let d = try JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        return String(decoding: d, as: UTF8.self)
    }

    static func render(account: String, keyring: String, rust: [JSONValue], swift: [JSONValue]) throws -> String {
        func list(_ rs: [JSONValue]) throws -> String {
            try rs.map { r in
                let f: [(String, String)] = try [("collection", quote(r.str("collection") ?? "")), ("objectId", quote(r.str("objectId") ?? "")),
                                                 ("revision", "\(r.long("revision") ?? 0)"), ("keyId", "\(r.long("keyId") ?? 0)"),
                                                 ("plaintext", quote(r.str("plaintext") ?? "")), ("blob", quote(r.str("blob") ?? ""))]
                return "    {\n" + f.map { "      \"\($0.0)\": \($0.1)" }.joined(separator: ",\n") + "\n    }"
            }.joined(separator: ",\n")
        }
        return "{\n  \"account\": \(try quote(account)),\n  \"keyring\": \(try quote(keyring)),\n  \"rust\": [\n\(try list(rust))\n  ],\n  \"swift\": [\n\(try list(swift))\n  ]\n}\n"
    }

    func testRoundTripSmallerAndVersionTwo() throws {
        let plain = chatLike(200_000)
        let v1 = try SyncCrypto.sealRecord(keyring: kr(), account: "acct", keyId: 1, collection: "chat", objectId: oid, revision: 1, plaintext: plain)
        let v2 = try SyncCrypto.sealRecordCompressed(keyring: kr(), account: "acct", keyId: 1, collection: "chat", objectId: oid, revision: 1, plaintext: plain)
        XCTAssertEqual(try version(v1), 1)
        XCTAssertEqual(try version(v2), 2)
        XCTAssertLessThan(v2.count * 5, v1.count)
        for blob in [v1, v2] {
            XCTAssertEqual(try SyncCrypto.openRecord(keyring: kr(), account: "acct", keyId: 1, collection: "chat", objectId: oid, revision: 1, blob: blob), plain)
        }
    }

    func testSmallAndIncompressibleStayVersionOne() throws {
        let small = try SyncCrypto.sealRecordCompressed(keyring: kr(), account: "a", keyId: 1, collection: "chat", objectId: oid, revision: 1,
                                                        plaintext: Data("{\"v\":1}".utf8))
        XCTAssertEqual(try version(small), 1)
        let noise = E2E.randomBytes(20_000)
        let blob = try SyncCrypto.sealRecordCompressed(keyring: kr(), account: "a", keyId: 1, collection: "chat", objectId: oid, revision: 1, plaintext: noise)
        XCTAssertEqual(try version(blob), 1)
    }

    func testTheVersionByteCannotBeFlipped() throws {
        let plain = chatLike(20_000)
        let v2 = try SyncCrypto.sealRecordCompressed(keyring: kr(), account: "a", keyId: 1, collection: "chat", objectId: oid, revision: 1, plaintext: plain)
        let v1 = try SyncCrypto.sealRecord(keyring: kr(), account: "a", keyId: 1, collection: "chat", objectId: oid, revision: 1, plaintext: plain)
        func flip(_ blob: String, _ to: UInt8) throws -> String {
            var raw = try SyncCrypto.fromBase64url(blob)
            raw[0] = to
            return SyncCrypto.base64url(raw)
        }
        func open(_ b: String, rev: UInt64 = 1) throws -> Data {
            try SyncCrypto.openRecord(keyring: kr(), account: "a", keyId: 1, collection: "chat", objectId: oid, revision: rev, blob: b)
        }
        XCTAssertThrowsError(try open(try flip(v2, 1))) { XCTAssertEqual($0 as? SyncCrypto.Failure, .unauthentic) }
        XCTAssertThrowsError(try open(try flip(v1, 2))) { XCTAssertEqual($0 as? SyncCrypto.Failure, .unauthentic) }
        XCTAssertThrowsError(try open(try flip(v2, 3))) { XCTAssertEqual($0 as? SyncCrypto.Failure, .malformed) }
        XCTAssertThrowsError(try open(v2, rev: 2))
    }

    func sealedDeflate(_ body: Data) throws -> String {
        let aad = SyncCrypto.recordAAD(account: "a", keyId: 1, collection: "chat", objectId: oid, revision: 1) + SyncCrypto.deflateAAD
        return try SyncCrypto.sealBlob(keyring: kr(), aad: aad, body: body, salt: nil, version: SyncCrypto.blobVersionDeflate)
    }

    func openA(_ blob: String) throws -> Data {
        try SyncCrypto.openRecord(keyring: kr(), account: "a", keyId: 1, collection: "chat", objectId: oid, revision: 1, blob: blob)
    }

    func testBombsAreRefusedAtTheCapAndTheCapIsAllowed() throws {
        let cap = SyncCrypto.maxPlaintext
        XCTAssertEqual(try openA(try sealedDeflate(try XCTUnwrap(Deflate.compress(Data(repeating: 0x61, count: cap))))).count, cap)
        for n in [cap + 1, 40_000_000] {
            let blob = try sealedDeflate(try XCTUnwrap(Deflate.compress(Data(repeating: 0x61, count: n))))
            XCTAssertThrowsError(try openA(blob)) { XCTAssertEqual($0 as? SyncCrypto.Failure, .malformed) }
        }
    }

    func testTruncatedAndGarbageStreamsAreRefused() throws {
        let full = try XCTUnwrap(Deflate.compress(chatLike(50_000)))
        for body in [full.prefix(full.count / 2), Data(repeating: 0xff, count: 300)] {
            XCTAssertThrowsError(try openA(try sealedDeflate(Data(body))))
        }
        XCTAssertThrowsError(try openA(try sealedDeflate(Data())))
    }
    #endif
}

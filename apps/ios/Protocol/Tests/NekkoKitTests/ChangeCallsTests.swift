import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// A computer that checks Change proofs the way the daemon's gate does
/// (crates/nekko-remote/src/phone.rs): trust on first use for the key, the
/// device's Change switch, a fresh, valid, unused proof.
final class ProofComputer: RemoteConnection, ProofCaller, @unchecked Sendable {
    let lock = NSLock()
    var key: Data?
    var changeOn = true
    var seen: Set<String> = []
    var now: Int64 = 1_760_000_000_000
    var calls: [(String, [JSONValue], JSONValue?)] = []
    let deviceId: String

    init(deviceId: String = "phone-1") { self.deviceId = deviceId }

    private func refuse(_ code: String, _ channel: String) -> RelayError {
        RelayError("Not allowed from a paired phone (\(code)): \(channel)", fromComputer: true)
    }

    private func check(_ channel: String, _ args: [JSONValue], _ proof: JSONValue?, key: Data) throws {
        guard let proof else { throw refuse("proof-required", channel) }
        guard let ts = proof.long("ts"), let sig = proof.str("sig").flatMap({ Data(base64Encoded: $0) }) else {
            throw refuse("proof-invalid", channel)
        }
        if ts < now - 300_000 || ts > now + 60_000 { throw refuse("proof-stale", channel) }
        let text = try ChangeProof.payload(deviceId: deviceId, channel: channel, args: args, ts: ts)
        guard ChangeProof.verify(publicKey: key, text: text, sig: sig) else { throw refuse("proof-invalid", channel) }
        guard seen.insert(text).inserted else { throw refuse("proof-replayed", channel) }
    }

    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        try lock.withLock { try answer(channel, args, proof) }
    }

    private func answer(_ channel: String, _ args: [JSONValue], _ proof: JSONValue?) throws -> JSONValue {
        calls.append((channel, args, proof))
        if channel == ChangeProof.keyChannel {
            guard let k = args.first?.string.flatMap({ Data(base64Encoded: $0) }) else { throw refuse("key-invalid", channel) }
            try check(channel, args, proof, key: k)
            if let key, key != k { throw refuse("key-mismatch", channel) }
            key = k
            return ["registered": true]
        }
        guard changeOn else { throw refuse("change-off", channel) }
        guard let key else { throw refuse("key-missing", channel) }
        try check(channel, args, proof, key: key)
        return ["ok": .string(channel)]
    }

    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        try await call(channel, args, proof: nil, timeout: timeout)
    }

    func channels() -> [String] { lock.lock(); defer { lock.unlock() }; return calls.map(\.0) }

    // The rest of a connection: unused here.
    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {}
    func connect() {}
    func close() {}
    func nudge() {}
    func reconnect() {}
    func registerPush(token: String) async throws {}
    func registerActivity(tag: String, token: String) async throws {}
}

final class ChangeCallsTests: XCTestCase {
    func calls(_ computer: ProofComputer, signer: ChangeSigner = SoftwareChangeSigner()) -> ChangeCalls {
        let now = computer.now
        return ChangeCalls(caller: computer, signer: signer, deviceId: "phone-1", computerName: "Studio", now: { now })
    }

    func testRegistersTheKeyOnceThenSignsEveryChange() async throws {
        let computer = ProofComputer()
        let signer = SoftwareChangeSigner()
        let c = calls(computer, signer: signer)
        let out = try await c.call(change: "file:write", ["s1", ["path": "a.txt", "text": "hi"]])
        XCTAssertEqual(out, ["ok": "file:write"])
        _ = try await c.call(change: "git:commit", ["s1", "message"])
        XCTAssertEqual(computer.channels(), ["device:registerKey", "file:write", "git:commit"])
        XCTAssertEqual(computer.key, try signer.publicKey())
        XCTAssertEqual(try signer.publicKey().count, 65)
        XCTAssertEqual(signer.signatures, 3, "the registration is signed too")
    }

    func testChangeOffSaysWhereToTurnItOn() async throws {
        let computer = ProofComputer()
        computer.changeOn = false
        do {
            _ = try await calls(computer).call(change: "file:write", ["s1"])
            XCTFail("refused")
        } catch let e as ChangeRefused {
            XCTAssertEqual(e.code, "change-off")
            XCTAssertEqual(e.message, "Changes from this phone are turned off on Studio. Turn them on in Remote access → What phones can do.")
        }
    }

    func testAnotherKeyOnTheComputerMeansPairAgain() async throws {
        let computer = ProofComputer()
        computer.key = try SoftwareChangeSigner().publicKey()
        do {
            _ = try await calls(computer).call(change: "file:write", ["s1"])
            XCTFail("refused")
        } catch let e as ChangeRefused {
            XCTAssertEqual(e.code, "key-mismatch")
            XCTAssertTrue(e.message.contains("pair it again"), e.message)
        }
        XCTAssertEqual(computer.channels(), ["device:registerKey"], "nothing changed")
    }

    func testAComputerThatForgotTheKeyGetsItAgain() async throws {
        let computer = ProofComputer()
        let c = calls(computer)
        _ = try await c.call(change: "file:write", ["s1"])
        computer.key = nil // paired again on the computer's side
        _ = try await c.call(change: "file:write", ["s2"])
        XCTAssertEqual(computer.channels(), ["device:registerKey", "file:write", "file:write", "device:registerKey", "file:write"])
    }

    func testAWrongClockIsNamed() async throws {
        let computer = ProofComputer()
        let signer = SoftwareChangeSigner()
        let c = ChangeCalls(caller: computer, signer: signer, deviceId: "phone-1", computerName: "Studio",
                            now: { 1_760_000_000_000 - 10 * 60_000 })
        do {
            _ = try await c.call(change: "file:write", ["s1"])
            XCTFail("refused")
        } catch let e as ChangeRefused {
            XCTAssertEqual(e.code, "proof-stale")
            XCTAssertTrue(e.message.contains("clock"), e.message)
        }
    }

    func testArgumentsThatCantBeSignedAreNotSent() async throws {
        let computer = ProofComputer()
        computer.key = nil
        let c = calls(computer)
        do {
            _ = try await c.call(change: "terminal:resize", ["t1", .double(80.5)])
            XCTFail("refused")
        } catch let e as ChangeRefused {
            XCTAssertNil(e.code)
        }
        XCTAssertFalse(computer.channels().contains("terminal:resize"))
    }

    func testEveryRefusalReadsPlainly() {
        func msg(_ code: String) -> String? { PhoneRefusal("Not allowed from a paired phone (\(code)): file:write")?.message(computer: "Studio") }
        XCTAssertEqual(msg("read-off"), "Reading from this phone is turned off on Studio. Turn it on in Remote access → What phones can do.")
        for code in ["proof-required", "proof-invalid", "proof-replayed"] {
            XCTAssertEqual(msg(code), "Studio couldn’t confirm it was you. Try again.")
        }
        XCTAssertEqual(msg("device-unknown"), "Studio doesn’t know this phone any more. Pair it again.")
        XCTAssertNotNil(msg("channel-denied"))
        XCTAssertNil(msg("value-invalid"), "the computer's own words")
        let r = PhoneRefusal("Not allowed from a paired phone (change-off): file:write")
        XCTAssertEqual(r?.code, "change-off")
        XCTAssertEqual(r?.detail, "file:write")
        XCTAssertNil(PhoneRefusal("disk full"))
    }
}

@MainActor
final class StoreChangeTests: XCTestCase {
    func testTheStoreSignsChangesOnTheActiveComputer() async throws {
        let computer = ProofComputer(deviceId: "id-1")
        let store = ComputersStore(store: MemoryStore(), makeConnection: { _ in computer }, deviceName: { "iPhone" },
                                   deriveKey: { _, _ in Data(repeating: 7, count: 32) }, newId: { "id-1" })
        store.load()
        _ = await store.pair(PairingLink(relayUrl: "ws://studio.tail1.ts.net:4400", room: "a1b2c3d4e5f60718",
                                         key: "00112233445566778899aabbccddeeff", pair: "ABCD2345"))
        do {
            _ = try await store.call(change: "file:write", ["s1"])
            XCTFail("no signer")
        } catch let e as ChangeRefused {
            XCTAssertTrue(e.message.contains("Face ID"), e.message)
        }
        store.changeSigner = SoftwareChangeSigner()
        computer.now = Int64(Date().timeIntervalSince1970 * 1000)
        _ = try await store.call(change: "file:write", ["s1"])
        _ = try await store.call(change: "file:write", ["s2"])
        let mine = computer.channels().filter { $0 == ChangeProof.keyChannel || $0.hasPrefix("file:") }
        XCTAssertEqual(mine, ["device:registerKey", "file:write", "file:write"], "registered once per connection")
    }
}

import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// A computer with step-up on, judging as the daemon's gate does
/// (crates/nekko-remote/src/phone.rs, SK-2): a mode raise needs a Change
/// proof, then a step-up answering a challenge it issued (checked by
/// `StepUpVerifier`, the golden-tested twin), and one accepted step-up
/// covers this phone for five minutes.
final class StepUpComputer: RemoteConnection, ProofCaller, @unchecked Sendable {
    static let rpId = "nekko-computer:test"
    static let origin = "ios:dev.nekkolabs.nekkoagent"
    static let totpSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

    let lock = NSLock()
    var security: JSONValue
    var issued: [StepUpIssued] = []
    var coveredAt: Int64?
    var now: Int64 = 1_790_000_000_000
    var namesRelyingParty = true
    /// Every raise as it arrived: (had a Change proof, the step-up it carried).
    var raises: [(proof: Bool, stepUp: JSONValue?)] = []
    var channels: [String] = []

    init(enabled: Bool = true, keys: [SoftwareStepUpAuthenticator]) {
        security = ["version": 1, "enabled": .bool(enabled), "rpId": .string(Self.rpId), "origins": [.string(Self.origin)],
                    "credentials": .array(keys.map { $0.credential() }),
                    "totp": ["secret": .string(Self.totpSecret), "addedAt": 1], "recoveryHashes": []]
    }

    private func refuse(_ code: String, _ channel: String) -> RelayError {
        RelayError("Not allowed from a paired phone (\(code)): \(channel)", fromComputer: true)
    }

    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, stepUp: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        try lock.withLock { try answer(channel, args, proof, stepUp) }
    }

    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        try await call(channel, args, proof: proof, stepUp: nil, timeout: timeout)
    }

    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        try await call(channel, args, proof: nil, stepUp: nil, timeout: timeout)
    }

    private func answer(_ channel: String, _ args: [JSONValue], _ proof: JSONValue?, _ stepUp: JSONValue?) throws -> JSONValue {
        channels.append(channel)
        switch channel {
        case ChangeProof.keyChannel:
            guard proof != nil else { throw refuse("proof-required", channel) }
            return ["registered": true]
        case Channels.securityChallenge:
            let c = StepUp.toB64url(Data((0..<18).map { _ in UInt8.random(in: 0...255) }))
            issued.append(StepUpIssued(challenge: c, issuedAt: now))
            var kinds = Set((security["credentials"]?.array ?? []).compactMap { $0.str("kind") })
            if security.isSet("totp") { kinds.insert("totp") }
            var reply: [String: JSONValue] = ["challenge": .string(c), "expiresAt": .int(now + StepUp.challengeTtlMs),
                                              "required": .bool(security.flag("enabled")), "methods": .array(kinds.sorted().map { JSONValue.string($0) })]
            if namesRelyingParty { reply["rpId"] = security["rpId"] }
            return .object(reply)
        case Channels.sessionSetOptions, Channels.settingsUpdate:
            let settings = channel == Channels.settingsUpdate
            let patch = settings ? args.first : args.dropFirst().first
            guard patch?.str(settings ? "defaultChatMode" : "mode") == "yolo" else { return ["ok": true] }
            raises.append((proof != nil, stepUp))
            guard proof != nil else { throw refuse("proof-required", channel) }
            guard security.flag("enabled") else { return ["ok": true] }
            guard let stepUp else {
                if let at = coveredAt, now - at < StepUp.coverMs { return ["ok": true] }
                throw refuse(StepUpCode.required.rawValue, channel)
            }
            let out = StepUpVerifier.check(state: security, issued: issued, now: now, stepUp: stepUp)
            security = out.state
            issued = out.issued
            guard out.ok else { throw refuse(out.result, channel) }
            coveredAt = now
            return ["ok": true]
        default:
            return .null
        }
    }

    func raisesWithStepUp() -> [Bool] { lock.withLock { raises.map { $0.stepUp != nil } } }
    func code(at ms: Int64) -> String {
        StepUp.totp(secret: StepUp.base32Decode(Self.totpSecret)!, step: StepUp.totpStep(nowMs: ms))
    }

    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {}
    func connect() {}
    func close() {}
    func nudge() {}
    func reconnect() {}
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}
}

/// What the step-up sheet was asked, and what it answers.
@MainActor
final class SheetDouble {
    var asked: [StepUpRequest] = []
    var answers: [(StepUpRequest) -> StepUpProof?] = []

    var prompt: StepUpPrompt {
        { [unowned self] request in
            self.asked.append(request)
            guard !self.answers.isEmpty else { return nil }
            return self.answers.removeFirst()(request)
        }
    }
}

@MainActor
final class StepUpCallsTests: XCTestCase {
    let key = SoftwareStepUpAuthenticator(rpId: StepUpComputer.rpId, origin: StepUpComputer.origin)

    func paired(_ computer: StepUpComputer) async -> ComputersStore {
        let store = ComputersStore(store: MemoryStore(), makeConnection: { _ in computer }, deviceName: { "iPhone" },
                                   deriveKey: { _, _ in Data(repeating: 7, count: 32) }, newId: { "id-1" })
        store.load()
        _ = await store.pair(PairingLink(relayUrl: "ws://studio.tail1.ts.net:4400", room: "a1b2c3d4e5f60718",
                                         key: "00112233445566778899aabbccddeeff", pair: "ABCD2345"))
        store.changeSigner = SoftwareChangeSigner()
        return store
    }

    func touch() -> (StepUpRequest) -> StepUpProof? {
        let key = self.key
        return { r in try? StepUpProof.assertion(key.assert(challenge: r.challenge.challenge)) }
    }

    func testARaiseShowsTheSheetOnceAndTheComputerCoversFiveMinutes() async throws {
        let computer = StepUpComputer(keys: [key])
        let store = await paired(computer)
        let sheet = SheetDouble()
        sheet.answers = [touch()]
        store.stepUpPrompt = sheet.prompt

        _ = try await store.call(raising: Channels.sessionSetOptions, ["s1", ["mode": "yolo"]])
        // Plain, then signed (Face ID), then signed with the key's answer.
        XCTAssertEqual(computer.raisesWithStepUp(), [false, false, true])
        XCTAssertEqual(computer.raises.map { $0.proof }, [false, true, true])
        XCTAssertEqual(sheet.asked.count, 1)
        let asked = try XCTUnwrap(sheet.asked.first)
        XCTAssertEqual(asked.action, "Switch this chat to YOLO on My computer")
        XCTAssertEqual(asked.computer, "My computer")
        XCTAssertEqual(asked.challenge.rpId, StepUpComputer.rpId)
        XCTAssertEqual(asked.challenge.methods, [.securityKey, .totp])
        XCTAssertNil(asked.problem)

        // Inside the computer's five minutes: no sheet, and the phone sends no step-up of its own.
        computer.now += 60_000
        try await store.updatePcSettings(PcSettings.patch(mode: .yolo))
        XCTAssertEqual(sheet.asked.count, 1)
        XCTAssertEqual(computer.raisesWithStepUp().suffix(2), [false, false])

        // After them, the computer asks again.
        computer.now += StepUp.coverMs
        sheet.answers = [touch()]
        _ = try await store.call(raising: Channels.sessionSetOptions, ["s1", ["mode": "yolo"]])
        XCTAssertEqual(sheet.asked.count, 2)
        XCTAssertEqual(computer.raisesWithStepUp().last, true)
    }

    func testAWrongCodeShowsTheSheetAgainWithTheComputersWords() async throws {
        let computer = StepUpComputer(keys: [key])
        let store = await paired(computer)
        let sheet = SheetDouble()
        let now = computer.now
        sheet.answers = [{ _ in .totp("000000") }, { _ in .totp(computer.code(at: now)) }]
        store.stepUpPrompt = sheet.prompt

        _ = try await store.call(raising: Channels.settingsUpdate, [["defaultChatMode": "yolo"]])
        XCTAssertEqual(sheet.asked.count, 2)
        XCTAssertEqual(sheet.asked[0].action, "Make YOLO the default for new chats on My computer")
        XCTAssertEqual(sheet.asked[1].attempt, 2)
        XCTAssertEqual(sheet.asked[1].problem, "My computer didn’t accept that key or code. Try again.")
        XCTAssertNotEqual(sheet.asked[0].challenge.challenge, sheet.asked[1].challenge.challenge, "a fresh challenge each time")
        XCTAssertEqual(computer.security["totp"]?.long("lastStep"), StepUp.totpStep(nowMs: now))
    }

    func testCancelChangesNothing() async throws {
        let computer = StepUpComputer(keys: [key])
        let store = await paired(computer)
        let sheet = SheetDouble()
        store.stepUpPrompt = sheet.prompt // answers nothing: Cancel
        do {
            _ = try await store.call(raising: Channels.sessionSetOptions, ["s1", ["mode": "yolo"]])
            XCTFail("cancelled")
        } catch let e as ChangeRefused {
            XCTAssertEqual(e.code, "step-up-cancelled")
            XCTAssertEqual(e.message, "Not confirmed, so nothing changed on My computer.")
        }
        XCTAssertEqual(computer.raisesWithStepUp(), [false, false], "nothing sent after Cancel")
    }

    func testGivesUpAfterTheLastAttemptWithTheComputersReason() async throws {
        let computer = StepUpComputer(keys: [key])
        let store = await paired(computer)
        let sheet = SheetDouble()
        let wrong: (StepUpRequest) -> StepUpProof? = { _ in .totp("000000") }
        sheet.answers = Array(repeating: wrong, count: StepUp.maxAttempts + 1)
        store.stepUpPrompt = sheet.prompt
        do {
            _ = try await store.call(raising: Channels.sessionSetOptions, ["s1", ["mode": "yolo"]])
            XCTFail("refused")
        } catch let e as ChangeRefused {
            XCTAssertEqual(e.code, StepUpCode.invalid.rawValue)
        }
        XCTAssertEqual(sheet.asked.count, StepUp.maxAttempts)
    }

    func testWithoutASheetOrWithStepUpOffTheRaiseSaysWhyOrJustRuns() async throws {
        let computer = StepUpComputer(keys: [key])
        let store = await paired(computer)
        do {
            _ = try await store.call(raising: Channels.sessionSetOptions, ["s1", ["mode": "yolo"]])
            XCTFail("no sheet")
        } catch let e as ChangeRefused {
            XCTAssertEqual(e.code, StepUpCode.required.rawValue)
            XCTAssertTrue(e.message.contains("can’t ask for one"), e.message)
        }

        let off = StepUpComputer(enabled: false, keys: [key])
        let plain = await paired(off)
        let sheet = SheetDouble()
        plain.stepUpPrompt = sheet.prompt
        _ = try await plain.call(raising: Channels.sessionSetOptions, ["s1", ["mode": "yolo"]])
        XCTAssertTrue(sheet.asked.isEmpty)
        XCTAssertEqual(off.raisesWithStepUp(), [false, false])
    }

    func testAComputerThatDoesntNameItsRelyingPartyIsAnsweredWithACode() async throws {
        let computer = StepUpComputer(keys: [key])
        computer.namesRelyingParty = false
        let store = await paired(computer)
        let sheet = SheetDouble()
        let now = computer.now
        sheet.answers = [{ r in r.challenge.acceptsFido2 ? nil : .totp(computer.code(at: now)) }]
        store.stepUpPrompt = sheet.prompt
        _ = try await store.call(raising: Channels.sessionSetOptions, ["s1", ["mode": "yolo"]])
        XCTAssertFalse(try XCTUnwrap(sheet.asked.first).challenge.acceptsFido2)
    }

    func testTheStatusSaysOnlyKinds() async throws {
        let computer = StepUpComputer(keys: [key])
        let store = await paired(computer)
        let status = try await store.stepUpStatus()
        XCTAssertTrue(status.required)
        XCTAssertEqual(status.methods, [.securityKey, .totp])
        XCTAssertNil(status.registration)
    }

    func testActionNames() {
        XCTAssertEqual(StepUp.actionName(channel: Channels.sessionSetOptions, args: ["s1", ["mode": "guardrails"]], computer: "Studio") {
            $0 == "s1" ? "Refactor auth" : nil
        }, "Switch “Refactor auth” to Guardrails on Studio")
        XCTAssertEqual(StepUp.actionName(channel: Channels.settingsUpdate, args: [["defaultChatMode": "yolo"]], computer: "Studio"),
                       "Make YOLO the default for new chats on Studio")
        XCTAssertEqual(StepUp.actionName(channel: "security:phoneRegister", args: [], computer: "Studio"),
                       "Add a security key or passkey on Studio")
    }
}

/// The safety exits from the phone (SK-8): sign out (told now, or on the
/// next connection), stop remote access, quit when the computer allows it.
@MainActor
final class SafetyExitTests: XCTestCase {
    let link = PairingLink(relayUrl: "ws://studio.tail1.ts.net:4400", room: "a1b2c3d4e5f60718",
                           key: "00112233445566778899aabbccddeeff", pair: "ABCD2345")
    var connections: [FakeConnection] = []
    var secure = MemoryStore()
    var replies: [String: ([JSONValue]) throws -> JSONValue] = [:]
    /// Whether a new connection reaches the computer.
    var reachable = true

    func makeStore() -> ComputersStore {
        ComputersStore(
            store: secure,
            makeConnection: { cfg in
                let c = FakeConnection(config: cfg)
                c.replies = self.replies
                let up = self.reachable
                c.onConnect = { c in if up && self.connections.count > 1 { c.online() } }
                self.connections.append(c)
                return c
            },
            deviceName: { "Philip’s iPhone" },
            deriveKey: { _, _ in Data(repeating: 7, count: 32) },
            newId: { "id-1" },
            now: { 1_790_000_000_000 },
            summariesDebounce: 0.01)
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func online(_ s: ComputersStore) async -> String {
        s.load()
        let id = await s.pair(link)
        connections[0].online()
        await settle()
        return id
    }

    func testSigningOutTellsTheComputerAndForgetsIt() async throws {
        let s = makeStore()
        let id = await online(s)
        XCTAssertEqual(s.conn, .online)
        let heard = await s.signOut(id)
        XCTAssertTrue(heard)
        XCTAssertEqual(connections[0].callsTo(Channels.deviceSignOut).count, 1)
        XCTAssertTrue(s.computers.isEmpty)
        XCTAssertNil(secure.get(ComputersStore.secretKey(id)), "the pairing keys are gone")
        XCTAssertNil(secure.get("nekko.pendingSignOuts"), "nothing left to send")
        XCTAssertTrue(s.pendingSignOuts.isEmpty)
    }

    func testSigningOutAwayFromTheComputerSendsItOnTheNextConnection() async throws {
        let s = makeStore()
        let id = await online(s)
        connections[0].status(RelayStatus(.offline))
        await settle()
        let heard = await s.signOut(id)
        XCTAssertFalse(heard)
        XCTAssertTrue(s.computers.isEmpty, "forgotten here at once")
        XCTAssertNil(secure.get(ComputersStore.secretKey(id)))
        XCTAssertEqual(s.pendingSignOuts, ["My computer"])
        XCTAssertNotNil(secure.get("nekko.pendingSignOuts"))

        // Still away: kept.
        reachable = false
        await s.flushSignOuts(timeout: 0.05)
        XCTAssertEqual(s.pendingSignOuts, ["My computer"])

        // Back: one short connection, the sign-out, closed, and forgotten.
        reachable = true
        await s.flushSignOuts(timeout: 2)
        let last = try XCTUnwrap(connections.last)
        XCTAssertEqual(last.callsTo(Channels.deviceSignOut).count, 1)
        XCTAssertEqual(last.calls.map { $0.0 }, [Channels.deviceSignOut], "nothing else is read")
        XCTAssertNil(last.config.pairCode)
        XCTAssertEqual(last.config.room, link.room)
        XCTAssertTrue(last.closed)
        XCTAssertTrue(s.pendingSignOuts.isEmpty)
        XCTAssertNil(secure.get("nekko.pendingSignOuts"))
    }

    func testAPhoneTheComputerNeverWelcomedHasNothingToSend() async throws {
        let s = makeStore()
        s.load()
        let id = await s.pair(link) // never online: the pairing code was never used
        let heard = await s.signOut(id)
        XCTAssertFalse(heard)
        XCTAssertTrue(s.pendingSignOuts.isEmpty)
    }

    func testStoppingRemoteAccessIsSaidOnTheBannerUntilItsBack() async throws {
        replies[Channels.remoteStop] = { _ in ["stopped": true] }
        let s = makeStore()
        let id = await online(s)
        try await s.stopRemoteAccess()
        XCTAssertEqual(connections[0].callsTo(Channels.remoteStop).count, 1)
        XCTAssertEqual(s.safetyExit, SafetyExit(computerId: id, kind: .stoppedRemote, at: 1_790_000_000_000))
        connections[0].status(RelayStatus(.denied, denied: .kicked))
        await settle()
        XCTAssertNotNil(s.safetyExit, "kept while the computer is away")
        connections[0].online()
        await settle()
        XCTAssertNil(s.safetyExit, "remote access is back")
    }

    func testQuitIsOfferedOnlyWhenTheComputerAllowsItAndRefusalsReadPlainly() async throws {
        replies[Channels.appInfo] = { _ in ["version": "1.0", "platform": "darwin", "quitFromPhone": false] }
        replies[Channels.appQuit] = { _ in throw RelayError("Not allowed from a paired phone (quit-disabled): app:quit", fromComputer: true) }
        let s = makeStore()
        _ = await online(s)
        XCTAssertFalse(s.quitFromPhone)
        do {
            try await s.quitComputer()
            XCTFail("refused")
        } catch let e as ChangeRefused {
            XCTAssertEqual(e.code, "quit-disabled")
            XCTAssertEqual(e.message, "Quitting from a phone is turned off on Mac. Turn it on there in Settings → Remote access.")
        }
        XCTAssertNil(s.safetyExit)

        replies[Channels.appInfo] = { _ in ["version": "1.0", "platform": "darwin", "quitFromPhone": true] }
        replies[Channels.appQuit] = { _ in ["quitting": true] }
        connections[0].replies = replies
        await s.refresh()
        XCTAssertTrue(s.quitFromPhone)
        try await s.quitComputer()
        XCTAssertEqual(s.safetyExit?.kind, .quit)
        XCTAssertTrue(AppInfo.from(["quitFromPhone": true]).quitFromPhone)
        XCTAssertFalse(AppInfo.from(["version": "0.9"]).quitFromPhone, "older computers never offer it")
    }
}

import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// A computer as the terminal screens see it: tokens bound to a terminal,
/// handed out by opening (a Change action), and ending when told to.
@MainActor
final class FakeTerminals: TerminalBackend {
    var reads: [(String, [JSONValue])] = []
    var changes: [(String, [JSONValue])] = []
    var listeners: [UUID: (TerminalEvent) -> Void] = [:]
    var opened = 0
    var validToken: String?
    var refuseChange: Error?
    var hostsError: Error?
    let computerName = "Studio"

    func reply(_ id: String, token: String, buffer: String = "$ ", running: Bool = true) -> JSONValue {
        [
            "terminal": ["id": .string(id), "title": "zsh", "kind": "shell", "folder": "app", "shell": "zsh", "running": .bool(running), "viewers": 1],
            "buffer": .string(buffer), "cols": 80, "rows": 24, "truncated": false, "token": .string(token),
            "idleMs": 300_000, "maxMs": 1_800_000,
        ]
    }

    func read(_ channel: String, _ args: [JSONValue]) async throws -> JSONValue {
        reads.append((channel, args))
        switch channel {
        case TerminalChannels.list:
            return [["id": "term_1", "title": "zsh", "kind": "shell", "folder": "app", "shell": "zsh", "running": true, "viewers": 0],
                    ["id": "agent_s1", "title": "Agent commands", "kind": "agent", "folder": "", "shell": "agent", "running": false, "viewers": 0]]
        case TerminalChannels.sshHosts:
            if let hostsError { throw hostsError }
            return [["alias": "devbox", "hostName": "devbox.lan", "port": 22]]
        case TerminalChannels.tail:
            return ["terminal": ["id": args[0], "title": "Agent commands", "kind": "agent", "running": false, "viewers": 0],
                    "buffer": "$ npm test\r\nok\r\n", "cols": 40, "rows": 10, "truncated": false]
        case TerminalChannels.write, TerminalChannels.resize:
            let token = args.last?.string
            guard token != nil, token == validToken else {
                throw RelayError("Not allowed from a paired phone (token-expired): \(channel)", fromComputer: true)
            }
            return .null
        default:
            return .null
        }
    }

    func change(_ channel: String, _ args: [JSONValue]) async throws -> JSONValue {
        changes.append((channel, args))
        if let refuseChange { throw refuseChange }
        switch channel {
        case TerminalChannels.open, TerminalChannels.create, TerminalChannels.sshOpen:
            opened += 1
            let token = "tok\(opened)"
            validToken = token
            let id = channel == TerminalChannels.open ? (args[0].string ?? "") : (channel == TerminalChannels.create ? "term_9" : "term_ssh")
            return reply(id, token: token)
        default:
            return .null
        }
    }

    func subscribeTerminal(_ f: @escaping (TerminalEvent) -> Void) -> UUID {
        let id = UUID()
        listeners[id] = f
        return id
    }

    func unsubscribeTerminal(_ id: UUID) { listeners[id] = nil }

    func emit(_ e: TerminalEvent) { for f in listeners.values { f(e) } }

    func writes() -> [[JSONValue]] { reads.filter { $0.0 == TerminalChannels.write }.map(\.1) }
}

@MainActor
final class TerminalSessionTests: XCTestCase {
    func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    func testListsTheChatsTerminalsAndHosts() async {
        let c = FakeTerminals()
        let m = TerminalsModel(sessionId: "s1", backend: c)
        await m.load()
        XCTAssertEqual(m.terminals.map(\.id), ["term_1", "agent_s1"])
        XCTAssertEqual(m.hosts.map(\.alias), ["devbox"])
        XCTAssertEqual(c.reads.first?.1, [["sessionId": "s1"]], "always one chat's")
        c.hostsError = RelayError("Not allowed from a paired phone (read-off): ssh:hosts", fromComputer: true)
        await m.load()
        XCTAssertEqual(m.hosts, [])
        XCTAssertEqual(m.hostsError, "Reading from this phone is turned off on Studio. Turn it on in Remote access → What phones can do.")
    }

    func testOpeningAttachesOnceAndTypingUsesTheToken() async {
        let c = FakeTerminals()
        let s = TerminalSession(terminal: PhoneTerminal(id: "term_1", title: "zsh"), backend: c)
        await s.start()
        XCTAssertEqual(s.state, .live)
        XCTAssertEqual(c.changes.map(\.0), ["terminal:open"], "one signed open")
        XCTAssertEqual(s.screen.screenText.first, "$")
        s.sendLine("ls -la")
        s.key(.ctrl("c"))
        s.key(.up)
        await settle()
        XCTAssertEqual(c.writes(), [["term_1", "ls -la\r", "tok1"], ["term_1", "\u{3}", "tok1"], ["term_1", "\u{1b}[A", "tok1"]])
        XCTAssertEqual(c.changes.count, 1, "no proof per keystroke")
    }

    func testOutputArrivesForThisTerminalOnly() async {
        let c = FakeTerminals()
        let s = TerminalSession(terminal: PhoneTerminal(id: "term_1", title: "zsh"), backend: c)
        await s.start()
        let v = s.version
        c.emit(.data(terminalId: "term_1", text: "\u{1b}[32mhello\u{1b}[0m", skipped: 0))
        c.emit(.data(terminalId: "term_2", text: "not mine", skipped: 0))
        XCTAssertEqual(s.screen.screenText.first, "$ hello")
        XCTAssertEqual(s.screen.style(x: 2, y: 0).fg, .palette(2))
        XCTAssertGreaterThan(s.version, v)
        c.emit(.exit(terminalId: "term_1", code: 0))
        XCTAssertEqual(s.state, .exited(0))
        XCTAssertFalse(s.canType)
    }

    func testAnExpiredTokenOpensAgainAndRetries() async {
        let c = FakeTerminals()
        let s = TerminalSession(terminal: PhoneTerminal(id: "term_1", title: "zsh"), backend: c)
        await s.start()
        c.validToken = nil // idle for five minutes on the computer
        s.send("x")
        await settle()
        XCTAssertEqual(c.changes.map(\.0), ["terminal:open", "terminal:open"], "Face ID again, once")
        XCTAssertEqual(c.writes().map { $0.last }, ["tok1", "tok2"])
        XCTAssertNil(s.error)
    }

    func testAModeTheProgramSetChangesTheKeysAndPaste() async {
        let c = FakeTerminals()
        let s = TerminalSession(terminal: PhoneTerminal(id: "term_1", title: "zsh"), backend: c)
        await s.start()
        c.emit(.data(terminalId: "term_1", text: "\u{1b}[?1h\u{1b}[?2004h", skipped: 0))
        s.key(.left)
        s.paste("a\nb")
        await settle()
        XCTAssertEqual(c.writes().map { $0[1] }, ["\u{1b}OD", "\u{1b}[200~a\rb\u{1b}[201~"])
    }

    func testResizeFollowsThePhoneAndLeavingRestoresTheSize() async {
        let c = FakeTerminals()
        let s = TerminalSession(terminal: PhoneTerminal(id: "term_1", title: "zsh"), backend: c)
        await s.start()
        s.resize(cols: 44, rows: 30)
        s.resize(cols: 44, rows: 30) // the same size again: nothing sent
        await settle()
        XCTAssertEqual(c.reads.filter { $0.0 == "terminal:resize" }.map(\.1), [["term_1", 44, 30, "tok1"]])
        await s.leave()
        XCTAssertEqual(c.reads.filter { $0.0 == "terminal:resize" }.last?.1, ["term_1", 80, 24, "tok1"], "back to the desktop's size")
        XCTAssertEqual(c.reads.last?.0, "terminal:leave")
        XCTAssertTrue(c.listeners.isEmpty)
        XCTAssertFalse(s.canType)
    }

    func testTheAgentLogIsReadOnly() async {
        let c = FakeTerminals()
        let s = TerminalSession(terminal: PhoneTerminal(id: "agent_s1", title: "Agent commands", kind: .agent), backend: c)
        await s.start()
        XCTAssertEqual(s.state, .readOnly)
        XCTAssertTrue(c.changes.isEmpty, "never attached")
        XCTAssertEqual(s.screen.screenText.prefix(2), ["$ npm test", "ok"])
        s.send("x")
        await settle()
        XCTAssertTrue(c.writes().isEmpty)
    }

    func testAFloodTheComputerDroppedIsReadAgain() async {
        let c = FakeTerminals()
        let s = TerminalSession(terminal: PhoneTerminal(id: "term_1", title: "zsh"), backend: c)
        await s.start()
        c.emit(.data(terminalId: "term_1", text: "", skipped: 300_000))
        await settle()
        XCTAssertEqual(c.reads.filter { $0.0 == "terminal:tail" }.count, 1)
    }

    func testNewTerminalAndSshOpenAttached() async throws {
        let c = FakeTerminals()
        let m = TerminalsModel(sessionId: "s1", backend: c)
        let t = try await m.newTerminal(cols: 40, rows: 20)
        XCTAssertEqual(t.terminalId, "term_9")
        XCTAssertEqual(t.state, .live)
        XCTAssertEqual(c.changes.last?.1, [["sessionId": "s1", "cols": 40, "rows": 20]])
        let ssh = try await m.openSsh(SshHost(alias: "devbox"), cols: 40, rows: 20)
        XCTAssertEqual(ssh.terminalId, "term_ssh")
        XCTAssertEqual(c.changes.last?.1, ["devbox", ["sessionId": "s1", "cols": 40, "rows": 20]])
    }

    func testARefusedOpenSaysWhy() async {
        let c = FakeTerminals()
        c.refuseChange = ChangeRefused(code: "terminal-hidden", message: "Not allowed from a paired phone (terminal-hidden): term_x")
        let s = TerminalSession(terminal: PhoneTerminal(id: "term_x", title: "x"), backend: c)
        await s.start()
        XCTAssertEqual(s.state, .failed("Studio doesn’t share that terminal with phones. Only a chat’s terminals open here."))
    }
}

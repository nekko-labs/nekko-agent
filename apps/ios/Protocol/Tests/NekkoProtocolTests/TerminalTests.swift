import XCTest
@testable import NekkoProtocol

/// The phone's terminal screen (a small VT parser) and the terminal wire (IO-33 FA-3, FA-6).
final class TerminalScreenTests: XCTestCase {
    func screen(_ cols: Int = 20, _ rows: Int = 5, _ text: String) -> TerminalScreen {
        let s = TerminalScreen(cols: cols, rows: rows)
        s.feed(text)
        return s
    }

    func testPlainTextNewlinesAndCarriageReturns() {
        let s = screen(20, 4, "$ ls\r\nREADME.md\r\nsrc\r\n$ ")
        XCTAssertEqual(s.screenText, ["$ ls", "README.md", "src", "$"])
        XCTAssertEqual([s.cursorX, s.cursorY], [2, 3])
        // CR overwrites: a progress line.
        let p = screen(20, 2, "10%\r50%\r100%")
        XCTAssertEqual(p.screenText[0], "100%")
    }

    func testBackspaceTabAndBell() {
        let s = screen(20, 2, "abc\u{8}\u{8}X\u{7}\tY")
        XCTAssertEqual(s.screenText[0], "aXc     Y")
    }

    func testSgrColoursAndAttributes() {
        let s = screen(30, 2, "\u{1b}[1;31mred\u{1b}[0m \u{1b}[38;5;208mo\u{1b}[38;2;1;2;3mr\u{1b}[4;7mu\u{1b}[22;24;27;39mn\u{1b}[92;104mb")
        XCTAssertEqual(s.screenText[0], "red orunb")
        XCTAssertTrue(s.style(x: 0, y: 0).bold)
        XCTAssertEqual(s.style(x: 0, y: 0).fg, .palette(1))
        XCTAssertEqual(s.style(x: 3, y: 0), .plain)
        XCTAssertEqual(s.style(x: 4, y: 0).fg, .palette(208))
        XCTAssertEqual(s.style(x: 5, y: 0).fg, .rgb(1, 2, 3))
        XCTAssertTrue(s.style(x: 6, y: 0).underline && s.style(x: 6, y: 0).inverse)
        let n = s.style(x: 7, y: 0)
        XCTAssertFalse(n.underline || n.inverse || n.bold)
        XCTAssertEqual(n.fg, .default)
        XCTAssertEqual(s.style(x: 8, y: 0).fg, .palette(10))
        XCTAssertEqual(s.style(x: 8, y: 0).bg, .palette(12))
        // The colon form of 24-bit colour.
        let c = screen(10, 1, "\u{1b}[38:2::9:8:7mx")
        XCTAssertEqual(c.style(x: 0, y: 0).fg, .rgb(9, 8, 7))
    }

    func testRunsJoinEquallyStyledText() {
        let s = screen(20, 1, "\u{1b}[32mok\u{1b}[0m done")
        let line = s.rendered()[0]
        XCTAssertEqual(line.runs.map(\.text), ["ok", " done"])
        XCTAssertEqual(line.runs[0].style.fg, .palette(2))
    }

    func testEraseLineAndDisplay() {
        let s = screen(10, 3, "aaaaa\r\nbbbbb\r\nccccc\u{1b}[2;3H\u{1b}[K")
        XCTAssertEqual(s.screenText, ["aaaaa", "bb", "ccccc"])
        s.feed("\u{1b}[1K")
        XCTAssertEqual(s.screenText[1], "")
        s.feed("\u{1b}[J")
        XCTAssertEqual(s.screenText, ["aaaaa", "", ""])
        s.feed("\u{1b}[2J")
        XCTAssertEqual(s.screenText, ["", "", ""])
    }

    func testCursorMovesAndAbsolutePositions() {
        let s = screen(10, 4, "\u{1b}[3;4HX\u{1b}[AY\u{1b}[2DZ\u{1b}[GA\u{1b}[4dB")
        XCTAssertEqual(s.screenText, ["", "A  ZY", "   X", " B"])
    }

    func testScrollingKeepsAScrollBack() {
        let s = screen(10, 2, "1\r\n2\r\n3\r\n4")
        XCTAssertEqual(s.screenText, ["3", "4"])
        XCTAssertEqual(s.scrollbackCount, 2)
        XCTAssertEqual(s.rendered().map(\.text), ["1", "2", "3", "4"])
        // ED 3 clears it.
        s.feed("\u{1b}[3J")
        XCTAssertEqual(s.scrollbackCount, 0)
        // The limit holds.
        let many = TerminalScreen(cols: 5, rows: 2, scrollbackLimit: 3)
        many.feed((1...10).map(String.init).joined(separator: "\r\n"))
        XCTAssertEqual(many.scrollbackCount, 3)
    }

    func testAutowrapAtTheLastColumn() {
        let s = screen(4, 3, "abcdef")
        XCTAssertEqual(s.screenText, ["abcd", "ef", ""])
        // The wrap waits for the next character: a CR at the edge stays on the line.
        let t = screen(4, 3, "abcd\r\nx")
        XCTAssertEqual(t.screenText, ["abcd", "x", ""])
        let off = screen(4, 2, "\u{1b}[?7labcdef")
        XCTAssertEqual(off.screenText, ["abcf", ""])
    }

    func testWideAndCombiningCharacters() {
        let s = screen(6, 2, "日本e\u{301}")
        XCTAssertEqual(s.screenText[0], "日本é")
        XCTAssertEqual(s.cursorX, 5)
        let flag = screen(6, 1, "👍🏽!")
        XCTAssertEqual(flag.screenText[0], "👍🏽!")
    }

    func testScrollRegionInsertAndDeleteLines() {
        let s = screen(5, 4, "a\r\nb\r\nc\r\nd\u{1b}[2;3r\u{1b}[3;1H\n")
        // Line feed at the region's bottom scrolls only the region.
        XCTAssertEqual(s.screenText, ["a", "c", "", "d"])
        s.feed("\u{1b}[2;1H\u{1b}[L")
        XCTAssertEqual(s.screenText, ["a", "", "c", "d"])
        s.feed("\u{1b}[M")
        XCTAssertEqual(s.screenText, ["a", "c", "", "d"])
        s.feed("\u{1b}[r\u{1b}[1;1H\u{1b}M")
        XCTAssertEqual(s.screenText, ["", "a", "c", ""], "reverse index at the top scrolls down")
    }

    func testInsertDeleteAndEraseCharacters() {
        let s = screen(8, 1, "abcdef\u{1b}[1;2H\u{1b}[2P")
        XCTAssertEqual(s.screenText[0], "adef")
        s.feed("\u{1b}[2@")
        XCTAssertEqual(s.screenText[0], "a  def")
        s.feed("\u{1b}[1;4H\u{1b}[2X")
        XCTAssertEqual(s.screenText[0], "a    f")
    }

    func testAlternateScreenComesBackToTheShell() {
        let s = screen(10, 3, "$ vim\r\n\u{1b}[?1049h\u{1b}[H~\r\n~")
        XCTAssertTrue(s.altScreen)
        XCTAssertEqual(s.screenText, ["~", "~", ""])
        XCTAssertEqual(s.rendered().count, 3, "no scroll-back on the alternate screen")
        s.feed("\u{1b}[?1049l")
        XCTAssertFalse(s.altScreen)
        XCTAssertEqual(s.screenText, ["$ vim", "", ""])
        XCTAssertEqual([s.cursorX, s.cursorY], [0, 1])
    }

    func testModesTheKeysAndPasteFollow() {
        let s = screen(10, 2, "\u{1b}[?1h\u{1b}[?2004h\u{1b}[?25l")
        XCTAssertTrue(s.appCursor)
        XCTAssertTrue(s.bracketedPaste)
        XCTAssertFalse(s.cursorVisible)
        s.feed("\u{1b}[?1l\u{1b}[?2004l\u{1b}[?25h")
        XCTAssertFalse(s.appCursor || s.bracketedPaste)
    }

    func testOscTitlesAndUnknownSequencesAreSwallowed() {
        let s = screen(20, 1, "\u{1b}]0;my title\u{7}a\u{1b}]2;other\u{1b}\\b\u{1b}[6nc\u{1b}[>4;1md\u{1b}(Be\u{1b}P1$r\u{1b}\\f\u{1b}[2 qg")
        XCTAssertEqual(s.screenText[0], "abcdefg")
        XCTAssertEqual(s.title, "other")
    }

    func testSequencesSplitAcrossChunks() {
        let s = TerminalScreen(cols: 10, rows: 1)
        for part in ["\u{1b}", "[3", "1m", "x", "\u{1b}[", "0m", "y"] { s.feed(part) }
        XCTAssertEqual(s.screenText[0], "xy")
        XCTAssertEqual(s.style(x: 0, y: 0).fg, .palette(1))
        XCTAssertEqual(s.style(x: 1, y: 0), .plain)
    }

    func testResizeCutsPadsAndKeepsTheCursorLine() {
        let s = screen(10, 4, "one\r\ntwo\r\nthree\r\n$ ")
        s.resize(cols: 4, rows: 2)
        XCTAssertEqual(s.screenText, ["thre", "$"])
        XCTAssertEqual(s.cursorY, 1)
        XCTAssertEqual(s.rendered().map(\.text), ["one", "two", "thre", "$"])
        s.resize(cols: 8, rows: 3)
        XCTAssertEqual(s.screenText, ["thre", "$", ""])
        XCTAssertEqual([s.cols, s.rows], [8, 3])
    }

    func testTheCursorIsDrawnInverted() {
        let s = screen(10, 1, "ab")
        let line = s.rendered(cursor: true)[0]
        XCTAssertEqual(line.runs.last?.style.inverse, true)
        XCTAssertEqual(line.text, "ab ")
        s.feed("\u{1b}[?25l")
        XCTAssertEqual(s.rendered(cursor: true)[0].text, "ab")
    }

    func testResetClearsEverything() {
        let s = screen(10, 2, "\u{1b}[31mx\u{1b}[?1h")
        s.reset()
        XCTAssertEqual(s.screenText, ["", ""])
        XCTAssertFalse(s.appCursor)
        s.feed("y")
        XCTAssertEqual(s.style(x: 0, y: 0), .plain)
    }
}

final class TerminalWireTests: XCTestCase {
    func testDecodesTerminalsHostsAndTheOpenReply() throws {
        let list = try JSONValue.parse("""
        [{"id":"term_1","title":"zsh","kind":"shell","folder":"app","shell":"zsh","running":true,"viewers":1,"createdAt":5,"sessionId":"s1"},
         {"id":"agent_s1","title":"Agent commands","kind":"agent","folder":"","shell":"agent","running":false,"viewers":0},
         {"id":"term_2","title":"devbox","kind":"ssh","folder":"philip","shell":"ssh","running":false,"exitCode":255,"viewers":0},
         {"title":"no id"}]
        """)
        let t = PhoneTerminal.list(list)
        XCTAssertEqual(t.map(\.id), ["term_1", "agent_s1", "term_2"])
        XCTAssertEqual(t[0].detail, "zsh · app")
        XCTAssertTrue(t[1].readOnly)
        XCTAssertEqual(t[1].detail, "Agent commands · exited")
        XCTAssertEqual(t[2].detail, "SSH · philip · exited (255)")
        XCTAssertEqual(t[0].viewers, 1)

        let hosts = SshHost.list(try JSONValue.parse(#"[{"alias":"devbox","hostName":"devbox.lan","port":2222},{"alias":"pi"},{"alias":""}]"#))
        XCTAssertEqual(hosts.map(\.alias), ["devbox", "pi"])
        XCTAssertEqual(hosts[0].detail, "devbox.lan:2222")
        XCTAssertNil(hosts[1].detail)

        let opened = TerminalOpened.from(try JSONValue.parse("""
        {"terminal":{"id":"term_1","title":"zsh","kind":"shell","folder":"app","shell":"zsh","running":true,"viewers":1},
         "buffer":"$ ","cols":80,"rows":24,"truncated":true,"token":"tok","idleMs":300000,"maxMs":1800000}
        """))
        XCTAssertEqual(opened?.token, "tok")
        XCTAssertEqual(opened?.tail.buffer, "$ ")
        XCTAssertEqual(opened?.tail.truncated, true)
        XCTAssertEqual(opened?.tail.terminal?.id, "term_1")
        XCTAssertNil(TerminalOpened.from(try JSONValue.parse(#"{"buffer":"x"}"#)), "no token, not opened")
    }

    func testDecodesEvents() throws {
        XCTAssertEqual(TerminalEvent.from(try JSONValue.parse(#"{"type":"data","terminalId":"t","data":"hi"}"#)), .data(terminalId: "t", text: "hi", skipped: 0))
        XCTAssertEqual(TerminalEvent.from(try JSONValue.parse(#"{"type":"data","terminalId":"t","data":"","skipped":900}"#)), .data(terminalId: "t", text: "", skipped: 900))
        XCTAssertEqual(TerminalEvent.from(try JSONValue.parse(#"{"type":"exit","terminalId":"t","code":0}"#)), .exit(terminalId: "t", code: 0))
        XCTAssertEqual(TerminalEvent.from(try JSONValue.parse(#"{"type":"exit","terminalId":"t","code":null}"#)), .exit(terminalId: "t", code: nil))
        XCTAssertNil(TerminalEvent.from(try JSONValue.parse(#"{"type":"data"}"#)))
    }

    func testBuildsRequestsTheComputerAccepts() {
        // The shapes packages/shared/src/phone-terminal.ts screens (phone-terminal.json).
        XCTAssertEqual(TerminalRequest.list(sessionId: "s1").1, [["sessionId": "s1"]])
        XCTAssertEqual(TerminalRequest.create(sessionId: "s1", cols: 900, rows: 0).1, [["sessionId": "s1", "cols": 500, "rows": 1]])
        let ssh = TerminalRequest.sshOpen(alias: "devbox", sessionId: "s1", cols: 80, rows: 24)
        XCTAssertEqual(ssh.0, "ssh:open")
        XCTAssertEqual(ssh.1, ["devbox", ["sessionId": "s1", "cols": 80, "rows": 24]])
        XCTAssertEqual(TerminalRequest.write("t", "ls\r", token: "tok").1, ["t", "ls\r", "tok"])
        XCTAssertEqual(TerminalRequest.resize("t", cols: 60, rows: 20, token: "tok").1, ["t", 60, 20, "tok"])
        XCTAssertEqual(TerminalRequest.open("t").0, "terminal:open")
        XCTAssertEqual(TerminalRequest.leave("t").0, "terminal:leave")
        XCTAssertEqual(TerminalRequest.hosts().1, [])
    }

    func testKeyRowBytes() {
        XCTAssertEqual(TerminalKeys.bytes(.escape), "\u{1b}")
        XCTAssertEqual(TerminalKeys.bytes(.tab), "\t")
        XCTAssertEqual(TerminalKeys.bytes(.up), "\u{1b}[A")
        XCTAssertEqual(TerminalKeys.bytes(.up, appCursor: true), "\u{1b}OA")
        XCTAssertEqual(TerminalKeys.bytes(.left), "\u{1b}[D")
        XCTAssertEqual(TerminalKeys.bytes(.pageDown), "\u{1b}[6~")
        XCTAssertEqual(TerminalKeys.bytes(.ctrl("c")), "\u{3}")
        XCTAssertEqual(TerminalKeys.bytes(.ctrl("D")), "\u{4}")
        XCTAssertEqual(TerminalKeys.bytes(.ctrl("[")), "\u{1b}")
        XCTAssertEqual(TerminalKeys.bytes(.ctrl("?")), "\u{7f}")
        XCTAssertNil(TerminalKeys.bytes(.ctrl("é")))
    }

    func testPasteAndTheCommandLine() {
        XCTAssertEqual(TerminalKeys.paste("a\nb\r\nc", bracketed: false), "a\rb\rc")
        XCTAssertEqual(TerminalKeys.paste("a\nb", bracketed: true), "\u{1b}[200~a\rb\u{1b}[201~")
        XCTAssertEqual(TerminalKeys.paste("x\u{1b}[201~rm -rf ~\n", bracketed: true), "\u{1b}[200~xrm -rf ~\r\u{1b}[201~", "a pasted end marker can't end the paste")
        XCTAssertEqual(TerminalKeys.line("git status"), "git status\r")
        XCTAssertEqual(TerminalKeys.line("two\nlines"), "two lines\r", "dictation is one line")
    }

    func testLongInputIsSentInParts() {
        let text = String(repeating: "é", count: 40_000) // 80,000 bytes
        let parts = TerminalKeys.chunks(text)
        XCTAssertEqual(parts.count, 2)
        XCTAssertTrue(parts.allSatisfy { $0.utf8.count <= TerminalLimits.writeBytes })
        XCTAssertEqual(parts.joined(), text)
        XCTAssertEqual(TerminalKeys.chunks("ls"), ["ls"])
        XCTAssertEqual(TerminalKeys.chunks(""), [])
    }

    func testTheClassesMatchTheComputer() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/nekko-remote/src/phone-access.json")
        guard let data = try? Data(contentsOf: file) else { throw XCTSkip("repository sources not available") }
        let policy = try JSONValue.parse(data)
        let set = { (k: String) in Set(policy[k]?.array?.compactMap(\.string) ?? []) }
        let terminal = Set(Channels.all.filter { $0.hasPrefix("terminal") || $0.hasPrefix("ssh:") })
        XCTAssertEqual(set("changeChannels").intersection(terminal), Channels.terminalChange)
        XCTAssertEqual(set("tokenChannels"), [TerminalChannels.write, TerminalChannels.resize])
        XCTAssertEqual(set("readChannels").intersection(terminal), [TerminalChannels.list, TerminalChannels.tail, TerminalChannels.sshHosts])
        XCTAssertEqual(policy["terminal"]?.str("openChannel"), TerminalChannels.open)
        XCTAssertEqual(policy["terminal"]?.str("leaveChannel"), TerminalChannels.leave)
        XCTAssertEqual(policy["terminal"]?.long("writeBytes"), Int64(TerminalLimits.writeBytes))
        XCTAssertEqual(policy["terminal"]?.long("maxCols"), Int64(TerminalLimits.maxCols))
    }

    func testRefusalsThatOpeningAgainFixes() {
        let expired = RelayError("Not allowed from a paired phone (token-expired): terminal:write", fromComputer: true)
        XCTAssertTrue(TerminalRefusal.needsReopen(expired))
        XCTAssertTrue(TerminalRefusal.needsReopen(RelayError("Not allowed from a paired phone (token-invalid): terminal:write", fromComputer: true)))
        XCTAssertFalse(TerminalRefusal.needsReopen(RelayError("Not allowed from a paired phone (change-off): terminal:write", fromComputer: true)))
        XCTAssertFalse(TerminalRefusal.needsReopen(RelayError("timed out")))
        XCTAssertEqual(TerminalRefusal.message("terminal-hidden", computer: "Studio"), "Studio doesn’t share that terminal with phones. Only a chat’s terminals open here.")
    }
}

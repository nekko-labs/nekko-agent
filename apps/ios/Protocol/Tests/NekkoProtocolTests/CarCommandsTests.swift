import XCTest
@testable import NekkoProtocol

final class CarCommandsTests: XCTestCase {
    func testStatusPhrases() {
        for s in ["status", "What's happening?", "what is going on", "Nekko, what needs me", "anything need me", "catch me up",
                  "How's it going", "hey nekko status"] {
            XCTAssertEqual(parseCarCommand(s), .status, s)
        }
    }

    func testAnswers() {
        XCTAssertEqual(parseCarCommand("Yes."), .yes)
        XCTAssertEqual(parseCarCommand("go ahead"), .yes)
        XCTAssertEqual(parseCarCommand("never mind"), .no)
        XCTAssertEqual(parseCarCommand("cancel"), .no)
        XCTAssertEqual(parseCarCommand("the second one"), .pick(2))
        XCTAssertEqual(parseCarCommand("3"), .pick(3))
        XCTAssertEqual(parseCarCommand("say that again"), .again)
    }

    func testTell() {
        XCTAssertEqual(parseCarCommand("Tell billing to run the tests first."), .tell(chat: "billing", message: "run the tests first"))
        XCTAssertEqual(parseCarCommand("send to the login chat saying ship it"), .tell(chat: "login", message: "ship it"))
        XCTAssertEqual(parseCarCommand("ask Release notes: is the changelog done"), .tell(chat: "Release notes", message: "is the changelog done"))
        XCTAssertEqual(parseCarCommand("Nekko, reply to docs that it looks good"), .tell(chat: "docs", message: "it looks good"))
    }

    func testTellKeepsTheMessagesCase() {
        XCTAssertEqual(parseCarCommand("tell Billing to use PostgreSQL"), .tell(chat: "Billing", message: "use PostgreSQL"))
    }

    func testRead() {
        XCTAssertEqual(parseCarCommand("read billing"), .read(chat: "billing"))
        XCTAssertEqual(parseCarCommand("what did the login chat say"), .read(chat: "login"))
        XCTAssertEqual(parseCarCommand("read me the latest from release notes"), .read(chat: "release notes"))
        XCTAssertEqual(parseCarCommand("read it"), .read(chat: nil))
        XCTAssertEqual(parseCarCommand("what did it say"), .read(chat: nil))
    }

    func testApprovalsAndStop() {
        XCTAssertEqual(parseCarCommand("allow"), .allow(chat: nil))
        XCTAssertEqual(parseCarCommand("approve it"), .allow(chat: nil))
        XCTAssertEqual(parseCarCommand("allow billing"), .allow(chat: "billing"))
        XCTAssertEqual(parseCarCommand("approve that in the billing chat"), .allow(chat: "billing"))
        XCTAssertEqual(parseCarCommand("deny billing"), .deny(chat: "billing"))
        XCTAssertEqual(parseCarCommand("stop the login chat"), .stop(chat: "login"))
        XCTAssertEqual(parseCarCommand("stop"), .stop(chat: nil))
        XCTAssertEqual(parseCarCommand("stop it"), .stop(chat: nil))
    }

    func testNewChat() {
        XCTAssertEqual(parseCarCommand("start a chat to look into the flaky test"), .newChat(message: "look into the flaky test"))
        XCTAssertEqual(parseCarCommand("Start a new chat about the release notes"), .newChat(message: "the release notes"))
        XCTAssertEqual(parseCarCommand("new chat: fix the login bug"), .newChat(message: "fix the login bug"))
    }

    func testInChatAnythingElseIsAMessage() {
        XCTAssertEqual(parseCarCommand("Use the staging database instead.", inChat: true),
                       .tell(chat: nil, message: "Use the staging database instead"))
        XCTAssertEqual(parseCarCommand("Use the staging database instead."), .unknown("Use the staging database instead"))
        // Commands still win inside a chat.
        XCTAssertEqual(parseCarCommand("stop", inChat: true), .stop(chat: nil))
        XCTAssertEqual(parseCarCommand("status", inChat: true), .status)
    }

    // MARK: Matching

    private let chats = [
        CarChatName(id: "a", title: "Fix flaky login test"),
        CarChatName(id: "b", title: "Billing retries"),
        CarChatName(id: "c", title: "Release notes 0.9.8"),
        CarChatName(id: "d", title: "Billing dashboard"),
        CarChatName(id: "e", title: "Authentication refactor"),
    ]

    func testLooseNames() {
        XCTAssertEqual(matchCarChat("login", among: chats), .one("a"))
        XCTAssertEqual(matchCarChat("the flaky test", among: chats), .one("a"))
        XCTAssertEqual(matchCarChat("release notes", among: chats), .one("c"))
        XCTAssertEqual(matchCarChat("billing retry", among: chats), .one("b"))
        XCTAssertEqual(matchCarChat("auth", among: chats), .one("e"))
        XCTAssertEqual(matchCarChat("Fix flaky login test", among: chats), .one("a"))
    }

    func testCloseNamesAreAChoice() {
        XCTAssertEqual(matchCarChat("billing", among: chats), .several(["b", "d"]))
    }

    func testNoMatch() {
        XCTAssertEqual(matchCarChat("groceries", among: chats), .none)
        XCTAssertEqual(matchCarChat("the chat", among: chats), .none)
    }

    func testExactTitleBeatsALongerOne() {
        let two = [CarChatName(id: "x", title: "Docs"), CarChatName(id: "y", title: "Docs site redesign")]
        XCTAssertEqual(matchCarChat("docs", among: two), .one("x"))
    }

    func testAccentsAndCase() {
        XCTAssertEqual(matchCarChat("cafe", among: [CarChatName(id: "z", title: "Café menu")]), .one("z"))
    }

    // MARK: The shared fixture (packages/shared/fixtures/car-commands.json), also run by Android Auto's grammar (#2782)

    private func command(_ v: JSONValue) -> CarCommand {
        let chat = v.str("chat")
        switch v.str("kind") {
        case "status": return .status
        case "read": return .read(chat: chat)
        case "tell": return .tell(chat: chat, message: v.str("message") ?? "")
        case "allow": return .allow(chat: chat)
        case "deny": return .deny(chat: chat)
        case "stop": return .stop(chat: chat)
        case "newChat": return .newChat(message: v.str("message") ?? "")
        case "yes": return .yes
        case "no": return .no
        case "pick": return .pick(Int(v.long("n") ?? 0))
        case "again": return .again
        default: return .unknown(v.str("text") ?? "")
        }
    }

    func testSharedFixture() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/shared/fixtures/car-commands.json")
        let doc = try JSONValue.parse(Data(contentsOf: file))
        let parse = try XCTUnwrap(doc["parse"]?.array)
        for c in parse {
            let say = c.str("say") ?? ""
            XCTAssertEqual(parseCarCommand(say, inChat: c.flag("inChat")), try command(XCTUnwrap(c["command"])), say)
        }
        func names(_ v: JSONValue?) -> [CarChatName] { (v?.array ?? []).map { CarChatName(id: $0.str("id") ?? "", title: $0.str("title") ?? "") } }
        let defaults = names(doc["chats"])
        let matches = try XCTUnwrap(doc["matches"]?.array)
        for c in matches {
            let query = c.str("query") ?? ""
            let among = c["chats"] == nil ? defaults : names(c["chats"])
            let ids = c["match"]?["ids"]?.array?.compactMap(\.string) ?? []
            let want: CarChatMatch = switch c["match"]?.str("kind") {
            case "one": .one(ids.first ?? "")
            case "several": .several(ids)
            default: .none
            }
            XCTAssertEqual(matchCarChat(query, among: among), want, query)
        }
        XCTAssertGreaterThanOrEqual(parse.count + matches.count, 50)
    }
}

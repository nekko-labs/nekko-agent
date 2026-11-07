import XCTest
@testable import NekkoProtocol

final class AuditTests: XCTestCase {
    /// The trail as `audit:read` answers it (crates/nekkod/src/audit.rs), with one
    /// event of a type this app does not know.
    private func trail() throws -> [AuditEvent] {
        AuditEvent.trail(try JSONValue.parse("""
        [
         {"at":1,"turnId":"t1","type":"turn","mode":"guardrails","model":"m"},
         {"at":2,"turnId":"t1","type":"tool","tool":"read_file","ms":3,"detail":{"path":"app.ts"}},
         {"at":3,"turnId":"t1","type":"approval","tool":"mcp__srv__post_message","severity":"medium","answer":"approved",
          "by":{"via":"phone","device":"d1","deviceName":"Davide's iPhone"}},
         {"at":4,"turnId":"t1","type":"tool","tool":"mcp__srv__post_message","ms":9,"detail":{"server":"srv","recipients":1}},
         {"at":5,"turnId":"t1","type":"taint","by":"mcp__srv__post_message"},
         {"at":5,"turnId":"t1","type":"something new","tool":"x"},
         {"at":6,"turnId":"t2","type":"turn","mode":"yolo"},
         {"at":7,"turnId":"t2","type":"approval","tool":"fetch_url","severity":"high","answer":"approved","by":{"via":"yolo"}},
         {"at":8,"turnId":"t2","type":"redactions","counts":{"PII_EMAIL":2}},
         {"at":9,"turnId":"t2","type":"approval","tool":"bash","answer":"denied","by":{"via":"paired computer","device":"gone"}},
         {"at":10,"turnId":"t2","type":"approval","answer":"unanswered","by":null}
        ]
        """))
    }

    func testSkipsUnknownEventsAndGroupsByTurn() throws {
        let t = try trail()
        XCTAssertEqual(t.count, 10, "the unknown type is skipped")
        let turns = AuditTurn.group(t)
        XCTAssertEqual(turns.map(\.turnId), ["t1", "t2"])
        XCTAssertEqual(turns[0].events.count, 4)
        if case let .turn(mode, _, _) = turns[1].start?.kind { XCTAssertEqual(mode, "yolo") } else { XCTFail("no start") }
        XCTAssertEqual(t.filter(\.isDecision).map(\.at), [3, 7, 9, 10])
    }

    func testReadsAsOnTheDesktop() throws {
        let t = try trail()
        XCTAssertEqual(AuditLine.of(t[1]), AuditLine("Ran read_file", "app.ts · 3 ms"))
        XCTAssertEqual(AuditLine.of(t[2]), AuditLine("Asked before mcp__srv__post_message (medium): approved", "on Davide's iPhone (phone)", .good))
        XCTAssertEqual(AuditLine.of(t[3]).detail, "server srv · 1 recipient · 9 ms")
        XCTAssertEqual(AuditLine.of(t[4]).tone, .warn)
        XCTAssertEqual(AuditLine.of(t[6]), AuditLine("Asked before fetch_url (high): approved", "by YOLO, without asking", .warn))
        XCTAssertEqual(AuditLine.of(t[7]).detail, "2 pii email")
        XCTAssertEqual(AuditLine.of(t[8]), AuditLine("Asked before bash: denied", "on a paired computer (gone)", .bad))
        XCTAssertEqual(AuditLine.of(t[9]), AuditLine("Asked before a tool: no answer", "stopped before anyone answered"))
    }

    func testNamesEveryWayAnAnswerCanCome() {
        XCTAssertEqual(AuditLine.by(.init(via: "this computer")), "on this computer")
        XCTAssertEqual(AuditLine.by(.init(via: "phone", device: "d1")), "on a phone (d1)")
        XCTAssertEqual(AuditLine.by(.init(via: "phone", device: "d1", deviceName: " ")), "on a phone (d1)")
        XCTAssertEqual(AuditLine.by(.init(via: "paired computer", device: "d2", deviceName: "Studio Mac")), "on Studio Mac (paired computer)")
        XCTAssertEqual(AuditLine.by(.init(via: "telegram")), "in Telegram")
        XCTAssertEqual(AuditLine.by(nil), "nobody answered")
    }
}

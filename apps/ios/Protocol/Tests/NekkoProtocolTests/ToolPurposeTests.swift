import XCTest
@testable import NekkoProtocol

/// The shared purpose fixture (packages/shared/fixtures/tool-purpose.json), the
/// same cases the TS classifier (Vitest) and the Kotlin port run.
final class ToolPurposeTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/shared/fixtures/tool-purpose.json")
        let data = try Data(contentsOf: file)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    private func call(_ v: JSONValue) -> PurposeCall {
        PurposeCall(name: v.str("name") ?? "", input: v["input"]?.object ?? [:], failed: v["failed"]?.bool ?? false)
    }

    func testPurposes() throws {
        let cases = try XCTUnwrap(fixture()["purposes"]?.array)
        XCTAssertGreaterThanOrEqual(cases.count, 60)
        for c in cases {
            let got = Purpose.of(name: c.str("name") ?? "", input: c["input"]?.object ?? [:])
            XCTAssertEqual(got.rawValue, c.str("purpose"), "\(c.str("name") ?? "") \(String(describing: c["input"]))")
        }
    }

    func testGoals() throws {
        for c in try XCTUnwrap(fixture()["goals"]?.array) {
            XCTAssertEqual(Purpose.goal(name: c.str("name") ?? "", input: c["input"]?.object ?? [:]), c.str("goal"), c.str("name") ?? "")
        }
    }

    func testHeadlines() throws {
        for c in try XCTUnwrap(fixture()["headlines"]?.array) {
            let purpose = try XCTUnwrap(ToolPurpose(rawValue: c.str("purpose") ?? ""))
            let calls = (c["calls"]?.array ?? []).map(call)
            let h = Purpose.headline(purpose, calls, running: c["running"]?.bool ?? false)
            XCTAssertEqual(h.headline, c.str("headline"))
            XCTAssertEqual(h.detail, c.str("detail"), c.str("headline") ?? "")
        }
    }

    private func tool(_ id: String, _ name: String, _ input: [String: JSONValue], _ status: ToolStatus = .ok) -> Block {
        .tool(id: id, name: name, label: name, status: status, output: nil, input: input)
    }

    private func shape(_ blocks: [Block]) -> [String] {
        Purpose.group(blocks, role: Purpose.role(of:)).map { run in
            switch run {
            case .single(let b): return b.id
            case .group(let p, let items, _): return "\(p.rawValue):" + items.map(\.id).joined(separator: ",")
            }
        }
    }

    func testGroupsAdjacentSamePurposeBlocks() {
        let blocks: [Block] = [
            .user(id: "u", text: "go", at: nil, images: 0),
            tool("a", "read_file", ["path": .string("AGENTS.md")]),
            .assistant(id: "t", text: "", reasoning: "next", streaming: false, interrupted: false),
            tool("b", "read_file", ["path": .string("CLAUDE.md")]),
            tool("c", "read_file", ["path": .string("src/a.ts")]),
            tool("d", "grep", ["pattern": .string("x")]),
            .assistant(id: "r", text: "Found it.", reasoning: nil, streaming: false, interrupted: false),
            tool("e", "bash", ["command": .string("npm test")]),
            tool("f", "bash", ["command": .string("npm run lint")], .error),
        ]
        XCTAssertEqual(shape(blocks), ["u", "guidance:a,t,b", "explore:c,d", "r", "check:e,f"])
    }

    func testApprovalQuestionsAndLoneCallsStaySingle() {
        let blocks: [Block] = [
            tool("a", "bash", ["command": .string("npm install")]),
            tool("b", "bash", ["command": .string("node x.mjs")]),
            tool("c", "bash", ["command": .string("rm -rf build")], .waiting),
            tool("q", "ask_user", [:]),
            tool("d", "edit_file", ["path": .string("a.ts")]),
        ]
        XCTAssertEqual(shape(blocks), ["run:a,b", "c", "q", "d"])
    }
}

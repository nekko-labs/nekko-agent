import XCTest
@testable import NekkoProtocol

/// The plan sheet's logic, the same cases as the desktop's
/// `claudeAgentPlan.test.ts` and `planStepLinks.test.ts`.
final class PlanTests: XCTestCase {
    private func msg(_ id: String, _ role: String, _ content: String = "", at: Int64, calls: [ToolCall] = [],
                     result: ToolResult? = nil, interrupted: Bool = false) -> ChatMessage {
        ChatMessage(id: id, role: role, content: content, reasoning: nil, createdAt: at, imageCount: 0, skill: nil,
                    toolCalls: calls, toolResult: result, interrupted: interrupted)
    }

    private func bash(_ id: String, _ command: String) -> ToolCall { ToolCall(id: id, name: "Bash", input: ["command": .string(command)]) }

    private func result(_ id: String, _ output: String, error: Bool = false) -> ToolResult {
        ToolResult(toolCallId: id, output: output, isError: error, outputChars: nil, omittedImages: 0)
    }

    private func plan(_ steps: [(String, String)]) -> JSONValue {
        .object(["steps": .array(steps.map { .object(["title": .string($0.0), "status": .string($0.1)]) })])
    }

    func testParsesTheChatsPlan() throws {
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"id":"s1","title":"Chat","messages":[],"agentPlan":[
          {"id":"step_1","title":"Read the parser","status":"done","kind":"explore","createdAt":1,"updatedAt":2},
          {"id":"step_2","title":"Wire the CSV parser","status":"active","kind":"build","pass":2,"note":"Second try",
           "verification":{"status":"passed","device":"macOS","detail":"All 40 tests","evidenceUrl":"https://ci.example/1"},"createdAt":1,"updatedAt":3},
          {"id":"step_3","title":"Ship","status":"weird"}
        ]}
        """#.utf8))
        let s = try XCTUnwrap(Session.from(raw))
        XCTAssertEqual(s.agentPlan.map(\.id), ["step_1", "step_2", "step_3"])
        let two = s.agentPlan[1]
        XCTAssertEqual(two.kind, .build)
        XCTAssertEqual(two.pass, 2)
        XCTAssertEqual(two.verification?.label, "Verified on macOS")
        XCTAssertEqual(two.detail, "All 40 tests")
        XCTAssertEqual(two.verification?.safeEvidence?.absoluteString, "https://ci.example/1")
        XCTAssertEqual(s.agentPlan[2].status, .pending)
        XCTAssertEqual(AgentPlan.current(s.agentPlan)?.id, "step_2")
        XCTAssertEqual(AgentPlan.finished(s.agentPlan), 1)
        XCTAssertEqual(AgentPlan.sheet(s, claudeCode: false, working: false)?.count, 3)
    }

    func testUnsafeEvidenceIsNotALink() {
        let v = PlanStep.Verification(status: .passed, evidenceUrl: "file:///etc/passwd")
        XCTAssertNil(v.safeEvidence)
        XCTAssertEqual(PlanStep.Verification(status: .failed).label, "Check failed")
    }

    func testNoPlanOutsideClaudeCode() {
        let s = Session(id: "s", title: "", providerId: "p", modelId: nil, workspaceId: nil, mode: nil,
                        messages: [msg("u", "user", "hi", at: 1), msg("a", "assistant", "", at: 2, calls: [bash("c1", "ls")])],
                        omittedMessages: 0, queue: [], updatedAt: 0)
        XCTAssertNil(AgentPlan.sheet(s, claudeCode: false, working: true))
        XCTAssertNotNil(AgentPlan.sheet(s, claudeCode: true, working: true))
    }

    func testPhases() {
        XCTAssertEqual(AgentPlan.phase(of: ToolCall(id: "1", name: "Grep")), .explore)
        XCTAssertEqual(AgentPlan.phase(of: ToolCall(id: "1", name: "Edit")), .build)
        XCTAssertEqual(AgentPlan.phase(of: bash("1", "npm run typecheck")), .verify)
        XCTAssertEqual(AgentPlan.phase(of: bash("1", "cd x && gh pr create --fill 2>&1 | tail -3")), .ship)
        XCTAssertEqual(AgentPlan.phase(of: bash("1", "git commit -m wip")), .build)
        XCTAssertEqual(AgentPlan.phase(of: bash("1", "ls -la")), .explore)
        XCTAssertNil(AgentPlan.phase(of: ToolCall(id: "1", name: "TodoWrite")))
    }

    func testActivityPlanWhileWorkingAndAfter() throws {
        let messages = [
            msg("u0", "user", "older", at: 1),
            msg("u1", "user", "nekko agent\n\nfix the parser", at: 10),
            msg("a1", "assistant", "", at: 11, calls: [ToolCall(id: "c1", name: "Read"), ToolCall(id: "c2", name: "Grep")]),
            msg("a2", "assistant", "", at: 12, calls: [ToolCall(id: "c3", name: "Edit")]),
        ]
        let working = try XCTUnwrap(AgentPlan.activityPlan(messages, working: true))
        XCTAssertEqual(working.map(\.id), ["phase:sent", "phase:explore", "phase:build", "phase:verify", "phase:ship"])
        XCTAssertEqual(working.map(\.status), [.done, .done, .active, .pending, .pending])
        XCTAssertEqual(working[0].note, "nekko agent")
        XCTAssertEqual(working[1].note, "2 reads and searches")
        XCTAssertEqual(working[2].note, "1 edit")
        let after = try XCTUnwrap(AgentPlan.activityPlan(messages, working: false))
        XCTAssertEqual(after.map(\.id), ["phase:sent", "phase:explore", "phase:build"])
        XCTAssertTrue(after.allSatisfy { $0.status == .done })
        // A request Claude Code only answered shows no plan.
        XCTAssertNil(AgentPlan.activityPlan([msg("u", "user", "hi", at: 1), msg("a", "assistant", "hello", at: 2)], working: false))
    }

    func testClaudeCodesOwnPlanFromTasks() throws {
        let create = ToolCall(id: "t1", name: "TaskCreate", input: ["subject": .string("Port the sheet"), "description": .string("To Swift\nmore")])
        let create2 = ToolCall(id: "t2", name: "TaskCreate", input: ["subject": .string("Test it")])
        let update = ToolCall(id: "t3", name: "TaskUpdate", input: ["taskId": .string("1"), "status": .string("in_progress")])
        let failed = ToolCall(id: "t4", name: "TaskUpdate", input: ["taskId": .string("2"), "status": .string("completed")])
        let messages = [
            msg("a", "assistant", at: 1, calls: [create, create2]),
            msg("r1", "tool", at: 2, result: result("t1", "Task #1 created successfully")),
            msg("r2", "tool", at: 3, result: result("t2", "Task #2 created successfully")),
            msg("b", "assistant", at: 4, calls: [update, failed]),
            msg("r3", "tool", at: 5, result: result("t3", "ok")),
            msg("r4", "tool", at: 6, result: result("t4", "nope", error: true)),
        ]
        let plan = try XCTUnwrap(AgentPlan.claudeCodeOwnPlan(messages))
        XCTAssertEqual(plan.map(\.id), ["task_1", "task_2"])
        XCTAssertEqual(plan.map(\.status), [.active, .pending])
        XCTAssertEqual(plan[0].note, "To Swift")
    }

    func testClaudeCodesOwnPlanFromTodos() throws {
        let todo = ToolCall(id: "w", name: "TodoWrite", input: ["todos": .array([
            .object(["content": .string("Read"), "status": .string("completed")]),
            .object(["content": .string("Write"), "status": .string("in_progress")]),
        ])])
        let plan = try XCTUnwrap(AgentPlan.claudeCodeOwnPlan([msg("a", "assistant", at: 1, calls: [todo]), msg("r", "tool", at: 2, result: result("w", "ok"))]))
        XCTAssertEqual(plan.map(\.title), ["Read", "Write"])
        XCTAssertEqual(plan.map(\.status), [.done, .active])
    }

    func testProjectLinks() {
        let links = AgentPlan.projectLinks("See https://linear.app/nekko/issue/nek-412/title, and https://github.com/nekko-labs/nekko-agent/issues/12. Also https://example.com/x")
        XCTAssertEqual(links.map(\.label), ["NEK-412", "nekko-labs/nekko-agent#12"])
        XCTAssertEqual(links[1].url, "https://github.com/nekko-labs/nekko-agent/issues/12")
    }

    func testChipsLandOnTheStepActiveAtTheTime() {
        let live = [
            PlanStep(id: "s1", title: "Explore", status: .done),
            PlanStep(id: "s2", title: "Build it", status: .done),
            PlanStep(id: "s3", title: "Ship it", status: .active),
        ]
        let pr = "https://github.com/o/r/pull/7"
        let messages = [
            msg("u", "user", "Do https://linear.app/x/issue/NEK-1", at: 1),
            msg("a1", "assistant", at: 2, calls: [ToolCall(id: "p1", name: "update_plan", input: plan([("Explore", "active"), ("Build it", "pending"), ("Ship it", "pending")]).object!)]),
            msg("a2", "assistant", at: 3, calls: [ToolCall(id: "p2", name: "update_plan", input: plan([("Explore", "done"), ("Build it", "active")]).object!)]),
            msg("a3", "assistant", at: 5, calls: [ToolCall(id: "p3", name: "update_plan", input: plan([("Build it", "done"), ("Ship it", "active")]).object!)]),
            msg("a4", "assistant", at: 6, calls: [bash("g", "gh pr create")]),
            msg("r", "tool", at: 7, result: result("g", pr + "\nhttps://github.com/o/r/pull/99")),
        ]
        let child = SessionSummary(id: "kid", title: "Sub", updatedAt: 9, modelId: nil, lastReplyText: nil, firstUserText: nil,
                                   archived: false, parentSessionId: "s", taskId: nil, trainingRunId: nil, providerId: nil,
                                   workspaceId: nil, archivedAt: nil, order: nil, pinned: false, activeWatchCount: 0, createdAt: 4)
        let links = AgentPlan.links(messages, plan: live, prs: [pr], children: [child])
        XCTAssertEqual(links["s1"]?.projects.map(\.label), ["NEK-1"])
        XCTAssertEqual(links["s2"]?.subagents, ["kid"])
        // Only the chat's own PRs count.
        XCTAssertEqual(links["s3"]?.prs, [pr])
    }

    func testActivityPlanPutsThePrOnShip() throws {
        let pr = "https://github.com/o/r/pull/3"
        let messages = [
            msg("u", "user", "go", at: 1),
            msg("a", "assistant", at: 2, calls: [ToolCall(id: "e", name: "Edit")]),
            msg("b", "assistant", at: 3, calls: [bash("s", "gh pr create --fill")]),
            msg("r", "tool", at: 4, result: result("s", pr)),
        ]
        let steps = try XCTUnwrap(AgentPlan.activityPlan(messages, working: false))
        XCTAssertEqual(AgentPlan.links(messages, plan: steps, prs: [pr])["phase:ship"]?.prs, [pr])
    }

    func testPausedAfterAnInterruptedReply() {
        let messages = [msg("u", "user", "go", at: 1), msg("a", "assistant", "", at: 2, interrupted: true)]
        XCTAssertTrue(AgentPlan.paused(messages, running: false))
        XCTAssertFalse(AgentPlan.paused(messages, running: true))
    }
}

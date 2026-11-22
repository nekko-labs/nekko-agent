package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The plan sheet's logic (#2115): the iPhone's PlanTests, the desktop's claudeAgentPlan and planStepLinks cases. */
class AgentPlanTest {
    private fun msg(id: String, role: String, content: String = "", at: Long, calls: List<ToolCall> = emptyList(), result: ToolResult? = null, interrupted: Boolean = false) =
        ChatMessage(id = id, role = role, content = content, createdAt = at, toolCalls = calls, toolResult = result, interrupted = interrupted)

    private fun bash(id: String, command: String) = ToolCall(id, "Bash", buildJsonObject { put("command", command) })
    private fun result(id: String, output: String, error: Boolean = false) = ToolResult(id, output, error)
    private fun obj(vararg pairs: Pair<String, Any>): JsonObject = JsonObject(pairs.associate { (k, v) ->
        k to when (v) { is String -> JsonPrimitive(v); is JsonArray -> v; is JsonObject -> v; else -> error("type") }
    })
    private fun plan(vararg steps: Pair<String, String>) = obj("steps" to JsonArray(steps.map { (t, s) -> obj("title" to t, "status" to s) }))
    private fun session(messages: List<ChatMessage>) = Session(id = "s", title = "", providerId = "p", modelId = null, workspaceId = null, messages = messages, queue = emptyList(), updatedAt = 0)

    @Test fun parsesTheChatsPlan() {
        val s = Session.from(WireJson.parseToJsonElement("""
        {"id":"s1","title":"Chat","messages":[],"agentPlan":[
          {"id":"step_1","title":"Read the parser","status":"done","kind":"explore","createdAt":1,"updatedAt":2},
          {"id":"step_2","title":"Wire the CSV parser","status":"active","kind":"build","pass":2,"note":"Second try",
           "verification":{"status":"passed","device":"macOS","detail":"All 40 tests","evidenceUrl":"https://ci.example/1"},"createdAt":1,"updatedAt":3},
          {"id":"step_3","title":"Ship","status":"weird"}
        ]}
        """))!!
        assertEquals(listOf("step_1", "step_2", "step_3"), s.agentPlan.map { it.id })
        val two = s.agentPlan[1]
        assertEquals(PlanStep.Kind.BUILD, two.kind)
        assertEquals(2, two.pass)
        assertEquals("Verified on macOS", two.verification?.label)
        assertEquals("All 40 tests", two.detail)
        assertEquals("https://ci.example/1", two.verification?.safeEvidence)
        assertEquals(PlanStep.Status.PENDING, s.agentPlan[2].status)
        assertEquals("step_2", AgentPlan.current(s.agentPlan)?.id)
        assertEquals(1, AgentPlan.finished(s.agentPlan))
        assertEquals(3, AgentPlan.sheet(s, claudeCode = false)?.size)
    }

    @Test fun unsafeEvidenceIsNotALink() {
        assertNull(PlanStep.Verification(PlanStep.Verification.Status.PASSED, evidenceUrl = "file:///etc/passwd").safeEvidence)
        assertNull(PlanStep.Verification(PlanStep.Verification.Status.PASSED, evidenceUrl = "javascript:alert(1)").safeEvidence)
        assertEquals("Check failed", PlanStep.Verification(PlanStep.Verification.Status.FAILED).label)
    }

    @Test fun noPlanOutsideClaudeCodeOrWithoutPlanCalls() {
        val s = session(listOf(msg("u", "user", "hi", at = 1), msg("a", "assistant", at = 2, calls = listOf(bash("c1", "ls")))))
        assertNull(AgentPlan.sheet(s, claudeCode = false))
        // A Claude Agent chat whose Claude Code wrote no plan shows none: no placeholder from its tool calls.
        assertNull(AgentPlan.sheet(s, claudeCode = true))
    }

    @Test fun claudeAgentChatShowsClaudeCodesOwnPlan() {
        val todo = ToolCall("t1", "TodoWrite", obj("todos" to JsonArray(listOf(obj("content" to "Port it", "status" to "in_progress"), obj("content" to "Test it", "status" to "pending")))))
        val s = session(listOf(msg("u", "user", "go", at = 1), msg("a", "assistant", at = 2, calls = listOf(todo)), msg("r", "tool", at = 3, result = result("t1", "ok"))))
        assertEquals(listOf("Port it", "Test it"), AgentPlan.sheet(s, claudeCode = true)?.map { it.title })
    }

    @Test fun claudeCodesOwnPlanFromTasks() {
        val messages = listOf(
            msg("a", "assistant", at = 1, calls = listOf(
                ToolCall("t1", "TaskCreate", obj("subject" to "Port the sheet", "description" to "To Kotlin\nmore")),
                ToolCall("t2", "TaskCreate", obj("subject" to "Test it")),
            )),
            msg("r1", "tool", at = 2, result = result("t1", "Task #1 created successfully")),
            msg("r2", "tool", at = 3, result = result("t2", "Task #2 created successfully")),
            msg("b", "assistant", at = 4, calls = listOf(
                ToolCall("t3", "TaskUpdate", obj("taskId" to "1", "status" to "in_progress")),
                ToolCall("t4", "TaskUpdate", obj("taskId" to "2", "status" to "completed")),
            )),
            msg("r3", "tool", at = 5, result = result("t3", "ok")),
            msg("r4", "tool", at = 6, result = result("t4", "nope", error = true)),
        )
        val plan = AgentPlan.claudeCodeOwnPlan(messages)!!
        assertEquals(listOf("task_1", "task_2"), plan.map { it.id })
        assertEquals(listOf(PlanStep.Status.ACTIVE, PlanStep.Status.PENDING), plan.map { it.status })
        assertEquals("To Kotlin", plan[0].note)
    }

    @Test fun claudeCodesOwnPlanFromTodos() {
        val todo = ToolCall("w", "TodoWrite", obj("todos" to JsonArray(listOf(obj("content" to "Read", "status" to "completed"), obj("content" to "Write", "status" to "in_progress")))))
        val plan = AgentPlan.claudeCodeOwnPlan(listOf(msg("a", "assistant", at = 1, calls = listOf(todo)), msg("r", "tool", at = 2, result = result("w", "ok"))))!!
        assertEquals(listOf("Read", "Write"), plan.map { it.title })
        assertEquals(listOf(PlanStep.Status.DONE, PlanStep.Status.ACTIVE), plan.map { it.status })
    }

    @Test fun projectLinks() {
        val links = AgentPlan.projectLinks("See https://linear.app/nekko/issue/nek-412/title, and https://github.com/nekko-labs/nekko-agent/issues/12. Also https://example.com/x")
        assertEquals(listOf("NEK-412", "nekko-labs/nekko-agent#12"), links.map { it.label })
        assertEquals("https://github.com/nekko-labs/nekko-agent/issues/12", links[1].url)
    }

    @Test fun chipsLandOnTheStepActiveAtTheTime() {
        val live = listOf(PlanStep("s1", "Explore", PlanStep.Status.DONE), PlanStep("s2", "Build it", PlanStep.Status.DONE), PlanStep("s3", "Ship it", PlanStep.Status.ACTIVE))
        val pr = "https://github.com/o/r/pull/7"
        val messages = listOf(
            msg("u", "user", "Do https://linear.app/x/issue/NEK-1", at = 1),
            msg("a1", "assistant", at = 2, calls = listOf(ToolCall("p1", "update_plan", plan("Explore" to "active", "Build it" to "pending", "Ship it" to "pending")))),
            msg("a2", "assistant", at = 3, calls = listOf(ToolCall("p2", "update_plan", plan("Explore" to "done", "Build it" to "active")))),
            msg("a3", "assistant", at = 5, calls = listOf(ToolCall("p3", "update_plan", plan("Build it" to "done", "Ship it" to "active")))),
            msg("a4", "assistant", at = 6, calls = listOf(bash("g", "gh pr create"))),
            msg("r", "tool", at = 7, result = result("g", "$pr\nhttps://github.com/o/r/pull/99")),
        )
        val child = SessionSummary(id = "kid", title = "Sub", updatedAt = 9, modelId = null, lastReplyText = null, firstUserText = null,
            archived = false, parentSessionId = "s", taskId = null, trainingRunId = null, createdAt = 4)
        val links = AgentPlan.links(messages, live, setOf(pr), listOf(child))
        assertEquals(listOf("NEK-1"), links["s1"]?.projects?.map { it.label })
        assertEquals(listOf("kid"), links["s2"]?.subagents)
        // Only the chat's own PRs count.
        assertEquals(listOf(pr), links["s3"]?.prs)
    }

    @Test fun theLastFinishedStepWithResultsStartsOpen() {
        val evidence = PlanStep.Verification(PlanStep.Verification.Status.PASSED, evidenceUrl = "https://ci.example/2")
        val plan = listOf(
            PlanStep("s1", "Explore", PlanStep.Status.DONE), PlanStep("s2", "Build", PlanStep.Status.DONE),
            PlanStep("s3", "Verify", PlanStep.Status.DONE, verification = evidence), PlanStep("s4", "Ship", PlanStep.Status.DONE),
            PlanStep("s5", "Next", PlanStep.Status.ACTIVE),
        )
        val pr = PlanStepLinks(prs = listOf("https://github.com/o/r/pull/7"))
        // A task link says what the work is for; it is not a result.
        val task = PlanStepLinks(projects = listOf(ProjectLink("https://linear.app/x/issue/NEK-1", "NEK-1")))
        assertEquals("s3", AgentPlan.openByDefault(plan, mapOf("s1" to task, "s2" to pr)))
        assertEquals("s4", AgentPlan.openByDefault(plan, mapOf("s4" to pr, "s2" to pr)))
        // The step being worked is open anyway; only finished steps count.
        assertEquals("s3", AgentPlan.openByDefault(plan, mapOf("s5" to pr)))
        assertNull(AgentPlan.openByDefault(plan.take(2), mapOf("s1" to task)))
    }

    @Test fun pausedAfterAnInterruptedReply() {
        val messages = listOf(msg("u", "user", "go", at = 1), msg("a", "assistant", at = 2, interrupted = true))
        assertTrue(AgentPlan.paused(messages, running = false))
        assertFalse(AgentPlan.paused(messages, running = true))
    }
}

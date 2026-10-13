package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class WireTest {
    private fun json(s: String) = WireJson.parseToJsonElement(s)

    /** Every channel the phone calls must exist in the shared IPC contract. */
    @Test fun `channel names match packages shared ipc`() {
        val ipc = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "packages/shared/src/ipc.ts")
        if (!ipc.exists()) return // running outside the monorepo
        val text = ipc.readText()
        for (ch in Channels.ALL + Events.AGENT_EVENT) assertTrue("missing $ch in ipc.ts", text.contains("'$ch'"))
    }

    @Test fun `providers drop secrets and keep only public fields`() {
        val list = PublicProvider.list(json("""[{"id":"fake","kind":"openai-compat","label":"Fake","baseUrl":"http://x","apiKey":"sk-secret","enabled":true},{"nope":1}]"""))
        assertEquals(listOf(PublicProvider("fake", "openai-compat", "Fake", true)), list)
        assertFalse(list.toString().contains("sk-"))
    }

    @Test fun `summaries keep real top-level unarchived chats newest first`() {
        val list = SessionSummary.visible(json("""[
          {"id":"a","title":"A","updatedAt":1},
          {"id":"b","title":"B","updatedAt":3},
          {"id":"c","title":"C","updatedAt":5,"archivedAt":4},
          {"id":"d","title":"D","updatedAt":6,"parentSessionId":"a"},
          {"id":"e","title":"E","updatedAt":7,"taskId":"t"},
          {"id":"f","title":"F","updatedAt":8,"trainingRunId":"r"},
          {"id":"g","title":"G","updatedAt":2,"archivedAt":null}
        ]"""))
        assertEquals(listOf("b", "g", "a"), list.map { it.id })
    }

    @Test fun `session decodes messages, tool calls and mixed queue entries`() {
        val s = Session.from(json("""{"id":"s_1","title":"T","providerId":"p","modelId":"m","updatedAt":9,
          "queue":["one",{"text":"two","images":["data:"]}],
          "messages":[
            {"id":"u","role":"user","content":"hi","createdAt":1,"images":["x","y"]},
            {"id":"a","role":"assistant","content":"","toolCalls":[{"id":"c1","name":"bash","input":{"command":"ls"}}]},
            {"id":"t","role":"tool","content":"","toolResult":{"toolCallId":"c1","output":"file","isError":false}}
          ]}"""))!!
        assertEquals(listOf("one", "two"), s.queue)
        assertEquals(2, s.messages[0].imageCount)
        assertEquals("bash", s.messages[1].toolCalls.single().name)
        assertEquals("file", s.messages[2].toolResult!!.output)
        assertNull(Session.from(json("null")))
    }

    @Test fun `defaults read only the model fields`() {
        assertEquals(RemoteDefaults("p", "m"), RemoteDefaults.from(json("""{"defaultProviderId":"p","defaultModelId":"m","providers":[{"apiKey":"sk"}]}""")))
    }

    @Test fun `pending map decodes approvals and questions`() {
        val m = PendingInput.map(json("""{"s1":{"sessionId":"s1","approval":{"call":{"id":"c","name":"bash","input":{"command":"rm -rf x"}},"reason":"deletes files","severity":"high","requestedAt":1}},
          "s2":{"sessionId":"s2","question":{"callId":"q","askedAt":2,"questions":[{"id":"q1","header":"Scope","question":"Which?","options":[{"label":"A","description":"a"},{"label":"B"}],"multiSelect":true}]}}}"""))
        assertEquals(Severity.HIGH, m["s1"]!!.approval!!.severity)
        val q = m["s2"]!!.question!!
        assertEquals("q", q.callId)
        assertTrue(q.questions.single().multiSelect)
        assertEquals(listOf("A", "B"), q.questions.single().options.map { it.label })
    }

    @Test fun `agent events decode, unknown types are tolerated`() {
        assertEquals(AgentEvent.Text("s", "hi"), AgentEvent.from(json("""{"type":"text","sessionId":"s","delta":"hi"}""")))
        assertTrue(AgentEvent.from(json("""{"type":"tool_approval_required","sessionId":"s","call":{"id":"c","name":"bash","input":{}},"reason":"r","severity":"medium"}""")) is AgentEvent.ApprovalRequired)
        assertEquals(AgentEvent.Other("s", "compaction"), AgentEvent.from(json("""{"type":"compaction","sessionId":"s","progress":{}}""")))
        assertNull(AgentEvent.from(json("""{"type":"text"}""")))
    }

    @Test fun `answers encode like shared AskAnswer`() {
        assertEquals("""{"questionId":"q1","labels":["A"],"note":"more"}""", AskAnswer("q1", listOf("A"), "more").toJson().toString())
        assertEquals("""{"questionId":"q1","labels":[]}""", AskAnswer("q1", emptyList(), " ").toJson().toString())
    }
}

package com.nekko.android

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.chat.TURN_TIMEOUT_MS
import com.nekko.protocol.AUTO_MODEL_ID
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Approval
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskOption
import com.nekko.protocol.AskQuestion
import com.nekko.protocol.AskRequest
import com.nekko.protocol.Block
import com.nekko.protocol.Channels
import com.nekko.protocol.DenyReason
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.Severity
import com.nekko.protocol.ToolCall
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerTest {
    private val sid = "s1"
    private val online = ChatEnv(RelayState.ONLINE, null, RemoteDefaults("openai", "gpt-x"), "Mac")

    private fun session(
        messages: List<JsonObject> = emptyList(),
        queue: List<String> = emptyList(),
        providerId: String? = null,
        modelId: String? = null,
    ): JsonObject = buildJsonObject {
        put("id", sid)
        put("title", "**Fix** the build")
        providerId?.let { put("providerId", it) }
        modelId?.let { put("modelId", it) }
        put("messages", JsonArray(messages))
        put("queue", buildJsonArray { queue.forEach { add(JsonPrimitive(it)) } })
        put("updatedAt", 1)
    }

    private fun msg(id: String, role: String, content: String) = buildJsonObject {
        put("id", id); put("role", role); put("content", content)
    }

    private fun TestScope.controller(caller: FakeCaller, env: ChatEnv = online) =
        ChatController(sid, caller, backgroundScope, { env }, now = { 42L })

    private val approval = Approval(ToolCall("call-1", "bash", buildJsonObject { put("command", "rm -rf build") }), "deletes files", Severity.HIGH)
    private val question = AskRequest(
        "ask-1",
        listOf(AskQuestion("q1", "Scope", "Which?", listOf(AskOption("A", null), AskOption("B", "bee")), multiSelect = false)),
        0,
    )

    @Test
    fun `send while idle adds the prompt optimistically and starts a long chat send`() = runTest {
        val turnEnd = CompletableDeferred<JsonElement>()
        val caller = FakeCaller { c -> if (c.channel == Channels.CHAT_SEND) turnEnd.await() else JsonNull }
        val chat = controller(caller)

        chat.send("hello")
        runCurrent()

        val turn = chat.state.value.turn
        assertTrue(turn.running)
        val user = turn.blocks.single() as Block.User
        assertEquals("hello", user.text)
        assertEquals("pending-42", user.id)

        val send = caller.calls.single()
        assertEquals(Channels.CHAT_SEND, send.channel)
        assertEquals(TURN_TIMEOUT_MS, send.timeoutMs)
        val opts = send.args.single().jsonObject
        assertEquals(sid, opts["sessionId"]!!.jsonPrimitive.content)
        assertEquals("openai", opts["providerId"]!!.jsonPrimitive.content)
        assertEquals("gpt-x", opts["modelId"]!!.jsonPrimitive.content)
        assertEquals("hello", opts["text"]!!.jsonPrimitive.content)
        // send() returned without waiting for the turn to end.
        assertFalse(turnEnd.isCompleted)
    }

    @Test
    fun `the session's own model wins over defaults, but never the auto sentinel`() {
        val s = com.nekko.protocol.Session.from(session(providerId = "local", modelId = "qwen-7b"))
        assertEquals("local" to "qwen-7b", ChatController.resolveModel(s, online.defaults))
        val auto = com.nekko.protocol.Session.from(session(providerId = "local", modelId = AUTO_MODEL_ID))
        assertEquals("local" to "gpt-x", ChatController.resolveModel(auto, online.defaults))
    }

    @Test
    fun `send while running queues the prompt and shows the queue`() = runTest {
        val caller = FakeCaller { c ->
            when (c.channel) {
                Channels.CHAT_SEND -> CompletableDeferred<JsonElement>().await()
                Channels.CHAT_QUEUE -> session(queue = listOf("next one"))
                else -> JsonNull
            }
        }
        val chat = controller(caller)
        chat.send("first")
        runCurrent()
        chat.send("next one")

        val q = caller.calls.last()
        assertEquals(Channels.CHAT_QUEUE, q.channel)
        assertEquals(listOf(JsonPrimitive(sid), JsonPrimitive("next one")), q.args)
        assertEquals(listOf("next one"), ChatController.project(chat.state.value, online).queued)
        assertEquals(1, caller.channels().count { it == Channels.CHAT_SEND })
    }

    @Test
    fun `send without any model throws and sends nothing`() = runTest {
        val caller = FakeCaller()
        val chat = controller(caller, online.copy(defaults = RemoteDefaults()))
        try {
            chat.send("hi")
            fail("expected an error")
        } catch (e: IllegalStateException) {
            assertEquals("Choose a default model on your computer first.", e.message)
        }
        assertTrue(caller.calls.isEmpty())
        assertFalse(chat.state.value.turn.running)
    }

    @Test
    fun `a failed chat send ends the turn with the error`() = runTest {
        val caller = FakeCaller { c -> if (c.channel == Channels.CHAT_SEND) throw RelayException("connection lost") else JsonNull }
        val chat = controller(caller)
        chat.send("hello")
        runCurrent()
        assertFalse(chat.state.value.turn.running)
        assertEquals("connection lost", ChatController.project(chat.state.value, online).error)
    }

    @Test
    fun `events fold into the live turn and done asks for a reload`() = runTest {
        val chat = controller(FakeCaller())
        assertFalse(chat.onEvent(AgentEvent.Text("other", "nope")))
        assertFalse(chat.onEvent(AgentEvent.Text(sid, "Hel")))
        assertFalse(chat.onEvent(AgentEvent.Text(sid, "lo")))
        val reply = chat.state.value.turn.blocks.single() as Block.Assistant
        assertEquals("Hello", reply.text)
        assertTrue(reply.streaming)
        assertFalse(chat.onEvent(AgentEvent.ApprovalRequired(sid, approval)))
        assertEquals(approval, chat.state.value.turn.approval)
        assertTrue(chat.onEvent(AgentEvent.Done(sid, null)))
        assertTrue(chat.onEvent(AgentEvent.Error(sid, "boom")))
        assertTrue(chat.onEvent(AgentEvent.SessionMeta(sid)))
    }

    @Test
    fun `reload picks up pending approvals and questions`() = runTest {
        val caller = FakeCaller { c ->
            when (c.channel) {
                Channels.SESSION_GET -> session(messages = listOf(msg("u1", "user", "hi"), msg("a1", "assistant", "hey")))
                Channels.CHAT_PENDING -> buildJsonObject {
                    put(sid, buildJsonObject {
                        put("question", buildJsonObject {
                            put("callId", "ask-1"); put("askedAt", 0)
                            put("questions", buildJsonArray {
                                add(buildJsonObject {
                                    put("id", "q1"); put("header", "Scope"); put("question", "Which?")
                                    put("options", buildJsonArray { add(buildJsonObject { put("label", "A") }) })
                                })
                            })
                        })
                    })
                }
                else -> JsonNull
            }
        }
        val chat = controller(caller)
        chat.reload()
        val ui = ChatController.project(chat.state.value, online)
        assertTrue(ui.ready)
        assertEquals("Fix the build", ui.title)
        assertEquals("gpt-x · Mac", ui.subtitle)
        assertEquals(2, ui.blocks.size)
        assertTrue(ui.running)
        assertEquals("ask-1", ui.question?.callId)
        assertNull(ui.approval)
        assertNull(ui.blocked)
    }

    @Test
    fun `reload of a deleted chat says so`() = runTest {
        val chat = controller(FakeCaller { JsonNull })
        chat.reload()
        val ui = ChatController.project(chat.state.value, online)
        assertTrue(ui.ready)
        assertEquals("This chat was deleted on your computer.", ui.error)
    }

    @Test
    fun `approve clears the card and answers the host`() = runTest {
        val caller = FakeCaller()
        val chat = controller(caller)
        chat.onEvent(AgentEvent.ApprovalRequired(sid, approval))
        chat.approve(true)
        assertNull(chat.state.value.turn.approval)
        val c = caller.calls.single()
        assertEquals(Channels.TOOL_APPROVE, c.channel)
        assertEquals(listOf(JsonPrimitive(sid), JsonPrimitive("call-1"), JsonPrimitive(true)), c.args)

        // Nothing pending: nothing sent.
        chat.approve(false)
        assertEquals(1, caller.calls.size)
    }

    @Test
    fun `answer sends the answers as a JSON array`() = runTest {
        val caller = FakeCaller()
        val chat = controller(caller)
        chat.onEvent(AgentEvent.Question(sid, question))
        chat.answer(listOf(AskAnswer("q1", listOf("B"), "and also C")))
        assertNull(chat.state.value.turn.question)
        val c = caller.calls.single()
        assertEquals(Channels.CHAT_ANSWER, c.channel)
        assertEquals(JsonPrimitive(sid), c.args[0])
        assertEquals(JsonPrimitive("ask-1"), c.args[1])
        val a = c.args[2].jsonArray.single().jsonObject
        assertEquals("q1", a["questionId"]!!.jsonPrimitive.content)
        assertEquals(listOf("B"), a["labels"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("and also C", a["note"]!!.jsonPrimitive.content)
    }

    @Test
    fun `stop aborts the session`() = runTest {
        val caller = FakeCaller()
        val chat = controller(caller)
        chat.stop()
        runCurrent()
        assertEquals(Channels.CHAT_ABORT, caller.calls.single().channel)
        assertEquals(listOf(JsonPrimitive(sid)), caller.calls.single().args)
    }

    @Test
    fun `blocked messages follow the connection`() = runTest {
        val st = controller(FakeCaller()).state.value
        fun blocked(env: ChatEnv) = ChatController.project(st, env).blocked
        assertNull(blocked(online))
        assertEquals("This phone is no longer paired.", blocked(online.copy(conn = RelayState.DENIED)))
        assertEquals("This phone is no longer paired.", blocked(online.copy(conn = RelayState.IDLE, denied = DenyReason.REVOKED)))
        assertEquals("Mac is offline.", blocked(online.copy(conn = RelayState.OFFLINE)))
        assertEquals("Mac is reconnecting.", blocked(online.copy(conn = RelayState.CONNECTING)))
        assertEquals(
            "No model chosen for this chat. Set a default model on your computer.",
            blocked(online.copy(defaults = RemoteDefaults())),
        )
    }

    @Test
    fun `usage reports a tokens per second rate`() = runTest {
        val chat = controller(FakeCaller())
        chat.onEvent(AgentEvent.Usage(sid, 200, 4000))
        assertEquals(50.0, ChatController.project(chat.state.value, online).rate!!, 0.001)
    }
}

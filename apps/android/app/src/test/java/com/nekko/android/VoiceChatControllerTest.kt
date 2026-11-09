package com.nekko.android

import com.nekko.android.chat.*
import com.nekko.android.data.Outbox
import com.nekko.protocol.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceChatControllerTest {
    private val online = ChatEnv(conn = RelayState.ONLINE, defaults = RemoteDefaults("p", "m"))
    private fun message(id: String, role: String, content: String) = buildJsonObject { put("id", id); put("role", role); put("content", content) }
    private val old = listOf(message("old-u", "user", "hello"), message("old-a", "assistant", "Old reply"))
    private fun session(fresh: Boolean = false, running: Boolean = false, confirmed: Boolean = true) = buildJsonObject {
        put("id", "s"); if (running) put("activeRun", buildJsonObject { put("id", "run") })
        put("messages", JsonArray(old + if (fresh) listOf(message("u", "user", "hello"), message("a", "assistant", "New reply")) else emptyList()))
        if (fresh && confirmed) put("clientMessageIds", buildJsonArray { add(JsonPrimitive("voice-1")) })
    }
    @Test fun `waits for own request even if idle frames and old reply exist`() = runTest {
        var fresh = false
        val end = CompletableDeferred<JsonElement>()
        val caller = FakeCaller { when (it.channel) {
            Channels.SESSION_GET -> session(fresh)
            Channels.CHAT_SEND -> end.await()
            else -> JsonObject(emptyMap())
        } }
        val chat = ChatController("s", caller, backgroundScope, { online }, newId = { "voice-1" })
        chat.reload()
        val result = async { chat.sendVoice("hello") { true } }; runCurrent()
        assertFalse(result.isCompleted)
        chat.onEvent(AgentEvent.Done("s", "a")); runCurrent()
        assertFalse(result.isCompleted)
        assertEquals(1, caller.channels().count { it == Channels.CHAT_SEND })
        fresh = true; end.complete(JsonNull)
        assertEquals("New reply", result.await())
        assertFalse(caller.channels().contains(Channels.CHAT_QUEUE))
    }
    @Test fun `offline authorization loss and host running are refused before send`() = runTest {
        var env = online; var running = false
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session(running = running) else JsonObject(emptyMap()) }
        val chat = ChatController("s", caller, backgroundScope, { env })
        chat.reload()
        assertTrue(runCatching { chat.sendVoice("hello") { false } }.isFailure)
        env = online.copy(conn = RelayState.OFFLINE)
        assertTrue(runCatching { chat.sendVoice("hello") { true } }.isFailure)
        env = online; running = true
        assertTrue(runCatching { chat.sendVoice("hello") { true } }.isFailure)
        assertFalse(caller.channels().contains(Channels.CHAT_SEND))
    }
    @Test fun `existing typed outbox and fresh pending input refuse a voice send`() = runTest {
        var pending = false
        val caller = FakeCaller { when (it.channel) {
            Channels.SESSION_GET -> session()
            Channels.CHAT_PENDING -> if (pending) WireJson.parseToJsonElement("""{"s":{"question":{"callId":"ask","questions":[],"createdAt":1}}}""") else JsonObject(emptyMap())
            else -> JsonObject(emptyMap())
        } }
        val outbox = Outbox(null, DraftStore(null, backgroundScope), { caller }, { RemoteDefaults() }, backgroundScope)
        val queued = outbox.add("s", "typed draft")
        val chat = ChatController("s", caller, backgroundScope, { online }, outbox = outbox)
        chat.reload()
        assertTrue(runCatching { chat.sendVoice("hello") { true } }.isFailure)
        assertEquals(listOf(queued), outbox.state.value.items)
        outbox.remove(queued.id); pending = true
        assertTrue(runCatching { chat.sendVoice("hello") { true } }.isFailure)
        assertFalse(caller.channels().contains(Channels.CHAT_SEND))
    }
    @Test fun `ambiguous failure and legacy id refusal never retry or add outbox`() = runTest {
        for (error in listOf("Connection lost", "Unknown key: clientMessageId")) {
            val caller = FakeCaller { if (it.channel == Channels.CHAT_SEND) throw RelayException(error) else if (it.channel == Channels.SESSION_GET) session() else JsonObject(emptyMap()) }
            val outbox = Outbox(null, DraftStore(null, backgroundScope), { caller }, { RemoteDefaults() }, backgroundScope)
            val chat = ChatController("s", caller, backgroundScope, { online }, outbox = outbox)
            chat.reload()
            assertTrue(runCatching { chat.sendVoice("hello") { true } }.isFailure)
            assertEquals(1, caller.channels().count { it == Channels.CHAT_SEND })
            assertTrue(outbox.state.value.items.isEmpty())
        }
    }
    @Test fun `lock while request awaits cancels local wait without abort or resend`() = runTest {
        val end = CompletableDeferred<JsonElement>()
        val caller = FakeCaller { if (it.channel == Channels.CHAT_SEND) end.await() else if (it.channel == Channels.SESSION_GET) session() else JsonObject(emptyMap()) }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        val result = async { chat.sendVoice("hello") { true } }; runCurrent()
        result.cancel(); runCurrent()
        assertTrue(result.isCancelled)
        assertFalse(caller.channels().contains(Channels.CHAT_ABORT))
        assertEquals(1, caller.channels().count { it == Channels.CHAT_SEND })
    }
    @Test fun `authorization rechecked after completion and unconfirmed cached reply rejected`() = runTest {
        var allowed = true
        val caller = FakeCaller { when (it.channel) {
            Channels.SESSION_GET -> session()
            Channels.CHAT_SEND -> { allowed = false; JsonNull }
            else -> JsonObject(emptyMap())
        } }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        assertTrue(runCatching { chat.sendVoice("hello") { allowed } }.isFailure)
        assertEquals(1, caller.channels().count { it == Channels.CHAT_SEND })
    }
    @Test fun `go ahead is bound to raw current question and never substitutes a newer call`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonObject(emptyMap()) }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        chat.onEvent(AgentEvent.Question("s", AskRequest("old", emptyList(), 0)))
        chat.onEvent(AgentEvent.Question("s", AskRequest("new", listOf(AskQuestion("q", "", "Continue?", emptyList(), false)), 1)))
        assertTrue(runCatching { chat.answerVoice("old", "Go ahead") { true } }.isFailure)
        assertTrue(runCatching { chat.answerVoice("new", "Go ahead") { false } }.isFailure)
        assertFalse(caller.channels().contains(Channels.CHAT_ANSWER))
        chat.answerVoice("new", "Go ahead") { true }
        val answer = caller.calls.single { it.channel == Channels.CHAT_ANSWER }
        assertEquals(JsonPrimitive("new"), answer.args[1])
        assertEquals("Go ahead", answer.args[2].jsonArray.single().jsonObject["note"]!!.jsonPrimitive.content)
    }
    @Test fun `question event during request stops without waiting for a Done event`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.CHAT_SEND) awaitCancellation() else if (it.channel == Channels.SESSION_GET) session() else JsonObject(emptyMap()) }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        val result = async { runCatching { chat.sendVoice("hello") { true } } }; runCurrent()
        chat.onEvent(AgentEvent.Question("s", AskRequest("ask", emptyList(), 0)))
        runCurrent()
        assertTrue(result.await().isFailure)
        assertFalse(caller.channels().contains(Channels.CHAT_ABORT))
    }
}

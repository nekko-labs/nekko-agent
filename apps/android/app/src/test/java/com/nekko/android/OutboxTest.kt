package com.nekko.android

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.data.NewChatSpec
import com.nekko.android.data.Outbox
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Channels
import com.nekko.protocol.DraftStore
import com.nekko.protocol.OfflineFiles
import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class OutboxTest {
    private class Files : OfflineFiles {
        val map = HashMap<String, JsonElement>()
        override fun load(computerId: String, name: String) = map["$computerId/$name"]
        override fun save(computerId: String, name: String, value: JsonElement) { map["$computerId/$name"] = value }
        override fun remove(computerId: String) { map.keys.removeAll { it.startsWith("$computerId/") } }
    }

    /** A computer as the phone gate answers it: chats with the prompt ids they took, running or not. */
    private class Computer {
        val ids = HashMap<String, MutableList<String>>()
        val running = HashSet<String>()
        val deleted = HashSet<String>()
        var created = 0
        var oldComputer = false
        /** chat:send is answered without taking the prompt (the computer turned it down). */
        var refuseSend = false
        var dropped = false
        var raiseNeedsProof = false
        val options = ArrayList<JsonObject>()

        private fun session(id: String) = buildJsonObject {
            put("id", id)
            put("messages", JsonArray(emptyList()))
            put("clientMessageIds", JsonArray(ids[id].orEmpty().map(::JsonPrimitive)))
            if (id in running) put("activeRun", buildJsonObject { put("id", "run") })
        }

        val caller = FakeCaller { c ->
            if (dropped) throw RelayException("${c.channel}: timed out", afterSend = true)
            when (c.channel) {
                Channels.SESSION_CREATE -> { created++; buildJsonObject { put("id", "made-$created"); put("messages", JsonArray(emptyList())) } }
                Channels.SESSION_SET_OPTIONS -> {
                    val o = c.args[1].jsonObject
                    if (raiseNeedsProof && "mode" in o) throw RelayException("Not allowed from a paired phone (proof-required): session:setOptions", PhoneRefusal("proof-required", "session:setOptions"))
                    options += o
                    JsonNull
                }
                Channels.SESSION_GET -> {
                    val id = c.args[0].jsonPrimitive.content
                    if (id in deleted) JsonNull else session(id)
                }
                Channels.CHAT_QUEUE -> {
                    val id = c.args[0].jsonPrimitive.content
                    ids.getOrPut(id) { mutableListOf() } += c.args[1].jsonObject["clientMessageId"]!!.jsonPrimitive.content
                    session(id)
                }
                Channels.CHAT_SEND -> {
                    val o = c.args[0].jsonObject
                    if (oldComputer && "clientMessageId" in o) throw RelayException("Not allowed from a paired phone (option-denied): clientMessageId", PhoneRefusal("option-denied", "clientMessageId"))
                    if (!refuseSend) ids.getOrPut(o["sessionId"]!!.jsonPrimitive.content) { mutableListOf() } += o["clientMessageId"]!!.jsonPrimitive.content
                    JsonNull
                }
                else -> JsonNull
            }
        }
    }

    private class Rig(val outbox: Outbox, val drafts: DraftStore, val files: Files, val computer: Computer)

    private fun TestScope.rig(online: () -> Boolean = { true }): Rig {
        val files = Files()
        val computer = Computer()
        val drafts = DraftStore(files, backgroundScope, debounceMs = 0)
        drafts.load("c1")
        var n = 0
        val outbox = Outbox(
            files, drafts, caller = { computer.caller.takeIf { online() } }, defaults = { RemoteDefaults("openai", "gpt-x") },
            scope = backgroundScope, newId = { "id-${++n}" }, now = { 7L }, pollMs = 10, confirmTimeoutMs = 100,
        )
        outbox.load("c1")
        return Rig(outbox, drafts, files, computer)
    }

    @Test
    fun `a prompt is on disk the moment it is added, and comes back after a restart`() = runTest {
        val r = rig()
        r.outbox.add("s1", "written on the train")
        val again = Outbox(r.files, r.drafts, { null }, { RemoteDefaults() }, backgroundScope)
        again.load("c1")
        assertEquals(listOf("written on the train"), again.state.value.waiting.map { it.text })
    }

    @Test
    fun `prompts go in order, each once, and leave when the chat lists them`() = runTest {
        val r = rig()
        r.outbox.add("s1", "first")
        r.outbox.add("s1", "second")
        r.outbox.flush()
        assertEquals(listOf("id-1", "id-2"), r.computer.ids["s1"])
        assertTrue(r.outbox.state.value.items.isEmpty())
        val sends = r.computer.caller.calls.filter { it.channel == Channels.CHAT_SEND }
        assertEquals(listOf("first", "second"), sends.map { it.args[0].jsonObject["text"]!!.jsonPrimitive.content })
    }

    @Test
    fun `a prompt the computer already has (the answer was lost) is not sent again`() = runTest {
        val r = rig()
        r.outbox.add("s1", "once")
        r.computer.ids["s1"] = mutableListOf("id-1")
        r.outbox.flush()
        assertTrue(r.computer.caller.calls.none { it.channel == Channels.CHAT_SEND })
        assertTrue(r.outbox.state.value.items.isEmpty())
    }

    @Test
    fun `a running chat gets the prompt in its queue`() = runTest {
        val r = rig()
        r.computer.running += "s1"
        r.outbox.add("s1", "after this one")
        r.outbox.flush()
        assertEquals(Channels.CHAT_QUEUE, r.computer.caller.calls.last().channel)
        assertTrue(r.outbox.state.value.items.isEmpty())
    }

    @Test
    fun `a refused prompt goes back to its draft with the computer's reason`() = runTest {
        val r = rig()
        r.drafts.set("s1", com.nekko.protocol.Draft("typed since"))
        r.outbox.add("s1", "the prompt")
        r.computer.refuseSend = true
        // The computer's error event comes while the send is answered.
        r.computer.caller.handler.let { h ->
            r.computer.caller.handler = { c -> h(c).also { if (c.channel == Channels.CHAT_SEND) r.outbox.onEvent(AgentEvent.Error("s1", "No API key for OpenAI")) } }
        }
        r.outbox.flush()
        assertTrue(r.outbox.state.value.items.isEmpty())
        val d = r.drafts.draft("s1")
        assertEquals("the prompt\n\ntyped since", d.text)
        assertEquals("No API key for OpenAI", d.refusal)
    }

    @Test
    fun `a deleted chat refuses, an older computer asks for an update`() = runTest {
        val r = rig()
        r.computer.deleted += "gone"
        r.outbox.add("gone", "hello?")
        r.outbox.flush()
        assertEquals("This chat was deleted on your computer.", r.drafts.draft("gone").refusal)

        r.computer.oldComputer = true
        r.outbox.add("s1", "needs the id")
        r.outbox.flush()
        assertEquals(Outbox.NEEDS_UPDATE, r.drafts.draft("s1").refusal)
        assertEquals("never sent without its id", 1, r.computer.caller.calls.count { it.channel == Channels.CHAT_SEND })
    }

    @Test
    fun `a dropped connection keeps the prompt, says why, and stops`() = runTest {
        val r = rig()
        r.outbox.add("s1", "one")
        r.outbox.add("s1", "two")
        r.computer.dropped = true
        r.outbox.flush()
        val waiting = r.outbox.state.value.waiting
        assertEquals(2, waiting.size)
        assertEquals("session:get: timed out", waiting[0].lastError)
        assertNull("the next one waits its turn", waiting[1].lastError)
        r.computer.dropped = false
        r.outbox.flush()
        assertTrue(r.outbox.state.value.items.isEmpty())
    }

    @Test
    fun `nothing goes while the computer is out of reach`() = runTest {
        var online = false
        val r = rig { online }
        r.outbox.add("s1", "later")
        r.outbox.flush()
        assertTrue(r.computer.caller.calls.isEmpty())
        online = true
        r.outbox.flush()
        assertTrue(r.outbox.state.value.items.isEmpty())
    }

    @Test
    fun `a chat started offline is created once, with its model, and its draft follows`() = runTest {
        val r = rig()
        val first = r.outbox.add(null, "start this", newChat = NewChatSpec("anthropic", "claude", workspaceId = "w1", mode = "yolo"))
        // What was typed in the waiting chat's box since.
        r.drafts.set(first.chatKey, com.nekko.protocol.Draft("more for the new chat"))
        r.computer.raiseNeedsProof = true
        r.outbox.flush()
        assertEquals(1, r.computer.created)
        assertEquals(listOf("anthropic", "claude"), r.computer.options.single().let { listOf(it["providerId"]!!.jsonPrimitive.content, it["modelId"]!!.jsonPrimitive.content) })
        assertFalse("sent under the default mode", "mode" in r.computer.options.single())
        assertEquals(listOf("id-1"), r.computer.ids["made-1"])
        assertEquals("made-1", r.outbox.state.value.created[first.chatKey])
        assertEquals("more for the new chat", r.drafts.draft("made-1").text)
    }

    @Test
    fun `edit takes a prompt back into its box, delete drops it, neither while it is sending`() = runTest {
        val r = rig()
        val a = r.outbox.add("s1", "edit me")
        val b = r.outbox.add("s1", "delete me")
        val c = r.outbox.add("s1", "the open chat sends this", direct = true)
        assertEquals(listOf(a.id, b.id), r.outbox.state.value.waiting.map { it.id })
        assertEquals("s1", r.outbox.takeBack(a.id))
        assertEquals("edit me", r.drafts.draft("s1").text)
        assertTrue(r.outbox.remove(b.id))
        assertFalse(r.outbox.remove(c.id))
        r.outbox.endDirect(c.id)
        assertEquals(listOf(c.id), r.outbox.state.value.waiting.map { it.id })
    }

    // ---- the chat's send through the outbox ----

    @Test
    fun `offline, Send puts the prompt in the outbox and nothing is called`() = runTest {
        val r = rig { false }
        val chat = ChatController("s1", r.computer.caller, backgroundScope, { ChatEnv(RelayState.OFFLINE, null, RemoteDefaults("p", "m"), "Mac", canQueue = true) }, outbox = r.outbox)
        chat.send("from the plane")
        assertEquals(listOf("from the plane"), r.outbox.state.value.waitingFor("s1").map { it.text })
        assertTrue(r.computer.caller.calls.isEmpty())
        assertNull("no live bubble: it shows as waiting", chat.state.value.turn.blocks.firstOrNull())
    }

    @Test
    fun `online, a send that gets no answer is handed to the outbox with the same id`() = runTest {
        val r = rig()
        val turnEnd = CompletableDeferred<JsonElement>()
        r.computer.caller.handler = { c -> if (c.channel == Channels.CHAT_SEND) turnEnd.await() else JsonNull }
        val chat = ChatController("s1", r.computer.caller, backgroundScope, { ChatEnv(RelayState.ONLINE, null, RemoteDefaults("p", "m"), "Mac", canQueue = true) }, outbox = r.outbox)
        chat.send("hello")
        runCurrent()
        assertTrue("on disk, not shown as waiting", r.outbox.state.value.waiting.isEmpty())
        assertEquals(1, r.outbox.state.value.items.size)
        turnEnd.completeExceptionally(RelayException("chat:send: timed out", afterSend = true))
        runCurrent()
        assertEquals(listOf("id-1"), r.outbox.state.value.waiting.map { it.id })
        assertFalse(chat.state.value.turn.running)
    }

    @Test
    fun `online, a send the computer refuses leaves the outbox and the box gets it back`() = runTest {
        val r = rig()
        r.computer.caller.handler = { c -> if (c.channel == Channels.CHAT_SEND) throw RelayException("No such model", fromComputer = true) else JsonNull }
        val chat = ChatController("s1", r.computer.caller, backgroundScope, { ChatEnv(RelayState.ONLINE, null, RemoteDefaults("p", "m"), "Mac", canQueue = true) }, outbox = r.outbox)
        chat.send("hello")
        runCurrent()
        assertTrue(r.outbox.state.value.items.isEmpty())
        assertEquals("No such model", chat.state.value.turn.error)
    }

    @Test
    fun `offline the box is not blocked, and says the prompt will wait`() {
        val ui = ChatController.project(com.nekko.android.chat.ChatState(), ChatEnv(RelayState.OFFLINE, null, RemoteDefaults(), "Mac", canQueue = true))
        assertNull(ui.blocked)
        assertEquals("Mac is offline. What you send waits on this phone and goes when it’s back.", ui.sendsLater)
        val unpaired = ChatController.project(com.nekko.android.chat.ChatState(), ChatEnv(RelayState.DENIED, null, RemoteDefaults(), "Mac", canQueue = true))
        assertEquals("This phone is no longer paired.", unpaired.blocked)
    }
}

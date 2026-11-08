package com.nekko.android

import com.nekko.android.chat.*
import com.nekko.android.data.Outbox
import com.nekko.protocol.*
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ImageChatControllerTest {
    private fun session(cfg: Double = 4.0) = buildJsonObject {
        put("id", "s"); put("chatType", "image"); put("imageParams", buildJsonObject { put("modelId", "flux"); put("cfgScale", cfg) })
    }
    private val online = ChatEnv(conn = RelayState.ONLINE, imageGeneration = true, canQueue = true)

    @Test fun `image sends exact request through Change callback never text queue or outbox`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val requests = mutableListOf<JsonElement>()
        val end = CompletableDeferred<JsonElement>()
        val chat = ChatController("s", caller, backgroundScope, { online }, generateImage = { requests += it; end.await() })
        chat.reload()
        val job = backgroundScope.launch { chat.send("Paint a cat") }
        runCurrent()
        assertTrue(chat.state.value.turn.running)
        assertEquals(ImageChatParams("flux").generation("s", "Paint a cat"), requests.single())
        assertFalse(caller.channels().any { it in listOf(Channels.CHAT_SEND, Channels.CHAT_QUEUE) })
        assertTrue(runCatching { chat.send("another") }.isFailure)
        end.complete(JsonNull); runCurrent(); job.join()
        assertFalse(chat.state.value.turn.running)
    }

    @Test fun `offline image send refuses without creating a text outbox item`() = runTest {
        var env = online
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val ob = Outbox(null, DraftStore(null, backgroundScope), { caller }, { RemoteDefaults() }, backgroundScope)
        val chat = ChatController("s", caller, backgroundScope, { env }, outbox = ob, generateImage = { error("must not send") })
        chat.reload(); env = online.copy(conn = RelayState.OFFLINE)
        assertTrue(runCatching { chat.send("cat") }.isFailure)
        assertTrue(ob.state.value.items.isEmpty())
        assertNotNull(ChatController.project(chat.state.value, env).blocked)
        assertNull(ChatController.project(chat.state.value, env).sendsLater)
    }

    @Test fun `unsupported capability attachments fractional params and missing authorization fail before any generation`() = runTest {
        var s = session()
        var env = online
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) s else JsonNull }
        var generated = 0
        val chat = ChatController("s", caller, backgroundScope, { env }, generateImage = { generated++; JsonNull })
        chat.reload()
        assertTrue(runCatching { chat.send("cat", images = listOf("data:image/png;base64,AA==")) }.isFailure)
        assertTrue(runCatching { chat.send("cat", skill = SkillSummary("skill", "", "", "builtin")) }.isFailure)
        assertTrue(runCatching { chat.send(" ") }.isFailure)
        env = online.copy(imageGeneration = false)
        assertTrue(runCatching { chat.send("cat") }.isFailure)
        env = online; s = session(4.5); chat.reload()
        assertTrue(runCatching { chat.send("cat") }.isFailure)
        assertEquals(4.5, ChatController.project(chat.state.value, online).imageParams!!.cfgScale, 0.0)
        assertEquals(0, generated)
        s = session()
        val unsigned = ChatController("s", caller, backgroundScope, { online })
        unsigned.reload()
        assertTrue(runCatching { unsigned.send("cat") }.exceptionOrNull()?.message.orEmpty().contains("authorize"))
        assertFalse(caller.channels().contains(Channels.CHAT_GENERATE_IMAGE))
    }

    @Test fun `authorization cancel or ambiguous disconnect throws and never retries or queues`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        var n = 0
        val chat = ChatController("s", caller, backgroundScope, { online }, generateImage = { n++; throw RelayException("Connection lost: check the transcript before retrying.") })
        chat.reload()
        assertTrue(runCatching { chat.send("cat") }.isFailure)
        runCurrent()
        assertEquals(1, n)
        assertFalse(chat.state.value.turn.running)
        assertNotNull(ChatController.project(chat.state.value, online).error)
        assertFalse(caller.channels().contains(Channels.CHAT_SEND))
    }

    @Test fun `attachment-only replies remain visible with Simple steps folded`() {
        val reply = Block.Assistant("reply", "", reasoning = "Rendering", thumbs = listOf(""))
        val rows = TurnSteps.fold(listOf<Block>(Block.User("u", "cat"), reply), { it }, { it.id }, running = false, open = emptySet())
        assertTrue(rows.any { it is TurnSteps.Row.Summary })
        assertTrue(rows.any { it is TurnSteps.Row.Item && it.item == reply })
    }

    @Test fun `stale text outbox item cannot be replayed into a chat converted to image`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val drafts = DraftStore(null, backgroundScope)
        val outbox = Outbox(null, drafts, { caller }, { RemoteDefaults() }, backgroundScope)
        outbox.add("s", "Keep image intent")
        outbox.flush()
        assertTrue(outbox.state.value.items.isEmpty())
        assertEquals("Keep image intent", drafts.draft("s").text)
        assertTrue(drafts.draft("s").refusal.orEmpty().contains("text outbox"))
        assertFalse(caller.channels().any { it in listOf(Channels.CHAT_SEND, Channels.CHAT_QUEUE, Channels.CHAT_GENERATE_IMAGE) })
    }

    @Test fun `error event followed by successful null RPC still fails and keeps send reserved`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val end = CompletableDeferred<JsonElement>()
        var requests = 0
        val chat = ChatController("s", caller, backgroundScope, { online }, generateImage = { requests++; end.await() })
        chat.reload()
        val send = backgroundScope.async { runCatching { chat.send("Keep this prompt") } }
        runCurrent()
        chat.onEvent(AgentEvent.Error("other", "Not our error"))
        chat.onEvent(AgentEvent.Error("s", "Diffusion runtime failed"))
        val duplicate = backgroundScope.async { runCatching { chat.send("duplicate before RPC ends") } }
        runCurrent()
        end.complete(JsonNull)
        runCurrent()
        assertTrue(duplicate.await().isFailure)
        assertEquals("Diffusion runtime failed", send.await().exceptionOrNull()?.message)
        assertEquals(1, requests)
        assertFalse(chat.state.value.turn.running)
        assertEquals("Diffusion runtime failed", chat.state.value.turn.error)
        assertFalse(caller.channels().any { it in listOf(Channels.CHAT_SEND, Channels.CHAT_QUEUE) })
    }

    @Test fun `host error arriving during post RPC reload still refuses completion`() = runTest {
        var completedRpc = false
        lateinit var chat: ChatController
        val caller = FakeCaller {
            if (it.channel == Channels.SESSION_GET) {
                if (completedRpc) chat.onEvent(AgentEvent.Error("s", "Runtime failed after reply"))
                session()
            } else JsonNull
        }
        chat = ChatController("s", caller, backgroundScope, { online }, generateImage = { completedRpc = true; JsonNull })
        chat.reload()
        assertEquals("Runtime failed after reply", runCatching { chat.send("cat") }.exceptionOrNull()?.message)
        assertFalse(chat.state.value.turn.running)
    }

    @Test fun `stop during suspended signing cannot dispatch a late image`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val gate = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        val software = SoftwareChangeSigner.generate()
        val signer = object : ChangeSigner {
            override suspend fun publicKey() = software.publicKey()
            override suspend fun sign(message: ByteArray): ByteArray {
                if (message.toString(Charsets.UTF_8).contains("\nchat:generateImage\n")) {
                    entered.complete(Unit)
                    // A system authentication prompt may finish even after its request was cancelled.
                    kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { gate.await() }
                }
                return software.sign(message)
            }
        }
        val remote = FakeRemote(RelayConfig("wss://relay.example.dev", "room", "key", ByteArray(32), TEST_HOST_KEY, "phone-1", "Pixel Test")) { JsonNull }
        val changes = com.nekko.android.security.ChangeCalls(remote, signer, "phone-1", "Studio")
        val chat = ChatController("s", caller, backgroundScope, { online }, generateImage = {
            changes.call(Channels.CHAT_GENERATE_IMAGE, listOf(it), timeoutMs = TURN_TIMEOUT_MS)
        })
        chat.reload()
        val send = backgroundScope.async { runCatching { chat.send("cat") } }
        runCurrent()
        assertTrue(entered.isCompleted)
        chat.stop()
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertTrue(send.await().isFailure)
        assertFalse(chat.state.value.turn.running)
        assertFalse(remote.channels().contains(Channels.CHAT_GENERATE_IMAGE))
        assertEquals(listOf(JsonPrimitive("s")), caller.calls.single { it.channel == Channels.CHAT_ABORT }.args)
    }

    @Test fun `cancelled authorization clears reservation and never sends or queues`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        var attempts = 0
        val chat = ChatController("s", caller, backgroundScope, { online }, generateImage = {
            attempts++
            throw kotlinx.coroutines.CancellationException("Not confirmed")
        })
        chat.reload()
        repeat(2) {
            val send = backgroundScope.async { runCatching { chat.send("cat") } }
            runCurrent()
            assertTrue(send.await().exceptionOrNull() is kotlinx.coroutines.CancellationException)
            assertFalse(chat.state.value.turn.running)
        }
        assertEquals(2, attempts)
        assertFalse(caller.channels().any { it in listOf(Channels.CHAT_SEND, Channels.CHAT_QUEUE, Channels.CHAT_GENERATE_IMAGE) })
    }

    @Test fun `desktop image status exposes Stop and blocks another generation`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val chat = ChatController("s", caller, backgroundScope, { online }, generateImage = { error("must not generate") })
        chat.reload()
        val status = AgentEvent.from(WireJson.parseToJsonElement("""{"type":"image_status","sessionId":"s","stage":"loading"}"""))!!
        chat.onEvent(status)
        assertTrue(ChatController.project(chat.state.value, online).running)
        assertTrue(runCatching { chat.send("cat") }.isFailure)
        chat.stop(); runCurrent()
        assertTrue(caller.channels().contains(Channels.CHAT_ABORT))
        chat.onEvent(AgentEvent.Done("s", null))
        assertFalse(ChatController.project(chat.state.value, online).running)
    }

    @Test fun `reopening image uses only positive monitor running evidence`() = runTest {
        var monitor: JsonElement = WireJson.parseToJsonElement("""{"running":[{"id":"s","step":"working"}]}""")
        val caller = FakeCaller {
            when (it.channel) {
                Channels.SESSION_GET -> session()
                Channels.MONITOR_SUMMARY -> monitor
                else -> JsonNull
            }
        }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        assertTrue(ChatController.project(chat.state.value, online).running)
        // A full capped list which omits this chat must not clear a known running turn.
        monitor = buildJsonObject { put("running", JsonArray((1..20).map { buildJsonObject { put("id", "other-$it") } })) }
        chat.reload()
        assertTrue(chat.state.value.turn.running)
        monitor = WireJson.parseToJsonElement("""{"running":[]}""")
        chat.reload()
        assertTrue(chat.state.value.turn.running)
        chat.onEvent(AgentEvent.Done("s", null))
        chat.reload()
        assertFalse(chat.state.value.turn.running)
        assertFalse(caller.channels().contains("chat:running"))
    }

    @Test fun `monitor failure preserves running and never prevents transcript reload`() = runTest {
        val caller = FakeCaller {
            when (it.channel) {
                Channels.SESSION_GET -> session()
                Channels.MONITOR_SUMMARY -> throw RelayException("Not supported")
                else -> JsonNull
            }
        }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        assertNotNull(chat.state.value.session)
        assertNull(chat.state.value.loadError)
        chat.onEvent(AgentEvent.Other("s", "image_status"))
        chat.reload()
        assertTrue(chat.state.value.turn.running)
        assertNull(chat.state.value.loadError)
    }

    @Test fun `stale monitor cannot override newer image start or end events`() = runTest {
        for (running in listOf(true, false)) {
            val gate = CompletableDeferred<JsonElement>()
            val caller = FakeCaller {
                when (it.channel) {
                    Channels.SESSION_GET -> session()
                    Channels.MONITOR_SUMMARY -> gate.await()
                    else -> JsonNull
                }
            }
            val chat = ChatController("s", caller, backgroundScope, { online })
            val read = backgroundScope.launch { chat.reload() }
            runCurrent()
            assertTrue(caller.channels().contains(Channels.MONITOR_SUMMARY))
            chat.onEvent(if (running) AgentEvent.Other("s", "image_status") else AgentEvent.Done("s", null))
            gate.complete(WireJson.parseToJsonElement(if (running) """{"running":[]}""" else """{"running":[{"id":"s"}]}"""))
            runCurrent(); read.join()
            assertEquals(running, chat.state.value.turn.running)
        }
    }

    @Test fun `image settings save only image options and cannot send while changing offline`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        val params = ImageChatParams("flux", width = 768.0)
        chat.setImageParams(params)
        assertEquals(listOf(JsonPrimitive("s"), params.sessionOptions()), caller.calls.single { it.channel == Channels.SESSION_SET_OPTIONS }.args)
    }
}

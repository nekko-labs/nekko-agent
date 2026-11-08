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

    @Test fun `missing saved image settings refuse explicitly without inventing fractional defaults`() = runTest {
        val missing = buildJsonObject { put("id", "s"); put("chatType", "image") }
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) missing else JsonNull }
        var generated = 0
        val chat = ChatController("s", caller, backgroundScope, { online }, generateImage = { generated++; JsonNull })
        chat.reload()
        assertEquals("Choose and save image settings before generating.", runCatching { chat.send("Keep this prompt") }.exceptionOrNull()?.message)
        assertEquals(0, generated)
        assertFalse(chat.state.value.turn.running)
        assertNull(ChatController.project(chat.state.value, online).imageParams)
        assertFalse(caller.channels().any { it in listOf(Channels.CHAT_SEND, Channels.CHAT_QUEUE, Channels.CHAT_GENERATE_IMAGE) })
        assertEquals(4.0, ImageChatParams().cfgScale, 0.0)
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
        // Photos to edit: PNG, JPEG or WebP data URLs only, at most 4.
        assertTrue(runCatching { chat.send("cat", images = listOf("data:image/gif;base64,R0lG")) }.isFailure)
        assertTrue(runCatching { chat.send("cat", images = List(5) { "data:image/png;base64,AA==" }) }.isFailure)
        val big = "data:image/jpeg;base64," + "A".repeat(PhotoEdit.MAX_TOTAL_CHARS / 2)
        assertEquals(PhotoEdit.TOO_LARGE, runCatching { chat.send("cat", images = listOf(big, big)) }.exceptionOrNull()?.message)
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

    // ---- photo editing (#2230, decision 0069) ----

    /** A 1920×1080 PNG header: enough for the edit size. */
    private val landscape = "data:image/png;base64," + java.util.Base64.getEncoder().encodeToString(byteArrayOf(
        0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        0, 0, 0x07, 0x80.toByte(), 0, 0, 0x04, 0x38, 8, 2, 0, 0, 0))

    @Test fun `photos go inside the one signed generate request with the edit size and never through text send`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val requests = mutableListOf<JsonElement>()
        val chat = ChatController("s", caller, backgroundScope, { online }, generateImage = { requests += it; JsonNull })
        chat.reload()
        chat.send("Make it night", images = listOf(landscape, "data:image/jpeg;base64,/9j/"))
        val request = requests.single().jsonObject
        assertEquals(ImageChatParams("flux").generation("s", "Make it night", listOf(landscape, "data:image/jpeg;base64,/9j/")), request)
        assertEquals(2, request["images"]!!.jsonArray.size)
        assertEquals(buildJsonObject { put("width", 1344); put("height", 768) }, request["size"])
        assertFalse(caller.channels().any { it in listOf(Channels.CHAT_SEND, Channels.CHAT_QUEUE) })
        // Without photos neither key goes.
        chat.send("A new one")
        assertEquals(setOf("sessionId", "prompt", "params"), requests.last().jsonObject.keys)
    }

    @Test fun `photos to edit are signed by the Change proof with the request`() = runTest {
        val signer = SoftwareChangeSigner.generate()
        val remote = FakeRemote(RelayConfig("wss://relay.example.dev", "room", "key", ByteArray(32), TEST_HOST_KEY, "phone-1", "Pixel Test")) { JsonNull }
        val changes = com.nekko.android.security.ChangeCalls(remote, signer, "phone-1", "Studio")
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val chat = ChatController("s", caller, backgroundScope, { online }, generateImage = {
            changes.call(Channels.CHAT_GENERATE_IMAGE, listOf(it), timeoutMs = TURN_TIMEOUT_MS)
        })
        chat.reload()
        chat.send("Make it night", images = listOf(landscape))
        val sent = remote.calls.single { it.channel == Channels.CHAT_GENERATE_IMAGE }
        assertEquals(listOf(landscape), sent.args.single().jsonObject["images"]!!.jsonArray.map { it.jsonPrimitive.content })
        val proof = sent.proof!!
        val payload = ChangeProof.payload("phone-1", Channels.CHAT_GENERATE_IMAGE, JsonArray(sent.args), proof["ts"]!!.jsonPrimitive.long)
        assertTrue(ChangeProof.verify(signer.publicKey(), payload, java.util.Base64.getDecoder().decode(proof["sig"]!!.jsonPrimitive.content)))
    }

    private fun madeSession(generated: String) = WireJson.parseToJsonElement(
        """{"id":"s","chatType":"image","imageParams":{"modelId":"flux","cfgScale":4},"messages":[
           {"id":"u","role":"user","content":"cat","images":["data:image/jpeg;base64,/9j/"]},
           {"id":"a","role":"assistant","content":"","images":["data:image/png;base64,THUMB"],"generated":$generated}]}""",
    )

    @Test fun `Edit shows only under a made picture of a live image chat`() = runTest {
        var s = madeSession("""{"modelId":"flux","width":1024,"height":1024,"seed":7,"ms":900}""")
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) s else JsonNull }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        val ui = ChatController.project(chat.state.value, online)
        val (prompt, reply) = ui.blocks
        assertTrue(ChatController.canEdit(reply, ui))
        assertFalse(ChatController.canEdit(prompt, ui))
        // The phone's read-only saved copy offers no Edit.
        assertFalse(ChatController.canEdit(reply, ui.copy(savedAt = 1L)))
        // An ordinary chat never does, even for a reply that says it was generated.
        assertFalse(ChatController.canEdit(reply, ui.copy(chatType = null)))
        // A clip from a video model is not offered for editing.
        s = madeSession("""{"modelId":"wan","video":{"frames":33,"fps":16}}""")
        chat.reload()
        val clip = ChatController.project(chat.state.value, online)
        assertFalse(ChatController.canEdit(clip.blocks.last(), clip))
    }

    @Test fun `Edit takes the full-size picture and falls back to the thumbnail`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) madeSession("""{"modelId":"flux"}""") else JsonNull }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        assertEquals("data:image/png;base64,FULL", chat.pictureToEdit("a", 0) { "data:image/png;base64,FULL" })
        assertEquals("data:image/png;base64,THUMB", chat.pictureToEdit("a", 0) { null })
        assertEquals("data:image/png;base64,THUMB", chat.pictureToEdit("a", 0) { throw RelayException("offline") })
        assertEquals(ChatController.PICTURE_NOT_SENT, runCatching { chat.pictureToEdit("a", 3) { null } }.exceptionOrNull()?.message)
        // Edit only fills the message box: nothing is generated or sent.
        assertFalse(caller.channels().any { it in listOf(Channels.CHAT_SEND, Channels.CHAT_QUEUE, Channels.CHAT_GENERATE_IMAGE) })
    }
}

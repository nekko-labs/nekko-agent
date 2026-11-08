package com.nekko.android

import com.nekko.android.chat.*
import com.nekko.android.data.Outbox
import com.nekko.protocol.*
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

    @Test fun `image settings save only image options and cannot send while changing offline`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.SESSION_GET) session() else JsonNull }
        val chat = ChatController("s", caller, backgroundScope, { online })
        chat.reload()
        val params = ImageChatParams("flux", width = 768.0)
        chat.setImageParams(params)
        assertEquals(listOf(JsonPrimitive("s"), params.sessionOptions()), caller.calls.single { it.channel == Channels.SESSION_SET_OPTIONS }.args)
    }
}

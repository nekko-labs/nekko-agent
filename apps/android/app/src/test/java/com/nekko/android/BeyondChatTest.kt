package com.nekko.android

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.chat.SkillMenu
import com.nekko.protocol.Block
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.SavedPrompt
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** AN-29: the queue editor, fork and saved prompts, with the iPhone's BeyondTests data. */
@OptIn(ExperimentalCoroutinesApi::class)
class BeyondChatTest {
    private var queue = mutableListOf<JsonElement>(
        JsonPrimitive("first"),
        Json.parseToJsonElement("""{"text":"with a photo","images":[""]}"""),
        Json.parseToJsonElement("""{"text":"Review.\n\nnow","skill":{"name":"review","input":"now"}}"""),
    )

    private fun session() = Json.parseToJsonElement("""
        {"id":"s1","title":"Fix it","providerId":"p","modelId":"m","queue":${JsonArray(queue)},
         "messages":[
           {"id":"u1","role":"user","content":"Find the bug"},
           {"id":"a1","role":"assistant","content":"Found it.","toolCalls":[{"id":"c1","name":"bash","input":{"command":"ls"}}]},
           {"id":"t1","role":"tool","content":"","toolResult":{"toolCallId":"c1","output":"ok"}},
           {"id":"u2","role":"user","content":"","skill":{"name":"review","input":"it"}},
           {"id":"a2","role":"assistant","content":"Looks good."}]}
    """)

    private fun computer() = FakeCaller { c ->
        when (c.channel) {
            Channels.SESSION_GET -> session()
            Channels.CHAT_EDIT_QUEUED -> {
                // Like the computer: only while the prompt still reads what the phone showed.
                val edit = c.args[2].jsonObject
                val shown = (queue.firstOrNull() as? JsonPrimitive)?.content
                if (c.args[1].jsonPrimitive.content != "0" || edit["expect"]?.jsonPrimitive?.content != shown) {
                    throw RelayException("Not allowed from a paired phone (value-invalid): That queued prompt already started or changed.")
                }
                val text = edit["text"]?.jsonPrimitive?.content
                if (text != null) queue[0] = JsonPrimitive(text) else queue.removeAt(0)
                buildJsonObject { put("id", "s1") }
            }
            Channels.CHAT_STEER -> {
                if (refuseSteer) throw RelayException("Not allowed from a paired phone (channel-denied): chat:steer", fromComputer = true)
                session()
            }
            Channels.CHAT_QUEUE -> {
                queue.add(c.args[1])
                session()
            }
            Channels.CHAT_INTERRUPT_QUEUED -> {
                if (interruptTimesOut) throw RelayException("chat:interruptQueued: timed out", afterSend = true)
                JsonNull
            }
            Channels.SESSION_FORK -> buildJsonObject { put("id", "s_fork"); put("title", "New chat") }
            else -> JsonArray(emptyList())
        }
    }

    private var conn = RelayState.ONLINE
    private var refuseSteer = false
    private var interruptTimesOut = false
    private fun TestScope.chat(c: FakeCaller) =
        ChatController("s1", c, backgroundScope, { ChatEnv(conn, null, RemoteDefaults("p", "m"), "Mac") })

    @Test fun `edits and removes queued prompts checked against what was shown`() = runTest {
        val c = computer()
        val chat = chat(c)
        chat.reload()
        val ui = ChatController.project(chat.state.value, ChatEnv(RelayState.ONLINE))
        assertEquals("a skill's prompt shows as /name input, never its instructions", listOf("first", "with a photo", "/review now"), ui.queued)
        assertEquals(listOf(true, true, false), ui.queuedPrompts.map { it.editable })

        chat.editQueued(0, "first", "first, edited")
        assertEquals("""["s1",0,{"expect":"first","text":"first, edited"}]""", JsonArray(c.calls.last { it.channel == Channels.CHAT_EDIT_QUEUED }.args).toString())
        assertEquals("re-read after the edit", "first, edited", chat.state.value.session?.queue?.first())

        // The prompt moved on: the computer refuses, and the queue on screen is re-read.
        val reads = c.calls.count { it.channel == Channels.SESSION_GET }
        val e = runCatching { chat.editQueued(0, "first", "late") }.exceptionOrNull()
        assertTrue("a stale edit is refused", e is RelayException)
        assertEquals(reads + 1, c.calls.count { it.channel == Channels.SESSION_GET })
        chat.editQueued(0, "first, edited", null)
        assertEquals("no text removes it", """{"expect":"first, edited"}""", c.calls.last { it.channel == Channels.CHAT_EDIT_QUEUED }.args[2].toString())

        // Offline: never sent later.
        conn = RelayState.OFFLINE
        val before = c.calls.count { it.channel == Channels.CHAT_EDIT_QUEUED }
        try {
            chat.editQueued(0, "x", "y")
            fail("offline edits are refused on the phone")
        } catch (e: RelayException) {
            assertEquals(ChatController.RECONNECT_TO_EDIT_QUEUE, e.message)
        }
        assertEquals(before, c.calls.count { it.channel == Channels.CHAT_EDIT_QUEUED })
    }

    @Test fun `next step takes the prompt off the queue, then sends it`() = runTest {
        val c = computer()
        val chat = chat(c)
        chat.reload()
        val ui = ChatController.project(chat.state.value, ChatEnv(RelayState.ONLINE))
        assertEquals("text only: photos and skills wait their turn", listOf(true, false, false), ui.queuedPrompts.map { it.canTakeAtNextStep })

        chat.sendQueuedAtNextStep(0, "first")
        assertEquals("""["s1",0,{"expect":"first"}]""", JsonArray(c.calls.last { it.channel == Channels.CHAT_EDIT_QUEUED }.args).toString())
        assertEquals("""["s1","first"]""", JsonArray(c.calls.last { it.channel == Channels.CHAT_STEER }.args).toString())
    }

    @Test fun `next step on a moved queue sends nothing`() = runTest {
        val c = computer()
        val chat = chat(c)
        chat.reload()
        assertTrue(runCatching { chat.sendQueuedAtNextStep(0, "already started") }.exceptionOrNull() is RelayException)
        assertEquals(0, c.calls.count { it.channel == Channels.CHAT_STEER })
    }

    @Test fun `a computer too old for next step keeps the prompt queued`() = runTest {
        refuseSteer = true
        val c = computer()
        val chat = chat(c)
        chat.reload()
        assertTrue(runCatching { chat.sendQueuedAtNextStep(0, "first") }.exceptionOrNull() is RelayException)
        assertEquals("""["s1","first"]""", JsonArray(c.calls.last { it.channel == Channels.CHAT_QUEUE }.args).toString())
    }

    @Test fun `interrupt names the prompt and the chat's model`() = runTest {
        val c = computer()
        val chat = chat(c)
        chat.reload()
        chat.interruptQueued(1)
        val args = c.calls.last { it.channel == Channels.CHAT_INTERRUPT_QUEUED }.args
        assertEquals("s1", args[0].jsonPrimitive.content)
        assertEquals("1", args[1].jsonPrimitive.content)
        assertTrue(args[2].jsonObject.containsKey("modelId"))
    }

    @Test fun `an interrupt that outlasts the request is not an error`() = runTest {
        interruptTimesOut = true
        val c = computer()
        val chat = chat(c)
        chat.reload()
        chat.interruptQueued(0)
    }

    @Test fun `forks before a prompt with its text, or after a reply`() = runTest {
        val c = computer()
        val chat = chat(c)
        chat.reload()
        val prompt = Block.User("u2", "/review it")
        val reply = Block.Assistant("a1", "Found it.")
        val step = Block.Tool("c1", "bash", "ls", com.nekko.protocol.ToolStatus.OK)
        val last = Block.Assistant("a2", "Looks good.")
        assertEquals("u2", chat.forkPoint(prompt)?.before)
        assertEquals("a skill prompt comes back as /name input", "/review it", chat.forkPoint(prompt)?.seed)
        assertEquals("a reply keeps everything up to the next prompt", "u2", chat.forkPoint(reply)?.before)
        assertEquals("u2", chat.forkPoint(step)?.before)
        assertNull("the last reply forks the whole chat", chat.forkPoint(last)!!.before)
        assertNull(chat.forkPoint(Block.Assistant("live-1-0", "…", streaming = true)))
        assertTrue(chat.isSaved(reply) && chat.isSaved(step))

        val (id, seed) = chat.fork(Block.User("u1", "Find the bug"))
        assertEquals("s_fork", id)
        assertEquals("""["s1","u1"]""", JsonArray(c.calls.last { it.channel == Channels.SESSION_FORK }.args).toString())
        assertEquals("the forked prompt waits in the new chat's message box", "Find the bug", seed)
        chat.fork(last)
        assertEquals("""["s1"]""", JsonArray(c.calls.last { it.channel == Channels.SESSION_FORK }.args).toString())
        val e = runCatching { chat.fork(Block.Assistant("live-1-0", "…", streaming = true)) }.exceptionOrNull()
        assertEquals("Wait for this reply to finish, then fork.", e?.message)
    }

    @Test fun `saved prompts in the slash menu`() {
        val prompts = listOf(SavedPrompt("fix", "fix", "Find and fix the bug."), SavedPrompt("explain", "explain", "Explain this."))
        assertEquals(listOf("fix"), SkillMenu.matchPrompts(prompts, "fi").map { it.name })
        assertEquals(2, SkillMenu.matchPrompts(prompts, "").size)
        assertEquals("alone, the /query empties for the chip", "", SkillMenu.textAfterPrompt("/fi", "Find and fix the bug."))
        assertEquals("after text, the /query becomes the prompt's text", "In login.ts Find and fix the bug.", SkillMenu.textAfterPrompt("In login.ts /fi", "Find and fix the bug."))
        assertEquals("Find and fix the bug.\n\nin login.ts", SkillMenu.typedPrompt("/fix in login.ts", prompts))
        assertNull(SkillMenu.typedPrompt("/nope x", prompts))
    }
}

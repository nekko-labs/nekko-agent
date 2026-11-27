package com.nekko.android

import com.nekko.android.data.FinderTexts
import com.nekko.protocol.Channels
import com.nekko.protocol.FinderSearch
import com.nekko.protocol.RelayException
import com.nekko.protocol.SessionSummary
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The chat list's search reads what chats said a few at a time, and only what changed (#3448). */
class FinderTextsTest {
    private fun chat(id: String, updatedAt: Long = 1) =
        SessionSummary.from(Json.parseToJsonElement("""{"id":"$id","title":"t","updatedAt":$updatedAt}"""))!!

    private fun answer(ids: List<String>) =
        Json.parseToJsonElement(ids.joinToString(",", "{", "}") { """"$it":{"messages":[{"role":"user","text":"said in $it"}]}""" })

    private fun asked(c: Call) = (c.args[0] as JsonArray).map { it.jsonPrimitive.content }

    @Test fun `reads chats in batches, then only the ones that moved on`() = runTest {
        val texts = FinderTexts()
        val caller = FakeCaller { c ->
            assertEquals(Channels.SESSIONS_FINDER_TEXT, c.channel)
            answer(asked(c))
        }
        val chats = (1..45).map { chat("s$it", it.toLong()) }
        texts.load("pc", chats, caller)
        assertEquals(listOf(FinderSearch.BATCH, FinderSearch.BATCH, 5), caller.calls.map { asked(it).size })
        assertEquals("newest first", "s45", asked(caller.calls[0])[0])
        assertEquals(45, texts.texts.value.size)
        assertEquals("said in s7", texts.texts.value["s7"]!!.messages.single().text)

        caller.calls.clear()
        texts.load("pc", chats, caller)
        assertTrue("nothing changed: nothing asked", caller.calls.isEmpty())
        texts.load("pc", chats.map { if (it.id == "s3") chat("s3", 99) else it }, caller)
        assertEquals(listOf(listOf("s3")), caller.calls.map(::asked))
    }

    @Test fun `asks again for chats the computer left out of a full reply`() = runTest {
        val texts = FinderTexts()
        val caller = FakeCaller { c -> answer(asked(c).take(2)) }
        texts.load("pc", listOf(chat("a", 3), chat("b", 2), chat("c", 1)), caller)
        assertEquals(listOf(listOf("a", "b", "c"), listOf("c")), caller.calls.map(::asked))
        assertEquals(setOf("a", "b", "c"), texts.texts.value.keys)
    }

    @Test fun `an older computer without the channel is searched by summaries, and not asked again`() = runTest {
        val texts = FinderTexts()
        val caller = FakeCaller { throw RelayException("Not allowed from a paired phone (channel-denied): sessions:finderText") }
        texts.load("old", listOf(chat("a")), caller)
        texts.load("old", listOf(chat("a"), chat("b")), caller)
        assertEquals(1, caller.calls.size)
        assertTrue(texts.texts.value.isEmpty())
        assertTrue(texts.due("old", listOf(chat("a"))).isEmpty())
    }

    @Test fun `a reply that answers nothing, or a failure, ends the walk without looping`() = runTest {
        val texts = FinderTexts()
        val empty = FakeCaller { Json.parseToJsonElement("{}") }
        texts.load("pc", listOf(chat("a"), chat("b")), empty)
        assertEquals(1, empty.calls.size)
        val failing = FakeCaller { throw RelayException("timed out") }
        texts.load("pc", listOf(chat("a")), failing)
        assertEquals(1, failing.calls.size)
        assertEquals("a timeout is not a refusal: asked again next time", listOf("a"), texts.due("pc", listOf(chat("a"))).map { it.id })
    }
}

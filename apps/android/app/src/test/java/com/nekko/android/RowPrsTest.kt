package com.nekko.android

import com.nekko.android.data.RowPrs
import com.nekko.protocol.Channels
import com.nekko.protocol.SessionSummary
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rows' PR chips ask the computer as the iPhone's `loadRowPrs` does (BeyondTests). */
class RowPrsTest {
    private fun chat(id: String, updatedAt: Long, vararg prs: Int) = SessionSummary.from(Json.parseToJsonElement(
        """{"id":"$id","title":"t","updatedAt":$updatedAt,"prUrls":[${prs.joinToString { "\"https://github.com/o/r/pull/$it\"" }}]}""",
    ))!!

    @Test fun `asks only for chats that name a PR, and again once they move on`() = runTest {
        var t = 1_000L
        val rows = RowPrs { t }
        val caller = FakeCaller { c ->
            assertEquals(Channels.PR_SESSION_LIST, c.channel)
            val id = c.args[0].jsonPrimitive.content
            Json.parseToJsonElement(if (id == "s1") """[{"url":"https://github.com/o/r/pull/12","number":12,"state":"merged"}]""" else "[]")
        }
        val named = chat("s1", 500, 12)
        rows.load(listOf(named, chat("s2", 600)), caller)
        assertEquals(listOf(12), rows.byChat.value["s1"]?.map { it.number })
        assertNull("a chat that names no PR is never asked about", rows.byChat.value["s2"])
        assertEquals(1, caller.calls.size)
        assertTrue(rows.due(listOf(named)).isEmpty())
        assertEquals(listOf("s1"), rows.due(listOf(chat("s1", 2_000, 12))).map { it.id })
        assertEquals(listOf("s1"), rows.due(listOf(chat("s1", 500, 12, 13))).map { it.id })
        t += RowPrs.FRESH_MS + 1
        assertEquals(listOf("s1"), rows.due(listOf(named)).map { it.id })
    }

    @Test fun `a failed lookup is asked again`() = runTest {
        val rows = RowPrs { 1_000L }
        rows.load(listOf(chat("s1", 500, 12)), FakeCaller { error("offline") })
        assertNull(rows.byChat.value["s1"])
        assertEquals(listOf("s1"), rows.due(listOf(chat("s1", 500, 12))).map { it.id })
    }
}

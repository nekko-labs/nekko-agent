package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SavedChatListTest {
    @Test fun `keeps only what the list shows`() {
        val s = SessionSummary.from(
            Json.parseToJsonElement(
                """{"id":"s1","title":"Fix the build","updatedAt":5,"workspaceId":"w","archivedAt":7,"order":1.5,"pinned":true,
                   "lastReplyText":"secret reply","firstUserText":"secret prompt","modelId":"m","providerId":"p"}""",
            ),
        )!!
        val list = SavedChatList(42, listOf(s), listOf(WorkspaceFolder("w", "App")))
        val text = list.json().toString()
        assertFalse(text.contains("secret"))
        assertFalse(text.contains("modelId"))
        val back = SavedChatList.from(Json.parseToJsonElement(text))!!
        assertEquals(42L, back.savedAt)
        assertEquals(listOf(WorkspaceFolder("w", "App")), back.folders)
        val b = back.summaries.single()
        assertEquals("Fix the build", b.title)
        assertEquals("w", b.workspaceId)
        assertEquals(7L, b.archivedAt)
        assertTrue(b.archived)
        assertEquals(1.5, b.order!!, 0.0)
        assertTrue(b.pinned)
        assertNull(b.lastReplyText)
    }

    /** The same file shape as the iPhone app's `SavedChatList` (version 1). */
    @Test fun `reads the iPhone app's shape and ignores other versions`() {
        val ios = """{"v":1,"savedAt":3,"chats":[{"id":"a","title":"T","updatedAt":2,"pinned":true}],"folders":[]}"""
        val chats = SavedChatList.from(Json.parseToJsonElement(ios))!!.summaries
        assertEquals(listOf("a"), chats.map { it.id })
        assertTrue(chats.single().pinned)
        assertNull(SavedChatList.from(Json.parseToJsonElement("""{"v":2,"savedAt":1,"chats":[]}""")))
        assertNull(SavedChatList.from(Json.parseToJsonElement("""{"savedAt":1}""")))
        assertNull(SavedChatList.from(null))
    }
}

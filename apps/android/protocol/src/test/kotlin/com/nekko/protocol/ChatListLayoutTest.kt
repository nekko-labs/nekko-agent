package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/** The chat list's view menu, held to the iPhone's ChatListLayoutTests. */
class ChatListLayoutTest {
    private val day = 24L * 60 * 60 * 1000
    /** 2026-10-24 12:00 UTC. */
    private val now = 1_792_843_200_000L
    private val utc = ZoneOffset.UTC

    private fun chats(json: String) = SessionSummary.visible(Json.parseToJsonElement(json))
    private val folders = listOf(WorkspaceFolder("w1", "App"), WorkspaceFolder("w2", "Empty"))

    @Test fun `the default view is the list as it was`() {
        val list = chats(
            """[{"id":"a","title":"A","updatedAt":5},
               {"id":"b","title":"B","updatedAt":9,"workspaceId":"w1","order":2},
               {"id":"c","title":"C","updatedAt":3,"workspaceId":"w1","order":1},
               {"id":"e","title":"E","updatedAt":8,"workspaceId":"w1","archivedAt":100}]""",
        )
        val s = ChatSections.make(list, folders, ChatListView.STANDARD, emptyMap(), now = now, zone = utc)
        assertEquals(listOf("General", "App", "Empty"), s.map { it.name })
        assertEquals("active in dragged order, then completed", listOf("c", "b", "e"), s[1].chats.map { it.id })
        assertEquals(2, s[1].activeCount)
        assertEquals(1, s[1].doneCount)
    }

    @Test fun `hides completed chats and empty folders`() {
        val list = chats("""[{"id":"e","title":"E","updatedAt":8,"workspaceId":"w1","archivedAt":100}]""")
        val v = ChatListView.STANDARD.copy(showCompleted = false, showEmptyGroups = false)
        assertEquals(emptyList<String>(), ChatSections.make(list, folders, v, emptyMap(), now = now).map { it.name })
        assertEquals(listOf("App", "Empty"), ChatSections.make(list, folders, v.copy(showEmptyGroups = true), emptyMap(), now = now).map { it.name })
    }

    @Test fun `sorts by name and by update`() {
        val list = chats(
            """[{"id":"a","title":"beta","updatedAt":5},
               {"id":"b","title":"Alpha","updatedAt":9},
               {"id":"c","title":"gamma 10","updatedAt":3},
               {"id":"d","title":"gamma 9","updatedAt":7}]""",
        )
        val byName = ChatListView.STANDARD.withSort(ChatListView.SortBy.NAME)
        assertTrue("names start A to Z", byName.ascending)
        assertEquals(listOf("b", "a", "d", "c"), ChatSections.make(list, emptyList(), byName, emptyMap(), now = now)[0].chats.map { it.id })
        val newest = ChatListView.STANDARD.withSort(ChatListView.SortBy.UPDATED)
        assertFalse("dates start newest first", newest.ascending)
        val oldest = newest.copy(ascending = true)
        assertEquals(listOf("c", "a", "d", "b"), ChatSections.make(list, emptyList(), oldest, emptyMap(), now = now)[0].chats.map { it.id })
    }

    @Test fun `groups by status and date`() {
        val list = chats(
            """[{"id":"a","title":"A","updatedAt":${now - 1000}},
               {"id":"b","title":"B","updatedAt":${now - day}},
               {"id":"c","title":"C","updatedAt":${now - 3 * day}},
               {"id":"d","title":"D","updatedAt":${now - 60 * day}},
               {"id":"e","title":"E","updatedAt":$now,"archivedAt":$now}]""",
        )
        val v = ChatListView.STANDARD.copy(groupBy = ChatListView.GroupBy.STATUS, showEmptyGroups = false)
        val status = ChatSections.make(list, emptyList(), v, mapOf("c" to Activity.NEEDS_YOU, "a" to Activity.RUNNING), now = now, zone = utc)
        assertEquals(listOf("Needs you", "Working", "Idle", "Completed"), status.map { it.name })
        assertEquals(listOf(listOf("c"), listOf("a"), listOf("b", "d"), listOf("e")), status.map { s -> s.chats.map { it.id } })

        val date = ChatSections.make(list, emptyList(), v.copy(groupBy = ChatListView.GroupBy.DATE), emptyMap(), now = now, zone = utc)
        assertEquals(listOf("Today", "Yesterday", "Previous 7 days", "Older", "Completed"), date.map { it.name })

        val none = ChatSections.make(list, emptyList(), v.copy(groupBy = ChatListView.GroupBy.NONE), emptyMap(), now = now)
        assertEquals(listOf("All chats", "Completed"), none.map { it.name })
    }

    @Test fun `shows up to eight recent chats and always the busy ones`() {
        // 10 recent, 2 older than two weeks; one old one needs you, one old one is pinned.
        val items = (0 until 12).joinToString(",") { i ->
            val at = if (i < 10) now - i * day else now - (10 + i) * day
            val pin = if (i == 11) ",\"pinned\":true" else ""
            """{"id":"c$i","title":"C$i","updatedAt":$at$pin}"""
        }
        val activity = mapOf("c10" to Activity.NEEDS_YOU)
        val s = ChatSections.make(chats("[$items]"), emptyList(), ChatListView.STANDARD, activity, now = now)[0]
        val (shown, hidden) = ChatSections.split(s, activity, now)
        assertEquals(listOf("c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c10", "c11"), shown.map { it.id })
        assertEquals(2, hidden)
    }

    @Test fun `group order follows the arranged order`() {
        val list = chats("""[{"id":"a","title":"A","updatedAt":5},{"id":"b","title":"B","updatedAt":5,"workspaceId":"w1"}]""")
        val s = ChatSections.make(list, folders, ChatListView.STANDARD, emptyMap(), groupOrder = listOf("w2", "w1"), now = now)
        assertEquals("a group the saved order doesn't name keeps its place after", listOf("Empty", "App", "General"), s.map { it.name })
        assertEquals(listOf("c", "a", "b"), ChatGroupOrder.move(listOf("a", "b", "c"), "c", before = "a"))
        assertEquals(listOf("b", "c", "a"), ChatGroupOrder.move(listOf("a", "b", "c"), "a", before = null))
        assertEquals(listOf("a", "b", "c"), ChatGroupOrder.move(listOf("a", "b", "c"), "x", before = "a"))
    }

    @Test fun `saved views keep what is still valid`() {
        val v = ChatListView.STANDARD.copy(groupBy = ChatListView.GroupBy.DATE, showPreviews = false)
        assertEquals(v, ChatListView.parse(v.encoded()))
        val partial = ChatListView.parse("""{"groupBy":"status","sortBy":"created","showCompleted":false}""")
        assertEquals(ChatListView.GroupBy.STATUS, partial.groupBy)
        assertEquals("an unknown sort falls back", ChatListView.SortBy.MANUAL, partial.sortBy)
        assertFalse(partial.showCompleted)
        assertEquals(ChatListView.STANDARD, ChatListView.parse("nope"))
        assertEquals(ChatListView.STANDARD, ChatListView.parse(null))
    }

    @Test fun `names compare as people read them`() {
        assertTrue(ChatSections.naturalCompare("gamma 9", "gamma 10") < 0)
        assertTrue(ChatSections.naturalCompare("Alpha", "beta") < 0)
        assertEquals(0, ChatSections.naturalCompare("Éclair", "eclair"))
    }
}

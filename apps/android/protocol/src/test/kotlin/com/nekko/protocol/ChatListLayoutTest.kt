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
        assertEquals(listOf("General", "App"), s.map { it.name })
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
        // #2107: the iPhone's status groups; stopped chats with no watch and no count from the computer are Done.
        assertEquals(listOf("Needs input", "Building", "Done", "Completed"), status.map { it.name })
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
        val s = ChatSections.make(list, folders, ChatListView.STANDARD.copy(showEmptyGroups = true), emptyMap(), groupOrder = listOf("w2", "w1"), now = now)
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

    @Test fun `status groups split running, drafts, watching and done as the iPhone does`() {
        val list = chats(
            """[{"id":"run","title":"R","updatedAt":$now},
               {"id":"ver","title":"V","updatedAt":$now,"activeRun":{"id":"r1"},"phase":"verifying"},
               {"id":"ship","title":"S","updatedAt":$now,"activeRun":{"id":"r2"},"phase":"shipping"},
               {"id":"draft","title":"D","updatedAt":$now,"exchangeCount":0},
               {"id":"watch","title":"W","updatedAt":$now,"exchangeCount":3,"activeWatchCount":2},
               {"id":"done","title":"F","updatedAt":$now,"exchangeCount":3},
               {"id":"ask","title":"A","updatedAt":$now,"activeRun":{"id":"r3"}}]""",
        )
        val v = ChatListView.STANDARD.copy(groupBy = ChatListView.GroupBy.STATUS, showEmptyGroups = false)
        val activity = mapOf("run" to Activity.RUNNING, "ask" to Activity.NEEDS_YOU)
        val groups = ChatSections.make(list, emptyList(), v, activity, now = now, zone = utc).associate { g -> g.key to g.chats.map { it.id } }
        assertEquals(listOf("ask"), groups["status:input"])
        assertEquals(listOf("draft"), groups["status:draft"])
        assertEquals(listOf("run"), groups["status:building"])
        assertEquals(listOf("ver", "ship").sorted(), groups["status:verifying"]?.sorted())
        assertEquals(listOf("watch"), groups["status:watching"])
        assertEquals(listOf("done"), groups["status:done"])

        val sections = ChatSections.make(list, emptyList(), v, activity, now = now, zone = utc).associateBy { it.key }
        assertTrue(sections.getValue("status:building").live(activity))
        assertFalse("Verifying runs on the computer, but the phone saw no event: not live", sections.getValue("status:verifying").live(activity))
        assertTrue(sections.getValue("status:watching").live(activity))
        assertEquals(2L, sections.getValue("status:watching").watchingCount)
        assertFalse(sections.getValue("status:done").live(activity))
        assertEquals(Activity.NEEDS_YOU, sections.getValue("status:input").headerActivity(activity))
    }

    @Test fun `groups start folded, ungrouped chats have no fold`() {
        val g = ChatSection("status:done", "Done", emptyList(), 0, 0)
        assertFalse(g.isOpen(emptySet()))
        assertTrue(g.isOpen(setOf("status:done")))
        assertTrue(ChatSection(ChatGroup.GENERAL, "General", emptyList(), 0, 0).isOpen(emptySet()))
        assertTrue(ChatSection("all", "All chats", emptyList(), 0, 0).isOpen(emptySet()))
    }

    @Test fun `groups by computer, one group per place in its order, each with its own completed chats`() {
        val list = chats(
            """[{"id":"a","title":"A","updatedAt":5},
               {"id":"b","title":"B","updatedAt":9},
               {"id":"c","title":"C","updatedAt":3,"archivedAt":100},
               {"id":"phone:1","title":"P","updatedAt":7},
               {"id":"x","title":"X","updatedAt":1}]""",
        )
        val owners = mapOf("a" to "mac", "b" to "pc", "c" to "pc", "phone:1" to ChatPlace.PHONE)
        val places = listOf(ChatPlace("mac", "Studio Mac"), ChatPlace("pc", "Office PC"), ChatPlace("empty", "Spare"), ChatPlace(ChatPlace.PHONE, "This phone"))
        val v = ChatListView.STANDARD.copy(groupBy = ChatListView.GroupBy.COMPUTER, sortBy = ChatListView.SortBy.UPDATED)
        val s = ChatSections.make(list, emptyList(), v, emptyMap(), now = now, places = places, placeOf = { owners[it.id] })
        assertEquals(listOf("computer:mac", "computer:pc", "computer:this-phone"), s.map { it.key })
        assertEquals(listOf("Studio Mac", "Office PC", "This phone"), s.map { it.name })
        assertEquals("a chat with no known place joins the first group", listOf("a", "x"), s[0].chats.map { it.id })
        assertEquals("active, then its own completed", listOf("b", "c"), s[1].chats.map { it.id })
        assertEquals(1, s[1].doneCount)
        val withEmpty = ChatSections.make(list, emptyList(), v.copy(showEmptyGroups = true), emptyMap(), now = now, places = places, placeOf = { owners[it.id] })
        assertEquals("Spare", withEmpty[2].name)
        assertFalse("computer groups start folded", s[0].isOpen(emptySet()))

        // One place only: one list, as Group by none.
        val one = ChatSections.make(list, emptyList(), v, emptyMap(), now = now, places = places.take(1), placeOf = { owners[it.id] })
        assertEquals(listOf("All chats", "Completed"), one.map { it.name })
    }

    @Test fun `the place on rows is a saved choice, on by default`() {
        assertTrue(ChatListView.STANDARD.showComputer)
        assertTrue(ChatListView.STANDARD.showComputerIcons)
        val v = ChatListView.STANDARD.copy(groupBy = ChatListView.GroupBy.COMPUTER, showComputer = false, showComputerIcons = false)
        assertEquals(v, ChatListView.parse(v.encoded()))
        assertEquals(ChatListView.GroupBy.COMPUTER, ChatListView.parse("""{"groupBy":"computer"}""").groupBy)
        assertEquals(0x5b8defL, ComputerColors.computer(0))
        assertEquals("the phone's colour is never a computer's", 0x5b8defL, ComputerColors.computer(5))
        assertTrue(ChatPlace.isPhoneChat("phone:abc"))
        assertFalse(ChatPlace.isPhoneChat("abc"))
    }
}

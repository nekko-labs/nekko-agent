package com.nekko.android

import com.nekko.android.data.AllChats
import com.nekko.android.data.ChatListPrefs
import com.nekko.android.data.Computer
import com.nekko.android.data.ComputersState
import com.nekko.android.data.Peer
import com.nekko.protocol.Activity
import com.nekko.protocol.ChatPlace
import com.nekko.protocol.PhoneChat
import com.nekko.protocol.PhoneMessage
import com.nekko.protocol.RelayState
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.WorkspaceFolder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** One chat list across every paired computer and this phone (#2108, the iPhone's #1665 and #1741). */
class AllChatsTest {
    private fun chat(id: String, at: Long = 1) = SessionSummary(id, id.uppercase(), at, null, null, null, false, null, null, null)
    private val computers = listOf(Computer("mac", "Studio Mac", "wss://r", 1), Computer("pc", "Office PC", "wss://r", 2), Computer("nas", "NAS", "wss://r", 3))
    private val state = ComputersState(
        computers = computers,
        // The PC is active: its chats come first, then the others in pairing order.
        activeId = "pc",
        conn = RelayState.ONLINE,
        summaries = listOf(chat("p1"), chat("shared")),
        activity = mapOf("p1" to Activity.RUNNING, "shared" to Activity.NEEDS_YOU),
        workspaces = listOf(WorkspaceFolder("w1", "App")),
        peers = mapOf(
            "mac" to Peer(conn = RelayState.ONLINE, summaries = listOf(chat("m1"), chat("shared")), activity = mapOf("m1" to Activity.NEEDS_YOU, "shared" to Activity.RUNNING),
                workspaces = listOf(WorkspaceFolder("w1", "App"), WorkspaceFolder("w2", "Docs"))),
            // Asleep: its saved list still shows, as on the iPhone.
            "nas" to Peer(conn = RelayState.OFFLINE, summaries = listOf(chat("n1")), savedAt = 5),
        ),
    )
    private val phoneChat = PhoneChat("phone:1", "Quick question", "anthropic", "claude-haiku-5-5", 1, 9,
        listOf(PhoneMessage("u", "user", "Hi", 1), PhoneMessage("a", "assistant", "Hello!", 2)))

    private fun of(filter: String? = null, phone: List<PhoneChat> = emptyList(), setUp: Boolean = false, running: Set<String> = emptySet()) =
        AllChats.of(state, phone, running, setUp, filter, "This phone")

    @Test fun `every computer's chats, the active one's first, then in pairing order`() {
        val all = of()
        assertEquals(listOf("p1", "shared", "m1", "n1"), all.chats.map { it.id })
        assertEquals("a chat two computers list belongs to the first", "pc", all.owners["shared"])
        assertEquals("mac", all.owners["m1"])
        assertEquals("nas", all.owners["n1"])
        assertEquals(Activity.NEEDS_YOU, all.activity["m1"])
        assertEquals("the first place to say wins", Activity.NEEDS_YOU, all.activity["shared"])
        assertEquals(listOf("w1", "w2"), all.folders.map { it.id })
        assertEquals(listOf("Studio Mac", "Office PC", "NAS"), all.places.map { it.name })
        assertEquals(all.places, all.shown)
        assertEquals("Studio Mac", all.place("m1")?.name)
        assertEquals(listOf(0x5b8defL, 0xa57cf0L, 0x2fb7b1L), all.places.map { it.color })
    }

    @Test fun `filtered to one place, the list holds only its chats`() {
        val mac = of(filter = "mac")
        assertEquals(listOf("m1", "shared"), mac.chats.map { it.id })
        assertEquals(listOf("mac"), mac.shown.map { it.id })
        assertEquals(3, mac.places.size)
        assertEquals("a place no longer paired shows every place", 3, of(filter = "gone").shown.size)
    }

    @Test fun `chats on this phone follow the computers', once it has a provider or a chat`() {
        assertEquals(3, of(setUp = false).places.size)
        assertEquals(ChatPlace.PHONE, of(setUp = true).places.last().id)
        val all = of(phone = listOf(phoneChat), running = setOf("phone:1"))
        assertEquals("phone:1", all.chats.last().id)
        assertEquals(ChatPlace.PHONE, all.owners["phone:1"])
        assertEquals(Activity.RUNNING, all.activity["phone:1"])
        val row = all.chats.last()
        assertEquals("Hello!", row.lastReplyText)
        assertEquals("Hi", row.firstUserText)
        assertEquals(1L, row.exchangeCount)
        assertEquals("This phone", all.place("phone:1")?.name)
        val phoneOnly = of(filter = ChatPlace.PHONE, phone = listOf(phoneChat))
        assertEquals(listOf("phone:1"), phoneOnly.chats.map { it.id })
        assertNull(phoneOnly.owners["p1"])
    }

    @Test fun `group order is kept per place shown, a single computer keeping its own`() {
        assertEquals("mac", ChatListPrefs.orderKey(listOf("mac")))
        assertEquals("*", ChatListPrefs.orderKey(listOf("mac", "pc")))
    }
}

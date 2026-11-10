package com.nekko.android

import com.nekko.android.data.ChatListPrefs
import com.nekko.android.data.PhonePrefs
import com.nekko.protocol.ChatListView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #2133: the chat list's closed groups are a phone preference, kept across launches. */
class ChatGroupPrefsTest {
    @Test fun `a new install keeps every group open and writes nothing`() {
        val store = MapPrefStore()
        assertTrue(PhonePrefs(store).get(ChatListPrefs.COLLAPSED_GROUPS).isEmpty())
        assertNull(store.map["chatList.collapsedGroups"])
    }

    @Test fun `closing and opening survive a new launch, group by group`() {
        val store = MapPrefStore()
        val prefs = PhonePrefs(store)
        val keys = setOf("project:a", "status:building", "date:today", "general")
        keys.forEach { prefs.set(ChatListPrefs.COLLAPSED_GROUPS, ChatListPrefs.toggled(prefs.get(ChatListPrefs.COLLAPSED_GROUPS), it)) }
        // A cold launch reads the same file again.
        val again = PhonePrefs(store)
        assertEquals(keys, again.get(ChatListPrefs.COLLAPSED_GROUPS))
        again.set(ChatListPrefs.COLLAPSED_GROUPS, ChatListPrefs.toggled(again.get(ChatListPrefs.COLLAPSED_GROUPS), "status:building"))
        assertEquals(keys - "status:building", PhonePrefs(store).get(ChatListPrefs.COLLAPSED_GROUPS))
    }

    @Test fun `changing the view keeps the closed groups`() {
        val store = MapPrefStore()
        val prefs = PhonePrefs(store)
        prefs.set(ChatListPrefs.COLLAPSED_GROUPS, setOf("status:watching"))
        prefs.set(ChatListPrefs.VIEW, ChatListView.STANDARD.copy(groupBy = ChatListView.GroupBy.STATUS))
        prefs.set(ChatListPrefs.VIEW, ChatListView.STANDARD)
        assertEquals(setOf("status:watching"), PhonePrefs(store).get(ChatListPrefs.COLLAPSED_GROUPS))
    }

    @Test fun `unreadable storage reads as none closed and duplicates are harmless`() {
        assertTrue(PhonePrefs(MapPrefStore(mutableMapOf("chatList.collapsedGroups" to "42"))).get(ChatListPrefs.COLLAPSED_GROUPS).isEmpty())
        assertTrue(PhonePrefs(MapPrefStore(mutableMapOf("chatList.collapsedGroups" to "{nope"))).get(ChatListPrefs.COLLAPSED_GROUPS).isEmpty())
        val dup = PhonePrefs(MapPrefStore(mutableMapOf("chatList.collapsedGroups" to """["general","general"]""")))
        assertEquals(setOf("general"), dup.get(ChatListPrefs.COLLAPSED_GROUPS))
    }
}

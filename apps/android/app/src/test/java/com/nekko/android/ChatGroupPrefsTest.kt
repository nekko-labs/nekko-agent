package com.nekko.android

import com.nekko.android.data.ChatListPrefs
import com.nekko.android.data.PhonePrefs
import com.nekko.protocol.ChatListView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #2133, #2107: the chat list's opened groups are a phone preference, kept across launches; groups start folded. */
class ChatGroupPrefsTest {
    @Test fun `a new install has every group folded and writes nothing`() {
        val store = MapPrefStore()
        assertTrue(PhonePrefs(store).get(ChatListPrefs.OPENED_GROUPS).isEmpty())
        assertNull(store.map["chatList.openedGroups"])
    }

    @Test fun `opening and closing survive a new launch, group by group`() {
        val store = MapPrefStore()
        val prefs = PhonePrefs(store)
        val keys = setOf("project:a", "status:building", "date:today", "general")
        keys.forEach { prefs.set(ChatListPrefs.OPENED_GROUPS, ChatListPrefs.toggled(prefs.get(ChatListPrefs.OPENED_GROUPS), it)) }
        // A cold launch reads the same file again.
        val again = PhonePrefs(store)
        assertEquals(keys, again.get(ChatListPrefs.OPENED_GROUPS))
        again.set(ChatListPrefs.OPENED_GROUPS, ChatListPrefs.toggled(again.get(ChatListPrefs.OPENED_GROUPS), "status:building"))
        assertEquals(keys - "status:building", PhonePrefs(store).get(ChatListPrefs.OPENED_GROUPS))
    }

    @Test fun `changing the view keeps the opened groups`() {
        val store = MapPrefStore()
        val prefs = PhonePrefs(store)
        prefs.set(ChatListPrefs.OPENED_GROUPS, setOf("status:watching"))
        prefs.set(ChatListPrefs.VIEW, ChatListView.STANDARD.copy(groupBy = ChatListView.GroupBy.STATUS))
        prefs.set(ChatListPrefs.VIEW, ChatListView.STANDARD)
        assertEquals(setOf("status:watching"), PhonePrefs(store).get(ChatListPrefs.OPENED_GROUPS))
    }

    @Test fun `unreadable storage reads as none opened and duplicates are harmless`() {
        assertTrue(PhonePrefs(MapPrefStore(mutableMapOf("chatList.openedGroups" to "42"))).get(ChatListPrefs.OPENED_GROUPS).isEmpty())
        assertTrue(PhonePrefs(MapPrefStore(mutableMapOf("chatList.openedGroups" to "{nope"))).get(ChatListPrefs.OPENED_GROUPS).isEmpty())
        val dup = PhonePrefs(MapPrefStore(mutableMapOf("chatList.openedGroups" to """["general","general"]""")))
        assertEquals(setOf("general"), dup.get(ChatListPrefs.OPENED_GROUPS))
    }

    @Test fun `the old closed-groups choice is not read and every group starts folded once`() {
        val prefs = PhonePrefs(MapPrefStore(mutableMapOf("chatList.collapsedGroups" to """["status:done"]""")))
        assertTrue(prefs.get(ChatListPrefs.OPENED_GROUPS).isEmpty())
    }
}

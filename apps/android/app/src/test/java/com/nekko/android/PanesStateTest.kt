package com.nekko.android

import com.nekko.android.data.PaneLayouts
import com.nekko.android.data.PhonePrefs
import com.nekko.android.ui.panes.PanesViewModel
import com.nekko.android.ui.panes.WindowPosture
import com.nekko.protocol.PaneContent
import com.nekko.protocol.PaneLayout
import com.nekko.protocol.PaneMode
import com.nekko.protocol.PaneSide
import com.nekko.protocol.WindowClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The folding-phone panes' state: remembered per computer, rotated, the one-time tip. */
class PanesStateTest {
    private fun layouts(store: MapPrefStore = MapPrefStore()) = PaneLayouts(PhonePrefs(store))

    @Test fun `the arrangement is remembered per computer, on the phone only`() {
        val store = MapPrefStore()
        val l = layouts(store)
        assertEquals(PaneLayout.DEFAULT, l.get("mac"))
        l.set("mac", PaneLayout(PaneContent.Chat("s1"), PaneContent.Monitors))
        l.set("pc", PaneLayout(PaneContent.Monitors, PaneContent.Chats))
        val again = layouts(store)
        assertEquals(PaneLayout(PaneContent.Chat("s1"), PaneContent.Monitors), again.get("mac"))
        assertEquals(PaneLayout(PaneContent.Monitors, PaneContent.Chats), again.get("pc"))
        again.forget("mac")
        assertEquals(PaneLayout.DEFAULT, again.get("mac"))
        again.forget("pc")
        assertTrue("nothing left behind", store.map.isEmpty())
    }

    @Test fun `each computer opens on its own last arrangement`() {
        val store = layouts()
        store.set("pc", PaneLayout(PaneContent.Monitors, PaneContent.Chats))
        val vm = PanesViewModel(store)
        vm.onMode(PaneMode.SIDE_BY_SIDE)
        vm.attach("mac")
        assertEquals(PaneLayout.DEFAULT, vm.layout.value)
        vm.update { it.open("s1", from = PaneSide.FIRST) }
        vm.attach("pc")
        assertEquals(PaneContent.Monitors, vm.layout.value.first)
        vm.attach("mac")
        assertEquals(listOf("s1"), vm.layout.value.chatIds)
    }

    @Test fun `rotating makes the focused pane the primary, closing and opening keeps the arrangement`() {
        val vm = PanesViewModel(layouts())
        vm.attach("mac")
        assertNull(vm.onMode(PaneMode.SIDE_BY_SIDE))
        vm.update { PaneLayout(PaneContent.Chat("a"), PaneContent.Chat("b"), focused = PaneSide.SECOND) }
        assertEquals(PaneMode.SIDE_BY_SIDE, vm.onMode(PaneMode.STACKED))
        assertEquals(listOf("b", "a"), vm.layout.value.chatIds)
        assertEquals(PaneMode.STACKED, vm.onMode(PaneMode.ONE))
        vm.onMode(PaneMode.STACKED)
        assertEquals(listOf("b", "a"), vm.layout.value.chatIds)
    }

    @Test fun `the chat plus chat tip shows once per phone`() {
        val store = MapPrefStore()
        val vm = PanesViewModel(layouts(store))
        vm.attach("mac")
        vm.onMode(PaneMode.SIDE_BY_SIDE)
        vm.update { it.open("a", from = PaneSide.FIRST) }
        vm.update(running = setOf("a")) { it.open("b", from = PaneSide.FIRST) }
        assertEquals("a", vm.tip.value)
        vm.takeTip()
        assertNull(vm.tip.value)
        assertEquals(listOf("a", "b"), vm.layout.value.chatIds)
        // Never again, even after a restart.
        val next = PanesViewModel(layouts(store))
        next.attach("mac")
        next.onMode(PaneMode.SIDE_BY_SIDE)
        next.update { it.replace(PaneSide.FIRST, PaneContent.Chats) }
        next.update(running = setOf("b")) { it.open("c", from = PaneSide.FIRST) }
        assertNull(next.tip.value)
        assertFalse(store.map[PaneLayouts.CHAT_CHAT_TIP.name].isNullOrEmpty())
    }

    @Test fun `window size classes map to the posture model's`() {
        assertEquals(WindowClass.COMPACT, WindowPosture.windowClass(atLeastMedium = false, atLeastExpanded = false))
        assertEquals(WindowClass.MEDIUM, WindowPosture.windowClass(atLeastMedium = true, atLeastExpanded = false))
        assertEquals(WindowClass.EXPANDED, WindowPosture.windowClass(atLeastMedium = true, atLeastExpanded = true))
    }
}

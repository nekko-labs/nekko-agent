package com.nekko.android

import com.nekko.android.data.Computer
import com.nekko.android.ui.chat.effortStop
import com.nekko.android.ui.files.LogGroup
import com.nekko.android.ui.files.logGroups
import com.nekko.android.ui.screens.MonitorSection
import com.nekko.android.ui.screens.monitorSections
import com.nekko.android.ui.screens.pairedCaption
import com.nekko.android.ui.screens.pillDescription
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The chats header's computer pill, Monitors' groups, the Logs sections and the effort slider's snapping. */
class ListsAndControlsTest {
    @Test fun `the pill says how many computers are paired only when there are several`() {
        assertNull(pairedCaption(0))
        assertNull(pairedCaption(1))
        assertEquals("2 paired", pairedCaption(2))
        assertEquals("5 paired", pairedCaption(5))
        assertEquals("Computer menu, Studio Mac, Online", pillDescription("Studio Mac", "Online", 1))
        assertEquals("Computer menu, Studio Mac, Offline, 3 paired", pillDescription("Studio Mac", "Offline", 3))
    }

    @Test fun `Running and Needs you show only while they hold something`() {
        val all = MonitorSection.entries
        assertEquals(listOf(MonitorSection.HARDWARE, MonitorSection.AUTOMATIONS), monitorSections(0, 0))
        assertEquals(listOf(MonitorSection.HARDWARE, MonitorSection.RUNNING, MonitorSection.AUTOMATIONS), monitorSections(2, 0))
        assertEquals(listOf(MonitorSection.HARDWARE, MonitorSection.NEEDS_YOU, MonitorSection.AUTOMATIONS), monitorSections(0, 1))
        assertEquals(all, monitorSections(1, 1))
    }

    @Test fun `logs list this phone, then the connected computer, then the others in pairing order`() {
        val a = Computer("a", "Studio Mac", "wss://r", 1)
        val b = Computer("b", "Gaming PC", "wss://r", 2)
        val c = Computer("c", "Laptop", "wss://r", 3)
        assertEquals(
            listOf(LogGroup("On this phone", null, false), LogGroup("Gaming PC", "b", true), LogGroup("Studio Mac", "a", false), LogGroup("Laptop", "c", false)),
            logGroups(listOf(a, b, c), "b"),
        )
        assertEquals(listOf(LogGroup("On this phone", null, false)), logGroups(emptyList(), null))
        // Not connected to any: every computer offers Connect, in pairing order.
        assertEquals(listOf("a", "b"), logGroups(listOf(a, b), null).drop(1).map { it.computerId })
    }

    @Test fun `the effort track snaps a touch to the nearest level`() {
        // Five levels on a track from 40 to 440 px: stops every 100 px.
        assertEquals(0, effortStop(40f, 40f, 440f, 5))
        assertEquals(0, effortStop(89f, 40f, 440f, 5))
        assertEquals(1, effortStop(91f, 40f, 440f, 5))
        assertEquals(2, effortStop(240f, 40f, 440f, 5))
        assertEquals(4, effortStop(440f, 40f, 440f, 5))
        // Past either end snaps to that end.
        assertEquals(0, effortStop(-30f, 40f, 440f, 5))
        assertEquals(4, effortStop(999f, 40f, 440f, 5))
        // Three levels: the middle one owns the middle third.
        assertEquals(1, effortStop(200f, 0f, 400f, 3))
        // One level, or no track yet: always the first.
        assertEquals(0, effortStop(300f, 0f, 400f, 1))
        assertEquals(0, effortStop(300f, 0f, 0f, 4))
    }
}

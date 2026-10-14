package com.nekko.android

import com.nekko.android.chat.PhoneEvent
import com.nekko.android.data.PhonePrefs
import com.nekko.android.haptics.EventHaptics
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class EventHapticsTest {
    private var clock = 10_000L
    private val prefs = PhonePrefs(MapPrefStore())
    private val h = EventHaptics(prefs, now = { clock })

    private fun buzz(e: PhoneEvent, foreground: Boolean = true, quiet: Boolean = false, subAgent: Boolean = false) =
        h.decide(e, foreground, quiet, subAgent).also { clock += EventHaptics.GAP_MS }

    @Test
    fun `defaults buzz when the agent waits on the user, not when a reply ends`() {
        assertEquals(EventHaptics.pattern(PhoneEvent.APPROVAL), buzz(PhoneEvent.APPROVAL))
        assertEquals(EventHaptics.pattern(PhoneEvent.NEEDS_INPUT), buzz(PhoneEvent.NEEDS_INPUT))
        assertNull(buzz(PhoneEvent.FINISHED))
        assertNull(buzz(PhoneEvent.FAILED))
    }

    @Test
    fun `each event follows its own switch`() {
        prefs.set(EventHaptics.APPROVAL, false)
        prefs.set(EventHaptics.FINISHED, true)
        assertNull(buzz(PhoneEvent.APPROVAL))
        assertNotNull(buzz(PhoneEvent.FINISHED))
    }

    @Test
    fun `never in the background, in silent mode or do not disturb`() {
        assertNull(buzz(PhoneEvent.APPROVAL, foreground = false))
        assertNull(buzz(PhoneEvent.APPROVAL, quiet = true))
        assertNotNull(buzz(PhoneEvent.APPROVAL))
    }

    @Test
    fun `a sub-agent finishing is not the user's reply, its approval still is`() {
        prefs.set(EventHaptics.FINISHED, true)
        prefs.set(EventHaptics.FAILED, true)
        assertNull(buzz(PhoneEvent.FINISHED, subAgent = true))
        assertNull(buzz(PhoneEvent.FAILED, subAgent = true))
        assertNotNull(buzz(PhoneEvent.APPROVAL, subAgent = true))
    }

    @Test
    fun `a burst of events is one buzz`() {
        assertNotNull(h.decide(PhoneEvent.APPROVAL, foreground = true, quiet = false, subAgent = false))
        clock += 200
        assertNull(h.decide(PhoneEvent.NEEDS_INPUT, foreground = true, quiet = false, subAgent = false))
        clock += EventHaptics.GAP_MS
        assertNotNull(h.decide(PhoneEvent.NEEDS_INPUT, foreground = true, quiet = false, subAgent = false))
    }

    @Test
    fun `a suppressed event does not start the quiet gap`() {
        assertNull(h.decide(PhoneEvent.FINISHED, foreground = true, quiet = false, subAgent = false))
        clock += 100
        assertNotNull(h.decide(PhoneEvent.APPROVAL, foreground = true, quiet = false, subAgent = false))
    }

    @Test
    fun `the four patterns are distinct and every event has a key`() {
        val patterns = PhoneEvent.entries.map(EventHaptics::pattern)
        assertEquals(4, patterns.toSet().size)
        assertEquals(4, PhoneEvent.entries.map { EventHaptics.key(it).name }.toSet().size)
        assertNotEquals(EventHaptics.pattern(PhoneEvent.APPROVAL), EventHaptics.pattern(PhoneEvent.FAILED))
    }
}

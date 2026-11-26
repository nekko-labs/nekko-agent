package com.nekko.android

import com.nekko.android.connection.StatusDashboard
import com.nekko.android.ui.settings.LiveCardSample
import com.nekko.protocol.LiveLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Settings preview of the Lock Screen card at each level (#2933). */
class LockScreenCardPreviewTest {
    private val now = 1_800_000_000.0

    @Test fun noneHasNoCardOnlyTheRunningCount() {
        assertNull(LiveCardSample.card(LiveLevel.NONE, now))
        // Billing, Login and the watched PR are not finished: the plain notification counts them.
        assertEquals(3, LiveCardSample.running(now))
    }

    @Test fun everyEnabledLevelDrawsTheSameContentFreeTotals() {
        val lines = listOf(LiveLevel.MINIMAL, LiveLevel.STANDARD, LiveLevel.DETAILED).map { level ->
            StatusDashboard.lines(LiveCardSample.card(level, now)!!, "Voice opens the app.")
        }
        assertEquals(listOf("1 Building · 1 Need input · 1 Done", "1 Watching", "Voice opens the app."), lines[0])
        assertTrue(lines.all { it == lines[0] })
        for (line in lines.flatten()) for (text in listOf("Billing", "npm test", "Want me to", "login")) assertTrue(line, text !in line)
    }

    @Test fun theSampleIsBuiltAsThePushWouldBeAtThatLevel() {
        val minimal = LiveCardSample.card(LiveLevel.MINIMAL, now)!!
        assertTrue(minimal.chats.all { it.title.isEmpty() && it.step.isEmpty() && it.reply.isEmpty() })
        assertTrue(LiveCardSample.card(LiveLevel.STANDARD, now)!!.chats.all { it.reply.isEmpty() })
        assertTrue(LiveCardSample.card(LiveLevel.DETAILED, now)!!.chats.any { it.reply.isNotEmpty() })
    }
}

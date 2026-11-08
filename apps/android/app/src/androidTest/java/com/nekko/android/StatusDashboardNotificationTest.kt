package com.nekko.android

import android.app.Notification
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nekko.android.connection.KeepAlive
import com.nekko.android.connection.Notices
import com.nekko.protocol.LiveCardState
import com.nekko.protocol.LiveChat
import com.nekko.protocol.LiveChatState
import com.nekko.protocol.LiveLevel
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Constructs only. Never posts, launches an activity, or asks for permission on a user device. */
@RunWith(AndroidJUnit4::class)
class StatusDashboardNotificationTest {
    private val card = LiveCardState(listOf(LiveChat("secret-id", "private-title", LiveChatState.NEEDS_YOU,
        step = "private-command", reply = "private-transcript", callId = "private-call")), "secret-id", more = 22,
        heard = "private-voice", counts = mapOf("working" to 3, "needsYou" to 2, "done" to 20, "failed" to 1, "watching" to 4))

    @Test fun totalsLeadAndOnlyAppWideActionsExistAtEveryEnabledPrivacyLevel() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        for (level in listOf(LiveLevel.MINIMAL, LiveLevel.STANDARD, LiveLevel.DETAILED)) {
            val n = Notices(context).keepAlive(KeepAlive.status(5, "Fixture Mac"), card, level)
            assertEquals("3 Building · 2 Need input · 20 Done", n.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
            assertEquals(listOf("Talk to Nekko", "Open app"), n.actions.map { it.title.toString() })
            assertEquals(Notification.VISIBILITY_PUBLIC, n.visibility)
            if (android.os.Build.VERSION.SDK_INT >= 31) assertTrue(n.actions.first().isAuthenticationRequired)
            val expanded = n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString()
            assertTrue(expanded.contains("4 Watching"))
            assertTrue(expanded.contains("1 Failed"))
            assertTrue(expanded.contains("Voice opens the app"))
            val extras = n.extras.toString()
            for (secret in listOf("private-title", "private-command", "private-transcript", "private-call", "private-voice", "secret-id")) {
                assertFalse(extras.contains(secret))
            }
            assertFalse(n.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
        }
    }

    @Test fun staleAndLegacyCountsAreHonest() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val n = Notices(context).keepAlive(KeepAlive.status(5, "Fixture Mac", fresh = false), card.copy(counts = null), LiveLevel.MINIMAL)
        assertTrue(n.extras.getCharSequence(Notification.EXTRA_TEXT).toString().startsWith("Offline or stale"))
        assertTrue(n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString().contains("Partial counts"))
    }
}

package com.nekko.android

import com.nekko.android.data.Computer
import com.nekko.android.data.ComputersState
import com.nekko.android.widget.StatusSnapshot
import com.nekko.protocol.Activity
import com.nekko.protocol.RelayState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusSnapshotTest {
    private val pc = Computer("a", "Studio", "wss://r.dev", 0)

    @Test fun `headline says what needs you first, as on the iPhone`() {
        fun h(computer: String?, online: Boolean, needs: Int, running: Int) = StatusSnapshot(computer, online, needs, running, 0).headline
        assertEquals("Not paired", h(null, false, 0, 0))
        assertEquals("1 needs you", h("Studio", true, 1, 3))
        assertEquals("2 need you", h("Studio", true, 2, 0))
        assertEquals("1 working", h("Studio", true, 0, 1))
        assertEquals("3 working", h("Studio", false, 0, 3))
        assertEquals("All quiet", h("Studio", true, 0, 0))
        assertEquals("Offline", h("Studio", false, 0, 0))
    }

    @Test fun `the quick settings tile lights only when something waits, and reads counts only`() {
        assertTrue(StatusSnapshot("Studio", true, 1, 0, 0).tileActive)
        assertFalse(StatusSnapshot("Studio", true, 0, 3, 0).tileActive)
        assertFalse(StatusSnapshot(null, false, 2, 0, 0).tileActive)
        assertEquals("Nekko Agent on Studio, 2 need you", StatusSnapshot("Studio", true, 2, 0, 0).tileDescription)
        assertEquals("Nekko Agent, not paired", StatusSnapshot.EMPTY.tileDescription)
    }

    @Test fun `counts come from the active computer's activity, and the time alone is not a change`() {
        val state = ComputersState(
            ready = true, computers = listOf(pc), activeId = "a", conn = RelayState.ONLINE,
            activity = mapOf("s1" to Activity.NEEDS_YOU, "s2" to Activity.RUNNING, "s3" to Activity.RUNNING),
        )
        val s = StatusSnapshot.of(state, now = 5)
        assertEquals(StatusSnapshot("Studio", online = true, needsYou = 1, running = 2, at = 5), s)
        assertTrue(s.sameAs(s.copy(at = 99)))
        assertFalse(s.sameAs(s.copy(needsYou = 0)))
        assertEquals("Not paired", StatusSnapshot.of(ComputersState(ready = true), 0).headline)
    }
}

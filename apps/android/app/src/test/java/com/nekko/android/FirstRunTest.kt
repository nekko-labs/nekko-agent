package com.nekko.android

import com.nekko.android.connection.Notices
import com.nekko.android.data.FirstRun
import com.nekko.android.data.PhonePrefs
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FirstRunTest {
    private fun prefs() = PhonePrefs(MapPrefStore())

    @Test
    fun `a new phone runs the three steps, pairing brings step 3 and its answer ends it`() {
        val p = prefs()
        FirstRun.atLaunch(p, hasComputers = false)
        assertFalse(p.get(FirstRun.DONE))
        FirstRun.paired(p)
        assertTrue("step 3 is next", p.get(FirstRun.NOTIFY_STEP))
        FirstRun.finish(p, allowNotifications = true)
        assertTrue(p.get(FirstRun.DONE))
        assertFalse(p.get(FirstRun.NOTIFY_STEP))
        assertTrue("Notify me stays on", p.get(Notices.NEEDS_YOU) && p.get(Notices.FINISHED) && p.get(Notices.FAILED))
    }

    @Test
    fun `not now turns notify me off`() {
        val p = prefs()
        FirstRun.paired(p)
        FirstRun.finish(p, allowNotifications = false)
        assertTrue(p.get(FirstRun.DONE))
        assertFalse(p.get(Notices.NEEDS_YOU) || p.get(Notices.FINISHED) || p.get(Notices.FAILED))
    }

    @Test
    fun `a phone paired before the first run existed never sees it`() {
        val p = prefs()
        FirstRun.atLaunch(p, hasComputers = true)
        assertTrue(p.get(FirstRun.DONE))
        assertFalse(p.get(FirstRun.NOTIFY_STEP))
    }

    @Test
    fun `step 3 left unanswered comes back at the next start`() {
        val p = prefs()
        FirstRun.paired(p)
        FirstRun.atLaunch(p, hasComputers = true)
        assertFalse(p.get(FirstRun.DONE))
        assertTrue(p.get(FirstRun.NOTIFY_STEP))
    }

    @Test
    fun `skip ends it and pairing later asks nothing`() {
        val p = prefs()
        FirstRun.skip(p)
        FirstRun.paired(p)
        assertTrue(p.get(FirstRun.DONE))
        assertFalse(p.get(FirstRun.NOTIFY_STEP))
    }

    @Test
    fun `each kind starts as the old single switch was, once`() {
        val off = prefs().also { it.set(Notices.ENABLED, false) }
        assertFalse(Notices.wants(off, com.nekko.android.chat.PhoneEvent.APPROVAL))
        assertFalse(Notices.wants(off, com.nekko.android.chat.PhoneEvent.FINISHED))
        // Migrated once: turning one kind on later sticks.
        off.set(Notices.FINISHED, true)
        assertTrue(Notices.wants(off, com.nekko.android.chat.PhoneEvent.FINISHED))
        assertFalse(Notices.wants(off, com.nekko.android.chat.PhoneEvent.NEEDS_INPUT))

        val on = prefs()
        assertTrue(Notices.wants(on, com.nekko.android.chat.PhoneEvent.FAILED))
        on.set(Notices.FAILED, false)
        assertFalse(Notices.wants(on, com.nekko.android.chat.PhoneEvent.FAILED))
        assertTrue("approvals and questions are one switch", Notices.wants(on, com.nekko.android.chat.PhoneEvent.NEEDS_INPUT))
    }
}

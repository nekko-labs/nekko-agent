package com.nekko.android

import com.nekko.android.lock.AppLock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockTest {
    private var clock = 1_000L
    private val saved = mutableListOf<Boolean>()
    private fun lock(enabled: Boolean = true) = AppLock(enabled, now = { clock }, persist = { saved += it })

    @Test
    fun `starts locked when on, unlocked when off`() {
        assertTrue(lock().locked)
        assertFalse(lock(enabled = false).locked)
    }

    @Test
    fun `every trip to the background locks again`() {
        val l = lock()
        l.unlock()
        assertFalse(l.locked)
        l.onBackground()
        assertTrue(l.locked)
        l.onForeground()
        assertTrue(l.locked)
        l.unlock()
        l.onBackground(); l.onForeground()
        assertTrue(l.locked)
    }

    @Test
    fun `each lock gets a new epoch, staying locked does not`() {
        val l = lock()
        val first = l.status.value.epoch
        l.onBackground() // already locked: same lock, so the prompt is not offered again
        assertEquals(first, l.status.value.epoch)
        l.unlock()
        l.onBackground()
        assertEquals(first + 1, l.status.value.epoch)
    }

    @Test
    fun `an announced trip out does not lock if the user is back in time`() {
        val l = lock()
        l.unlock()
        l.expectReturn(withinMs = 60_000)
        l.onBackground()
        assertFalse(l.locked)
        clock += 59_000
        l.onForeground()
        assertFalse(l.locked)
        // The allowance is spent: the next trip locks.
        l.onBackground()
        assertTrue(l.locked)
    }

    @Test
    fun `an announced trip that runs late locks on return`() {
        val l = lock()
        l.unlock()
        l.expectReturn(withinMs = 60_000)
        l.onBackground()
        clock += 60_001
        l.onForeground()
        assertTrue(l.locked)
    }

    @Test
    fun `a trip that ended without leaving does not excuse a later one`() {
        val l = lock()
        l.unlock()
        l.expectReturn(withinMs = 60_000)
        l.returned() // e.g. the scanner failed to open
        l.onBackground()
        assertTrue(l.locked)
    }

    @Test
    fun `a locked app cannot announce a trip`() {
        val l = lock()
        l.expectReturn()
        l.unlock()
        l.onBackground()
        assertTrue(l.locked)
    }

    @Test
    fun `off never locks, and turning it off unlocks and is saved`() {
        val l = lock()
        l.setEnabled(false)
        assertFalse(l.locked)
        assertEquals(listOf(false), saved)
        l.onBackground(); l.onForeground()
        assertFalse(l.locked)
    }

    @Test
    fun `turning it on does not lock the current session, the next trip does`() {
        val l = lock(enabled = false)
        l.setEnabled(true)
        assertFalse(l.locked)
        assertEquals(listOf(true), saved)
        l.onBackground()
        assertTrue(l.locked)
    }

    @Test
    fun `the setting is on by default`() {
        assertTrue(AppLock.ENABLED.default)
        assertEquals("app_lock", AppLock.ENABLED.name)
    }

    @Test
    fun `setting the same value is not saved again`() {
        val l = lock()
        l.setEnabled(true)
        assertTrue(saved.isEmpty())
    }

    @Test
    fun `the privacy cover shows only while paused with the lock on`() {
        val l = lock()
        l.unlock()
        assertFalse(l.covered.value)
        l.onPause()
        assertTrue(l.covered.value)
        l.onResume()
        assertFalse(l.covered.value)
    }

    @Test
    fun `no privacy cover with the lock off, and turning it off lifts one`() {
        val off = lock(enabled = false)
        off.onPause()
        assertFalse(off.covered.value)

        val on = lock()
        on.onPause()
        assertTrue(on.covered.value)
        on.setEnabled(false)
        assertFalse(on.covered.value)
    }

    @Test
    fun `losing focus outside the app covers too, until it comes back`() {
        val l = lock()
        l.unlock()
        l.onFocus(false)
        assertTrue(l.covered.value)
        l.onPause(); l.onFocus(true)
        assertTrue(l.covered.value) // still paused
        l.onResume()
        assertFalse(l.covered.value)
    }

    @Test
    fun `the screenshot toolbar taking focus does not cover the app, either order`() {
        val l = lock()
        l.unlock()
        l.onScreenshot()
        clock += 300
        l.onFocus(false)
        assertFalse(l.covered.value)
        l.onFocus(true)

        clock += 10_000
        l.onFocus(false) // focus first, the callback a moment later: covered, then lifted
        assertTrue(l.covered.value)
        clock += 300
        l.onScreenshot()
        assertFalse(l.covered.value)
    }

    @Test
    fun `an old screenshot does not excuse a later focus loss, and pausing still covers`() {
        val l = lock()
        l.unlock()
        l.onScreenshot()
        clock += 10_000
        l.onFocus(false)
        assertTrue(l.covered.value)
        l.onFocus(true)

        l.onScreenshot(); l.onFocus(false)
        assertFalse(l.covered.value)
        l.onPause() // left the app from the toolbar: the overview shows the cover
        assertTrue(l.covered.value)
        l.onResume(); l.onFocus(true)
        clock += 10_000
        l.onFocus(false) // the next focus loss is judged on its own
        assertTrue(l.covered.value)
    }
}

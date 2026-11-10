package com.nekko.android

import com.nekko.android.chat.AlwaysAllowLink
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The approval notification's Always allow, waiting for its chat's card (#2065). */
class AlwaysAllowLinkTest {
    @Test fun `taken once, for that chat and that call only`() {
        val link = AlwaysAllowLink()
        link.opened("s1", "call_1")
        assertFalse(link.take("s2", "call_1", locked = false))
        assertFalse(link.take("s1", "call_2", locked = false))
        assertTrue(link.take("s1", "call_1", locked = false))
        assertFalse(link.take("s1", "call_1", locked = false))
        assertNull(link.request.value)
    }

    @Test fun `never behind the app lock, it waits for the unlock`() {
        val link = AlwaysAllowLink()
        link.opened("s1", "call_1")
        assertFalse(link.take("s1", "call_1", locked = true))
        assertTrue(link.take("s1", "call_1", locked = false))
    }

    @Test fun `a plain chat link or leaving the app drops it`() {
        val link = AlwaysAllowLink()
        link.opened("s1", "call_1")
        link.opened("s1", null)
        assertFalse(link.take("s1", "call_1", locked = false))

        link.opened("s1", "call_1")
        link.clear()
        assertFalse(link.take("s1", "call_1", locked = false))

        link.opened("s1", "")
        assertNull(link.request.value)
    }
}

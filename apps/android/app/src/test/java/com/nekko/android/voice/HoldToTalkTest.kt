package com.nekko.android.voice

import com.nekko.android.voice.HoldToTalk.Action.*
import com.nekko.android.voice.HoldToTalk.Permission.*
import org.junit.Assert.*
import org.junit.Test

class HoldToTalkTest {
    @Test fun `permission request never arms a recording`() {
        val h = HoldToTalk()
        assertEquals(ASK_PERMISSION, h.press(0, UNDETERMINED))
        assertFalse(h.holding)
        assertEquals(NONE, h.release(1000))
        assertEquals(NONE, h.didStart(1000))
        assertEquals(NONE, h.press(2000, DENIED))
        assertFalse(h.holding)
    }
    @Test fun `release before recorder start discards when start arrives`() {
        val h = HoldToTalk()
        assertEquals(START, h.press(0, GRANTED))
        assertEquals(NONE, h.release(1000))
        assertEquals(DISCARD, h.didStart(2000))
        assertFalse(h.holding)
        assertEquals(START, h.press(3000, GRANTED))
    }
    @Test fun `minimum hold is measured from actual startup not press`() {
        val h = HoldToTalk()
        h.press(0, GRANTED); h.didStart(500)
        assertEquals(DISCARD, h.release(899))
        h.press(1000, GRANTED); h.didStart(1500)
        assertEquals(FINISH, h.release(1900))
        assertEquals(NONE, h.release(2000))
    }
    @Test fun `duplicate press failure and gesture cancellation reset safely`() {
        val h = HoldToTalk()
        h.press(0, GRANTED)
        assertEquals(NONE, h.press(1, GRANTED))
        h.reset()
        assertEquals(NONE, h.didStart(100))
        assertEquals(NONE, h.release(1000))
        assertEquals(START, h.press(2000, GRANTED))
    }
}

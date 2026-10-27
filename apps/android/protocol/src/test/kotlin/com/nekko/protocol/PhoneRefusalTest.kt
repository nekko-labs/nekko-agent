package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The computer's `Not allowed from a paired phone (<code>): <detail>` refusals, in plain words. */
class PhoneRefusalTest {
    private fun refusal(code: String, detail: String) =
        PhoneRefusal.parse("Not allowed from a paired phone ($code): $detail")!!

    @Test fun `parses the code and detail`() {
        assertEquals(PhoneRefusal("change-off", "chat:send"), refusal("change-off", "chat:send"))
        assertEquals(PhoneRefusal("proof-required", "session:setOptions"), PhoneRefusal.parse("Not allowed from a paired phone (proof-required): session:setOptions"))
        assertEquals(PhoneRefusal("channel-denied", ""), PhoneRefusal.parse("Not allowed from a paired phone (channel-denied)"))
    }

    @Test fun `anything else is not a refusal`() {
        assertNull(PhoneRefusal.parse(null))
        assertNull(PhoneRefusal.parse("no such session"))
        assertNull(PhoneRefusal.parse("Not allowed from a paired phone (unclosed"))
        assertNull(PhoneRefusal.parse("chat:send: timed out"))
    }

    @Test fun `the switches say where to turn them on`() {
        assertEquals(
            "Reading from this phone is turned off on Studio. Turn it on in Remote access → What phones can do.",
            refusal("read-off", "sessions:summaries").message("Studio"),
        )
        assertEquals(
            "Changes from this phone are turned off on Studio. Turn them on in Remote access → What phones can do.",
            refusal("change-off", "tool:approve").message("Studio"),
        )
    }

    @Test fun `proof and key refusals say what to do`() {
        val mode = "Confirm with your fingerprint or screen lock to let chats on Studio run with fewer approvals."
        for (channel in listOf(Channels.SESSION_SET_OPTIONS, Channels.SETTINGS_UPDATE)) {
            val r = refusal("proof-required", channel)
            assertTrue(r.isProof)
            assertTrue(r.isModeChange)
            assertEquals(mode, r.message("Studio"))
        }
        val other = refusal("proof-required", "git:commit")
        assertFalse(other.isModeChange)
        assertEquals("Studio couldn’t confirm it was you. Try again.", other.message("Studio"))
        assertEquals("Studio couldn’t confirm it was you. Try again.", refusal("proof-replayed", "git:commit").message("Studio"))
        assertEquals(
            "Studio couldn’t confirm it was you: check that this phone’s clock is right, then try again.",
            refusal("proof-stale", "files:write").message("Studio"),
        )
        assertEquals(
            "Studio knows a different key for this phone. Remove this phone on Studio and pair it again.",
            refusal("key-mismatch", "device:registerKey").message("Studio"),
        )
        assertEquals("Studio couldn’t set up confirmations from this phone. Try again.", refusal("key-missing", "git:push").message("Studio"))
    }

    @Test fun `unknown phones and channels, and codes with no words`() {
        assertEquals("Studio doesn’t know this phone any more. Pair it again.", refusal("device-unknown", "").message("Studio"))
        assertEquals(
            "Studio doesn’t allow this from a phone. Update Nekko Agent on Studio if it’s new.",
            refusal("channel-denied", "files:write").message("Studio"),
        )
        assertNull(refusal("value-invalid", "chat:send").message("Studio"))
        assertFalse(refusal("read-off", "x").isProof)
    }

    @Test fun `the new deny reason parses`() {
        assertEquals(DenyReason.UPDATE_REQUIRED, DenyReason.parse("update-required"))
        assertEquals(DenyReason.INVALID, DenyReason.parse("something-new"))
    }
}

package com.nekko.android

import com.nekko.android.security.KeyClient
import com.nekko.android.security.KeyResult
import com.nekko.android.security.StepUpController
import com.nekko.android.security.StepUpUi
import com.nekko.android.ui.security.UNTESTED_HARDWARE_KEY_NOTE
import com.nekko.android.ui.security.UNTESTED_NOTE_ISSUES_URL
import com.nekko.android.ui.settings.stepUpAction
import com.nekko.android.ui.settings.stepUpMethodLabel
import com.nekko.android.ui.settings.stepUpStatusLine
import com.nekko.protocol.PcSettings
import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.RelayException
import com.nekko.protocol.StepUpChallenge
import com.nekko.protocol.StepUpMethod
import com.nekko.protocol.StepUpProof
import com.nekko.protocol.StepUpRegistration
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The step-up sheet's flow (SK-7), with a fake computer and a fake key. */
class StepUpControllerTest {
    private var n = 0
    private fun challenge(vararg methods: StepUpMethod, rpId: String? = "nekko-computer:abc", expiresAt: Long = 120_000) =
        StepUpChallenge("Y2hhbGxlbmdl${++n}", expiresAt, required = true, methods = methods.toSet(), rpId = rpId)

    private class FakeKeys(var answer: KeyResult<StepUpProof.Assertion>) : KeyClient {
        val asked = mutableListOf<Pair<String, String>>()
        override suspend fun assertion(challenge: String, rpId: String): KeyResult<StepUpProof.Assertion> {
            asked += challenge to rpId
            return answer
        }
        override suspend fun register(
            challenge: String, rpId: String, rpName: String, userId: ByteArray, userName: String, kind: StepUpMethod,
        ): KeyResult<StepUpRegistration> = KeyResult.Cancelled
    }

    private val assertion = StepUpProof.Assertion("aWQ", "YXV0aA", "Y2Rq", "c2ln")
    private fun refused(code: String) =
        RelayException("plain words", PhoneRefusal.parse("Not allowed from a paired phone ($code): settings:update"))

    @Test fun `a key answers the challenge it was given and the call goes again with it`() = runTest {
        val sent = mutableListOf<StepUpProof>()
        val keys = FakeKeys(KeyResult.Ok(assertion))
        val issued = mutableListOf<StepUpChallenge>()
        val c = StepUpController({ challenge(StepUpMethod.SECURITY_KEY, StepUpMethod.TOTP).also { issued += it } }, { sent += it }, keys, "Studio", now = { 0 })
        c.open()
        assertEquals(StepUpUi.Phase.READY, c.ui.value.phase)
        assertTrue(c.ui.value.offersKey)
        assertTrue(c.ui.value.offersCode)
        c.useKey()
        assertEquals("the unspent challenge from opening the sheet", listOf(issued[0].challenge to "nekko-computer:abc"), keys.asked)
        assertEquals(listOf<StepUpProof>(assertion), sent)
        assertEquals(StepUpUi.Phase.DONE, c.ui.value.phase)
    }

    @Test fun `every try after a refusal gets a fresh challenge and says why in plain words`() = runTest {
        var tries = 0
        val keys = FakeKeys(KeyResult.Ok(assertion))
        val c = StepUpController(
            { challenge(StepUpMethod.SECURITY_KEY) },
            { if (++tries == 1) throw refused("step-up-replayed") },
            keys, "Studio", now = { 0 },
        )
        c.open()
        c.useKey()
        assertEquals("That confirmation was already used. Try again.", c.ui.value.error)
        assertEquals(StepUpUi.Phase.READY, c.ui.value.phase)
        c.useKey()
        assertEquals(StepUpUi.Phase.DONE, c.ui.value.phase)
        assertEquals(2, keys.asked.size)
        assertTrue("never the same challenge twice", keys.asked[0].first != keys.asked[1].first)
    }

    @Test fun `an expired challenge is not sent to the key`() = runTest {
        var now = 0L
        val keys = FakeKeys(KeyResult.Ok(assertion))
        val issued = mutableListOf<String>()
        val c = StepUpController({ challenge(StepUpMethod.PASSKEY, expiresAt = now + 120_000).also { issued += it.challenge } }, {}, keys, "Studio", now = { now })
        c.open()
        now = 115_000
        c.useKey()
        assertEquals(issued[1], keys.asked.single().first)
    }

    @Test fun `a code is six digits, sent as totp, with no key involved`() = runTest {
        val sent = mutableListOf<StepUpProof>()
        val c = StepUpController({ challenge(StepUpMethod.TOTP) }, { sent += it }, null, "Studio", now = { 0 })
        c.open()
        assertFalse(c.ui.value.offersKey)
        assertTrue(c.ui.value.offersCode)
        c.useCode("12 34")
        assertEquals("Enter the six digits from your authenticator app.", c.ui.value.error)
        assertTrue(sent.isEmpty())
        c.useCode("123 456")
        assertEquals(listOf<StepUpProof>(StepUpProof.Totp("123456")), sent)
        assertEquals(StepUpUi.Phase.DONE, c.ui.value.phase)
    }

    @Test fun `a wrong code says so and the sheet stays`() = runTest {
        val c = StepUpController({ challenge(StepUpMethod.TOTP) }, { throw refused("step-up-invalid") }, null, "Studio", now = { 0 })
        c.open()
        c.useCode("000000")
        assertEquals("That key or code was not accepted. Try again.", c.ui.value.error)
        assertEquals(StepUpUi.Phase.READY, c.ui.value.phase)
    }

    @Test fun `keys the phone can't ask fall back to the code and say why`() = runTest {
        // No rpId in the reply (a computer from before it was sent), keys and a code registered.
        val c = StepUpController({ challenge(StepUpMethod.SECURITY_KEY, StepUpMethod.TOTP, rpId = null) }, {}, FakeKeys(KeyResult.Ok(assertion)), "Studio", now = { 0 })
        c.open()
        assertFalse(c.ui.value.offersKey)
        assertTrue(c.ui.value.keysUnavailable)
        assertTrue(c.ui.value.offersCode)

        // The platform refuses the relying party (Digital Asset Links): the same words.
        val k = StepUpController({ challenge(StepUpMethod.SECURITY_KEY, StepUpMethod.TOTP) }, {}, FakeKeys(KeyResult.Failed(KeyResult.Why.RP_REFUSED)), "Studio", now = { 0 })
        k.open()
        k.useKey()
        assertEquals(
            "Security keys and passkeys for Studio can’t be used from this phone yet. Use a code from your authenticator app.",
            k.ui.value.error,
        )
    }

    @Test fun `keys only, and none askable, means do it on the computer`() = runTest {
        val c = StepUpController({ challenge(StepUpMethod.SECURITY_KEY, rpId = null) }, {}, null, "Studio", now = { 0 })
        c.open()
        assertEquals(StepUpUi.Phase.NO_METHOD, c.ui.value.phase)
    }

    @Test fun `cancelling the system sheet says nothing`() = runTest {
        val c = StepUpController({ challenge(StepUpMethod.PASSKEY) }, { error("not sent") }, FakeKeys(KeyResult.Cancelled), "Studio", now = { 0 })
        c.open()
        c.useKey()
        assertNull(c.ui.value.error)
        assertFalse(c.ui.value.busy)
        assertEquals(StepUpUi.Phase.READY, c.ui.value.phase)
    }

    @Test fun `a computer that can't issue a challenge is named`() = runTest {
        val c = StepUpController({ throw RelayException("Studio doesn’t allow this from a phone. Update Nekko Agent on Studio if it’s new.") }, {}, null, "Studio", now = { 0 })
        c.open()
        assertEquals("Studio doesn’t allow this from a phone. Update Nekko Agent on Studio if it’s new.", c.ui.value.error)
        assertFalse(c.ui.value.busy)
    }

    @Test fun `the words around the sheet and the methods`() {
        assertEquals("Switch new chats on Studio to YOLO", stepUpAction(PcSettings.patch(mode = PcSettings.ChatMode.YOLO), "Studio"))
        assertEquals("Change Studio’s settings", stepUpAction(PcSettings.patch(skipConfirm = true), "Studio"))
        assertEquals(listOf("Security key", "Passkey", "One-time code"), StepUpController.KIND_ORDER.map(::stepUpMethodLabel))
        assertEquals("Shows once Studio is connected.", stepUpStatusLine("Studio", null))
        assertEquals("Off on Studio. Turn it on there in Settings → Security.", stepUpStatusLine("Studio", challenge().copy(required = false)))
    }

    @Test fun `the hardware-key note is the owner's words exactly`() {
        assertEquals(
            "The Devs don’t have a hardware security key to test this one, so we tried our best without one! If you see any issues, please let us know 🙏",
            UNTESTED_HARDWARE_KEY_NOTE,
        )
        assertTrue(UNTESTED_HARDWARE_KEY_NOTE.contains("let us know"))
        assertEquals("https://github.com/nekko-labs/nekko-agent/issues/new", UNTESTED_NOTE_ISSUES_URL)
    }
}

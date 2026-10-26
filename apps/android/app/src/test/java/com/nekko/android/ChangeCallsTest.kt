package com.nekko.android

import com.nekko.android.security.ChangeCalls
import com.nekko.protocol.ChangeProof
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayException
import com.nekko.protocol.SoftwareChangeSigner
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChangeCallsTest {
    private companion object {
        // Change-class channels on the computer; the Android screens for them come later.
        const val FILES_WRITE = "files:write"
        const val GIT_STAGE = "git:stage"
        const val GIT_PUSH = "git:push"
    }

    private val config = RelayConfig("wss://relay.example.dev", "room", "key", ByteArray(32), "phone-1", "Pixel Test")

    private fun refused(code: String, channel: String): Nothing =
        throw RelayException("Not allowed from a paired phone ($code): $channel")

    private fun remote(handler: suspend (Call) -> JsonElement) = FakeRemote(config, handler)

    private fun ok() = buildJsonObject { put("ok", true) }

    @Test fun `registers once, then signs each call with a later timestamp`() = runTest {
        val r = remote { ok() }
        val calls = ChangeCalls(r, SoftwareChangeSigner.generate(), "phone-1", "Studio", now = { 5_000L })
        calls.call(FILES_WRITE, listOf(JsonPrimitive("s1")))
        calls.call(FILES_WRITE, listOf(JsonPrimitive("s1")))
        assertEquals(listOf(ChangeProof.KEY_CHANNEL, FILES_WRITE, FILES_WRITE), r.channels())
        val ts = r.calls.map { it.proof!!["ts"]!!.jsonPrimitive.content.toLong() }
        assertEquals("never the same timestamp twice, even within one millisecond", listOf(5_000L, 5_001L, 5_002L), ts)
    }

    @Test fun `a computer that lost the key gets it again, once`() = runTest {
        var known = false
        val r = remote { c ->
            when {
                c.channel == ChangeProof.KEY_CHANNEL -> ok().also { known = true }
                !known -> refused("key-missing", c.channel)
                else -> ok()
            }
        }
        val calls = ChangeCalls(r, SoftwareChangeSigner.generate(), "phone-1", "Studio")
        calls.call(GIT_STAGE, listOf(JsonPrimitive("s1")))
        known = false // this phone was paired again on the computer's side
        calls.call(GIT_STAGE, listOf(JsonPrimitive("s1")))
        assertEquals(
            listOf(ChangeProof.KEY_CHANNEL, GIT_STAGE, GIT_STAGE, ChangeProof.KEY_CHANNEL, GIT_STAGE),
            r.channels(),
        )
    }

    @Test fun `a refusal says what to do and keeps the computer's code`() = runTest {
        val r = remote { c -> if (c.channel == ChangeProof.KEY_CHANNEL) ok() else refused("change-off", c.channel) }
        val calls = ChangeCalls(r, SoftwareChangeSigner.generate(), "phone-1", "Studio")
        val e = runCatching { calls.call(GIT_PUSH, listOf(JsonPrimitive("s1"))) }.exceptionOrNull() as RelayException
        assertEquals("Changes from this phone are turned off on Studio. Turn them on in Remote access → What phones can do.", e.message)
        assertEquals("change-off", e.refusal?.code)

        val mismatch = remote { c -> refused("key-mismatch", c.channel) }
        val m = runCatching {
            ChangeCalls(mismatch, SoftwareChangeSigner.generate(), "phone-1", "Studio").call(GIT_PUSH, emptyList())
        }.exceptionOrNull() as RelayException
        assertEquals("Studio knows a different key for this phone. Remove this phone on Studio and pair it again.", m.message)
        assertEquals("only the key was tried", listOf(ChangeProof.KEY_CHANNEL), mismatch.channels())
    }

    @Test fun `arguments the computer can't check are never sent`() = runTest {
        val r = remote { ok() }
        val calls = ChangeCalls(r, SoftwareChangeSigner.generate(), "phone-1", "Studio")
        val e = runCatching { calls.call(FILES_WRITE, listOf(JsonArray(listOf(JsonPrimitive(1.5))))) }.exceptionOrNull()
        assertEquals("This change can’t be sent from a phone.", e?.message)
        assertTrue(r.calls.none { it.channel == FILES_WRITE })
    }
}

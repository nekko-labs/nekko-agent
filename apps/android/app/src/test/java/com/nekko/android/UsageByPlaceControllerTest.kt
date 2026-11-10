package com.nekko.android

import com.nekko.android.beyond.UsageByPlaceController
import com.nekko.android.data.PhonePrefs
import com.nekko.protocol.Channels
import com.nekko.protocol.PhoneUsageLedger
import com.nekko.protocol.RelayException
import com.nekko.protocol.UsagePlace
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/** #2114: every paired computer read over its own link, offline ones keep their last numbers, then this phone. */
class UsageByPlaceControllerTest {
    private fun computer(tokens: Int, fail: Boolean = false) = FakeCaller { c ->
        if (fail) throw RelayException("timed out")
        when (c.channel) {
            Channels.USAGE_SUMMARY -> Json.parseToJsonElement("""{"totalInput":$tokens,"totalOutput":0,"totalCost":1.5,"byModel":[{"model":"opus","input":$tokens,"output":0,"cost":0,"subscription":true}],"daily":[]}""")
            Channels.PROVIDERS_LIST -> Json.parseToJsonElement("""[{"id":"claude","kind":"anthropic","label":"Claude","enabled":true},{"id":"off","kind":"openai","label":"Off","enabled":false},{"id":"broken","kind":"openai","label":"B","enabled":true}]""")
            Channels.LIMITS_GET -> when (c.args.first().jsonPrimitive.content) {
                "claude" -> Json.parseToJsonElement("""{"planType":"max","windows":[{"id":"w","label":"5 hours","usedPercent":40,"status":"allowed"}]}""")
                "broken" -> throw RelayException("timed out")
                else -> JsonNull
            }
            else -> JsonNull
        }
    }

    @Test fun `online computers are read, offline ones keep their last numbers and get nothing sent`() = runTest {
        val prefs = PhonePrefs(MapPrefStore())
        val mac = computer(1000)
        val pc = computer(2000)
        var pcOnline = true
        var phone: PhoneUsageLedger? = null
        val u = UsageByPlaceController({ listOf("mac" to "Mac", "pc" to "PC") }, { id -> if (id == "mac") mac else pc.takeIf { pcOnline } }, { phone }, prefs, now = { 7 })
        u.load()
        assertEquals(listOf("mac", "pc"), u.state.value.places.map { it.id })
        assertTrue(u.state.value.places.all { it.online })
        assertEquals("Limits by provider id, never for a disabled one; a failed one leaves no plan", listOf("Claude · Max"), u.state.value.places.first().plans.map { it.title })
        assertTrue(mac.calls.none { it.channel == Channels.LIMITS_GET && it.args.first().jsonPrimitive.content == "off" })

        // The PC goes offline and the phone has chats of its own.
        pcOnline = false
        phone = PhoneUsageLedger().record("a", "Claude", "haiku", 10, 5, 0, ZoneOffset.UTC)
        val before = pc.calls.size
        UsageByPlaceController({ listOf("mac" to "Mac", "pc" to "PC") }, { id -> if (id == "mac") mac else pc.takeIf { pcOnline } }, { phone }, prefs).also { it.load() }.state.value.places.let { places ->
            assertEquals(listOf("mac", "pc", PhoneUsageLedger.PHONE_ID), places.map { it.id })
            val offline = places[1]
            assertFalse(offline.online)
            assertEquals("Its last numbers, read on this phone before", 2000L, offline.totalTokens)
            assertEquals(7L, offline.readAt)
            assertNull(offline.error)
            assertEquals(UsagePlace.Kind.PHONE, places.last().kind)
        }
        assertEquals("Nothing is sent to an offline computer", before, pc.calls.size)
    }

    @Test fun `a computer that fails keeps its last numbers and says why, one never read says nothing`() = runTest {
        val prefs = PhonePrefs(MapPrefStore())
        UsageByPlaceController({ listOf("mac" to "Mac") }, { computer(1000) }, { null }, prefs).load()
        val u = UsageByPlaceController({ listOf("mac" to "Mac", "new" to "New") }, { id -> if (id == "mac") computer(0, fail = true) else null }, { null }, prefs)
        u.load()
        val (mac, new) = u.state.value.places
        assertFalse(mac.online)
        assertEquals("timed out", mac.error)
        assertEquals(1000L, mac.totalTokens)
        assertFalse(new.online)
        assertNull(new.summary)
        assertTrue("An empty ledger is not a place", u.state.value.places.none { it.kind == UsagePlace.Kind.PHONE })
    }
}

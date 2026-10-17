package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as the iPhone app's NearbyTests, except where Android's relay rule is stricter. */
class NearbyComputerTest {
    @Test fun `a computer with its own relay`() {
        val c = NearbyComputer.from("Studio", mapOf("v" to "1", "name" to "Studio", "relay" to "ws://studio.tail1234.ts.net:4400"))
        assertEquals(NearbyComputer("Studio", "Studio", "ws://studio.tail1234.ts.net:4400"), c)
    }

    @Test fun `the instance name stands in for a missing name`() {
        assertEquals("Studio", NearbyComputer.from("Studio", mapOf("v" to "1"))?.name)
        assertNull(NearbyComputer.from("  ", mapOf("v" to "1", "name" to "\u0007")))
    }

    @Test fun `other versions are skipped`() {
        assertNull(NearbyComputer.from("Studio", mapOf("name" to "Studio")))
        assertNull(NearbyComputer.from("Studio", mapOf("v" to "2", "name" to "Studio")))
    }

    @Test fun `a relay the phone would refuse is not shown`() {
        val relay = { r: String -> NearbyComputer.from("S", mapOf("v" to "1", "relay" to r))?.relayUrl }
        assertNull("plain ws:// to the internet", relay("ws://example.com:4400"))
        assertNull("the phone itself", relay("wss://localhost:4400"))
        assertNull("not a relay address", relay("https://studio.tail1234.ts.net"))
        assertNull(relay("javascript:alert(1)"))
        assertNull("Android allows plain ws:// only to *.ts.net", relay("ws://192.168.1.20:4400"))
        assertEquals("wss://relay.example.com", relay("wss://relay.example.com"))
    }

    @Test fun `names are one short line`() {
        val c = NearbyComputer.from("x", mapOf("v" to "1", "name" to "Philip’s\nMac\u0000  mini" + "!".repeat(100)))
        assertTrue(c!!.name.startsWith("Philip’s Mac mini"))
        assertEquals(NearbyComputer.MAX_NAME, c.name.length)
    }

    @Test fun `the list is sorted by name`() {
        val list = listOf(NearbyComputer("b", "studio", null), NearbyComputer("a", "Attic", null))
        assertEquals(listOf("a", "b"), NearbyComputer.sorted(list).map { it.id })
    }
}

package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** Same cases as apps/mobile/src/lib/pairing.test.ts. */
class PairingTest {
    private val room = "a1b2c3d4e5f60718"
    private val key = "00112233445566778899aabbccddeeff"

    @Test fun `parses the desktop deep link`() {
        val l = Pairing.parse("nekko-agent-pair:?relay=${enc("wss://relay.example.com/")}&room=$room&key=$key&pair=abcd2345")!!
        assertEquals("wss://relay.example.com", l.relayUrl)
        assertEquals(room, l.room)
        assertEquals(key, l.key)
        assertEquals("ABCD2345", l.pair)
    }

    @Test fun `parses the Local Web UI link and a bare query`() {
        val web = Pairing.parse("https://host.example/?relay=wss%3A%2F%2Fr.example&room=$room&key=$key#frag")!!
        assertEquals("wss://r.example", web.relayUrl)
        assertNull(web.pair)
        val bare = Pairing.parse("  relay=ws://10.0.0.2:4500&room=$room&key=$key  ")!!
        assertEquals("ws://10.0.0.2:4500", bare.relayUrl)
    }

    @Test fun `refuses incomplete or malformed links`() {
        assertNull(Pairing.parse(""))
        assertNull(Pairing.parse("nekko-agent-pair:?relay=wss://r&room=$room"))
        assertNull(Pairing.parse("nekko-agent-pair:?relay=https://r&room=$room&key=$key"))
        assertNull(Pairing.parse("nekko-agent-pair:?relay=wss://r&room=nothex!&key=$key"))
        assertNull(Pairing.parse("nekko-agent-pair:?relay=wss://r&room=$room&key=short"))
        assertNull(Pairing.parse("nekko-agent-pair:?relay=wss://r&room=$room&key=$key%ZZ"))
    }

    /** The shared fixture (packages/shared/src/pairing-link.golden.test.ts writes it): every phone parses alike. */
    @Test fun `parses the shared fixture like the computer, alt routes included`() {
        val cases = kotlinx.serialization.json.Json.parseToJsonElement(javaClass.getResource("/pairing-links.json")!!.readText())
            as kotlinx.serialization.json.JsonArray
        for (c in cases) {
            val o = c as kotlinx.serialization.json.JsonObject
            val input = (o["input"] as kotlinx.serialization.json.JsonPrimitive).content
            val want = o["link"]
            val got = Pairing.parse(input)
            if (want is kotlinx.serialization.json.JsonNull) {
                assertNull(input, got)
                continue
            }
            val w = want as kotlinx.serialization.json.JsonObject
            fun s(k: String) = (w[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
            assertEquals(input, s("relayUrl"), got?.relayUrl)
            assertEquals(input, s("room"), got?.room)
            assertEquals(input, s("key"), got?.key)
            assertEquals(input, s("pair"), got?.pair)
            assertEquals(input, s("hostKey"), got?.hostKey)
            val alts = (w["alts"] as kotlinx.serialization.json.JsonArray).map { (it as kotlinx.serialization.json.JsonPrimitive).content }
            assertEquals(input, alts, got?.alts)
        }
    }

    @Test fun `reads the host key out of its percent-encoding`() {
        val host = "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="
        val slashes = host.replace("B", "/")
        assertEquals(host, Pairing.parse("relay=wss://r&room=$room&key=$key&host=${enc(host)}")!!.hostKey)
        assertEquals(slashes, Pairing.parse("relay=wss://r&room=$room&key=$key&host=${enc(slashes)}")!!.hostKey)
    }

    @Test fun `a link without a usable host key has none`() {
        val host = "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="
        assertNull(Pairing.parse("relay=wss://r&room=$room&key=$key")!!.hostKey)
        assertNull("a bare + reads as a space", Pairing.parse("relay=wss://r&room=$room&key=$key&host=$host")!!.hostKey)
        assertNull("one character short", Pairing.parse("relay=wss://r&room=$room&key=$key&host=${enc(host.drop(1))}")!!.hostKey)
        assertNull("no padding", Pairing.parse("relay=wss://r&room=$room&key=$key&host=${enc(host.dropLast(1))}")!!.hostKey)
    }

    @Test fun `never prints the secret`() {
        val l = Pairing.parse("relay=wss://r&room=$room&key=$key")!!
        assertFalse(l.toString().contains(key))
    }

    @Test fun `shows the relay host`() {
        assertEquals("nekko-agent-relay.fly.dev", Pairing.relayHost("wss://nekko-agent-relay.fly.dev/relay"))
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, Charsets.UTF_8)
}

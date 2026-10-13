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

    @Test fun `parses the web edition link and a bare query`() {
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

    @Test fun `never prints the secret`() {
        val l = Pairing.parse("relay=wss://r&room=$room&key=$key")!!
        assertFalse(l.toString().contains(key))
    }

    @Test fun `shows the relay host`() {
        assertEquals("nekko-agent-relay.fly.dev", Pairing.relayHost("wss://nekko-agent-relay.fly.dev/relay"))
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, Charsets.UTF_8)
}

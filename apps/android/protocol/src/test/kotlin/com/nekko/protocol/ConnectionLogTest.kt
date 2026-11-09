package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ConnectionLogTest {
    @Test fun `retries fold into one entry and the log stays bounded`() {
        val log = ConnectionLog()
        val t0 = Instant.EPOCH
        log.record(RelayState.CONNECTING, at = t0)
        log.record(RelayState.CONNECTING, "handshake timed out", at = t0)
        log.record(RelayState.CONNECTING, "handshake timed out", at = t0)
        log.record(RelayState.ONLINE, at = t0.plusSeconds(5))
        assertEquals(listOf(RelayState.CONNECTING, RelayState.CONNECTING, RelayState.ONLINE), log.entries.map { it.state })
        assertEquals(2, log.entries[1].repeats)
        assertEquals(t0.plusSeconds(5), log.lastOnline)
        repeat(ConnectionLog.CAPACITY * 2) { i -> log.record(if (i % 2 == 0) RelayState.OFFLINE else RelayState.CONNECTING, at = t0) }
        assertEquals(ConnectionLog.CAPACITY, log.entries.size)
        assertEquals(ConnectionLog.CAPACITY, log.entries.map { it.id }.toSet().size)
    }

    @Test fun `the copied text holds only the host, states and details`() {
        val log = ConnectionLog()
        log.record(RelayState.CONNECTING, "relay closed (1006)", at = Instant.EPOCH)
        log.record(RelayState.DENIED, "bad-key", DenyReason.BAD_KEY, at = Instant.ofEpochSecond(1))
        assertEquals(
            "Relay: studio.tail1234.ts.net (tailscale)\n" +
                "1970-01-01T00:00:00Z connecting – relay closed (1006)\n" +
                "1970-01-01T00:00:01Z denied [bad-key]",
            log.text("studio.tail1234.ts.net", tailnet = true),
        )
    }

    @Test fun `advice follows the route and state`() {
        fun ask(url: String, state: RelayState, denied: DenyReason? = null, tailscale: Boolean = true, detail: String? = null) =
            ConnectionAdvice.advise(url, "Studio", state, denied, detail, tailscale, debug = false)
        val ts = "ws://studio.tail1234.ts.net:4400"
        assertEquals(emptyList<String>(), ask(ts, RelayState.ONLINE))
        assertTrue(ask(ts, RelayState.CONNECTING, tailscale = false).first().startsWith("Tailscale is off"))
        assertTrue(ask(ts, RelayState.CONNECTING).first().startsWith("Tailscale is on"))
        assertTrue(ask("ws://relay.example:4400", RelayState.CONNECTING).first().contains("not encrypted"))
        assertTrue(ask("wss://relay.example", RelayState.OFFLINE).first().contains("isn’t connected to it"))
        val badKey = ConnectionAdvice.advise("wss://relay.example", "Mac", RelayState.OFFLINE, null, RelayStatus.BAD_KEY, phoneOnTailnet = false, debug = false)
        assertEquals(ConnectionAdvice.advise("wss://relay.example", "Mac", RelayState.DENIED, DenyReason.BAD_KEY, null, phoneOnTailnet = false, debug = false), badKey)
        assertTrue(ask("wss://relay.example", RelayState.DENIED, DenyReason.BAD_CODE).first().contains("10 minutes"))
        assertTrue(ask("wss://relay.example", RelayState.DENIED, DenyReason.REVOKED).first().contains("removed this phone"))
        assertTrue(ask("wss://relay.example", RelayState.CONNECTING, detail = "TLS certificate not trusted").any { it.contains("certificate") })
    }

    @Test fun `a gone relay name says pair again, not check the internet`() {
        val gone = ConnectionAdvice.advise("wss://relay.example", "Studio", RelayState.CONNECTING, null, RelayStatus.HOST_NOT_FOUND, phoneOnTailnet = false, debug = false)
        assertTrue(gone.first().contains("relay.example doesn’t exist"))
        assertTrue(gone.any { it.contains("pair this phone again") })
        assertTrue(gone.none { it.startsWith("Check this phone is online") })
    }
}

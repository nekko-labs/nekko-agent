package com.nekko.protocol

import kotlinx.coroutines.runBlocking
import java.net.ServerSocket
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** IO-21 on Android: the Connection status screen's checks and *Share diagnostics*, the iPhone's DiagnosticsTests. */
class DiagnosticsTest {
    private class FakeNetwork(val addresses: Map<String, List<String>> = emptyMap(), val open: Set<String> = emptySet()) : ProbeNetwork {
        override suspend fun resolve(host: String, timeoutMs: Long) = addresses[host] ?: throw RelayException("unknown host")
        override suspend fun connect(address: String, port: Int, timeoutMs: Long) {
            if ("$address:$port" !in open) throw RelayException("Connection refused")
        }
    }

    /** A clock that moves 12 ms per read. */
    private fun ticks(): () -> Long { var t = 0L; return { t += 12; t } }

    @Test fun `every step with timings when the route works`() = runBlocking {
        val net = FakeNetwork(mapOf("studio.tail1234.ts.net" to listOf("100.101.102.103")), setOf("100.101.102.103:4400"))
        val r = Diagnostics.check("ws://studio.tail1234.ts.net:4400", net, clock = ticks()) { url ->
            assertEquals("ws://studio.tail1234.ts.net:4400", url)
            ProbeStep(true, 40, "Your computer answered")
        }
        assertEquals(ProbeStep(true, 12, "100.101.102.103"), r.dns)
        assertEquals(ProbeStep(true, 12, "Port 4400 open"), r.tcp)
        assertEquals(true, r.hello?.ok)
        assertTrue(r.ok)
        assertEquals(RelayRoute.TAILSCALE, r.kind)
    }

    @Test fun `tries every address the name has`() = runBlocking {
        // localhost: ::1 first, while the relay listens on 127.0.0.1.
        val net = FakeNetwork(mapOf("localhost" to listOf("::1", "127.0.0.1")), setOf("127.0.0.1:4400"))
        val r = Diagnostics.check("ws://localhost:4400", net) { ProbeStep(true, detail = "answered") }
        assertEquals("Port 4400 open on 127.0.0.1", r.tcp?.detail)
        assertEquals(true, r.hello?.ok)
    }

    @Test fun `stops at the first failed step`() = runBlocking {
        val net = FakeNetwork(mapOf("studio.tail1234.ts.net" to listOf("100.101.102.103")))
        val noName = Diagnostics.check("ws://nowhere.tail1234.ts.net:4400", net) { fail("no hello after a failed lookup"); ProbeStep(true) }
        assertEquals(false, noName.dns?.ok)
        assertNull(noName.tcp)
        assertNull(noName.hello)

        val closed = Diagnostics.check("ws://192.168.1.20:4400", net) { fail("no hello after a failed connect"); ProbeStep(true) }
        assertEquals(ProbeStep(true, 0, "Address, no lookup needed"), closed.dns)
        assertEquals(false, closed.tcp?.ok)
        assertEquals("Connection refused", closed.tcp?.detail)
        assertNull(closed.hello)
        assertFalse(closed.ok)
    }

    @Test fun `reads host and port`() {
        assertEquals("192.168.1.20" to 4400, Diagnostics.hostPort("ws://192.168.1.20:4400"))
        assertEquals("relay.example.com" to 443, Diagnostics.hostPort("wss://relay.example.com"))
        assertEquals("studio.local" to 80, Diagnostics.hostPort("ws://studio.local/"))
        assertEquals("fd7a:115c:a1e0::5" to 4400, Diagnostics.hostPort("ws://[fd7a:115c:a1e0::5]:4400"))
        assertNull(Diagnostics.hostPort("https://relay.example.com"))
    }

    @Test fun `the shared text never carries rooms, keys or codes`() {
        val leaky = "Could not connect: ws://r/relay?role=client&room=abcd1234abcd1234&key=00112233445566778899aabbccddeeff&pair=AB12CD"
        val reports = listOf(
            RouteReport("ws://192.168.1.20:4400", ProbeStep(true, 0), ProbeStep(false, 3, leaky)),
            RouteReport("ws://studio.tail1234.ts.net:4400", ProbeStep(true, 8, "100.101.102.103"), ProbeStep(true, 20), ProbeStep(true, 51, "Your computer answered")),
        )
        val log = ConnectionLog()
        log.record(RelayState.CONNECTING, detail = leaky, at = Instant.EPOCH)
        val text = Diagnostics.text(
            "Nekko Agent for Android 0.1.0 (Android 16)", NetworkPath.LOCAL, "ws://studio.tail1234.ts.net:4400", reports,
            log.text("studio.tail1234.ts.net:4400", tailnet = true), Instant.EPOCH,
        )
        for (secret in listOf("abcd1234abcd1234", "00112233445566778899aabbccddeeff", "AB12CD")) assertFalse("$secret leaked:\n$text", text.contains(secret))
        assertTrue(text, text.contains("Route in use: studio.tail1234.ts.net:4400 (tailscale)"))
        assertTrue(text.contains("Route 192.168.1.20:4400 (lan): problem"))
        assertTrue(text.contains("  hello: skipped"))
        assertTrue(text.contains("  hello: ok 51 ms – Your computer answered"))
        assertTrue(text.contains("Network: local"))
    }

    @Test fun `the hello reads the throwaway connection's first answer`() {
        assertEquals(ProbeStep(true, 9, "Mac answered"), Diagnostics.helloStep(RelayStatus(RelayState.ONLINE), "Mac", 9, 8_000))
        assertEquals("The relay answered; Mac isn’t connected to it", Diagnostics.helloStep(RelayStatus(RelayState.OFFLINE), "Mac", 9, 8_000).detail)
        assertEquals(ProbeStep(false, 9, "Refused: revoked"), Diagnostics.helloStep(RelayStatus(RelayState.DENIED, denied = DenyReason.REVOKED), "Mac", 9, 8_000))
        assertEquals(ProbeStep(false, 8_000, "No answer in 8 s"), Diagnostics.helloStep(null, "Mac", 8_000, 8_000))
    }

    // The real network calls, on this machine.

    @Test fun `resolves localhost and a numeric address`() = runBlocking {
        val net = JvmProbeNetwork()
        val found = net.resolve("localhost", 3_000)
        assertTrue("$found", "127.0.0.1" in found || "0:0:0:0:0:0:0:1" in found || "::1" in found)
        assertEquals(listOf("127.0.0.1"), net.resolve("127.0.0.1", 3_000))
    }

    @Test fun `connects to a listening port and not to a closed one`() = runBlocking {
        val server = ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
        val port = server.localPort
        val net = JvmProbeNetwork()
        net.connect("127.0.0.1", port, 2_000)
        server.close()
        try {
            net.connect("127.0.0.1", port, 2_000)
            fail("a closed port connected")
        } catch (e: Exception) {
            assertFalse(e.message.isNullOrEmpty())
        }
    }
}

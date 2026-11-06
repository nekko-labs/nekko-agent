package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The network security config permits cleartext app-wide, so the transport is
 * the barrier: plain ws:// to the open internet must be refused before any
 * socket is opened, and ws:// to a private network must still be dialed.
 */
class OkHttpTransportTest {
    private class Recorder : WsListener {
        val closed = CountDownLatch(1)
        @Volatile var called = false
        override fun onOpen() { called = true }
        override fun onMessage(text: String) { called = true }
        override fun onClosed(code: Int, reason: String) { called = true; closed.countDown() }
    }

    @Test fun `plain ws to the open internet is refused before dialing`() {
        for (url in listOf("ws://relay.example.com:4400/relay", "WS://8.8.8.8:4400/relay", "ws://[2001:db8::1]:4400/relay")) {
            val l = Recorder()
            try {
                OkHttpTransport().open(url, l)
                fail("dialed $url")
            } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.contains("wss://"))
            }
            assertFalse("no callback for a refused $url", l.called)
        }
    }

    @Test fun `plain ws to a private network is dialed`() {
        // A loopback port that accepts the TCP connection and then closes it:
        // the socket really goes out, and fails on the missing upgrade.
        ServerSocket(0).use { server ->
            val accepted = CountDownLatch(1)
            Thread { runCatching { server.accept().use { accepted.countDown() } } }.start()
            val l = Recorder()
            OkHttpTransport().open("ws://127.0.0.1:${server.localPort}/relay", l)
            assertTrue("the transport connected", accepted.await(5, TimeUnit.SECONDS))
            assertTrue("and reported the failed upgrade", l.closed.await(5, TimeUnit.SECONDS))
        }
    }

    @Test fun `the guard matches the route rule`() {
        assertTrue(RelayRoute.publicCleartext("ws://relay.example.com"))
        assertFalse(RelayRoute.publicCleartext("wss://relay.example.com"))
        for (url in listOf("ws://192.168.1.20:4400", "ws://studio.tail1234.ts.net:4400", "ws://100.101.102.103:4400", "ws://mac.local:4400", "ws://localhost:4400")) {
            assertFalse(url, RelayRoute.publicCleartext(url))
        }
        assertEquals(RelayRoute.INTERNET, RelayRoute.of("ws://evil-ts.net.example.com"))
    }
}

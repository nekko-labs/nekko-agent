package com.nekko.protocol

import com.nekko.protocol.RelayHint.Problem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayHintTest {
    @Test fun `wss relays always work`() {
        assertNull(RelayHint.problem("wss://nekko-agent-relay.fly.dev", debug = false))
        assertNull(RelayHint.problem("wss://gomi.tailfd6474.ts.net", debug = false))
        assertNull(RelayHint.problem("WSS://Relay.Example.com:8443/relay", debug = true))
    }

    @Test fun `ws to a tailscale magicdns name works, release and debug`() {
        assertNull(RelayHint.problem("ws://gomi.tailfd6474.ts.net:4400", debug = false))
        assertNull(RelayHint.problem("ws://GOMI.tailfd6474.TS.NET:4400/", debug = true))
    }

    @Test fun `a bare tailscale ip over ws is blocked, and says to use the name`() {
        assertEquals(Problem.TAILSCALE_IP, RelayHint.problem("ws://100.101.102.103:4400", debug = false))
        assertEquals(Problem.TAILSCALE_IP, RelayHint.problem("ws://100.64.0.1:4400", debug = true))
        assertTrue(RelayHint.isTailscaleIp("100.127.255.255"))
        assertFalse(RelayHint.isTailscaleIp("100.128.0.1"))
        assertFalse(RelayHint.isTailscaleIp("100.63.0.1"))
        assertFalse(RelayHint.isTailscaleIp("192.168.1.10"))
    }

    @Test fun `loopback is the phone itself on a release build`() {
        assertEquals(Problem.LOOPBACK, RelayHint.problem("ws://127.0.0.1:4400", debug = false))
        assertEquals(Problem.LOOPBACK, RelayHint.problem("ws://localhost:4400", debug = false))
        assertEquals(Problem.LOOPBACK, RelayHint.problem("wss://localhost", debug = false))
    }

    @Test fun `loopback works on a debug build through adb reverse`() {
        assertNull(RelayHint.problem("ws://127.0.0.1:4400", debug = true))
        assertNull(RelayHint.problem("ws://localhost:4400", debug = true))
        assertNull(RelayHint.problem("ws://10.0.2.2:4400", debug = true))
        assertEquals(Problem.CLEARTEXT, RelayHint.problem("ws://10.0.2.2:4400", debug = false))
    }

    @Test fun `any other plain ws host is blocked`() {
        assertEquals(Problem.CLEARTEXT, RelayHint.problem("ws://192.168.1.20:4400", debug = true))
        assertEquals(Problem.CLEARTEXT, RelayHint.problem("ws://mac.local:4400", debug = false))
        // ts.net must be the real suffix, not a lookalike.
        assertEquals(Problem.CLEARTEXT, RelayHint.problem("ws://evil-ts.net.example.com:4400", debug = false))
    }

    @Test fun `messages name the computer`() {
        assertTrue(RelayHint.message(Problem.LOOPBACK, "Mac").contains("On Mac"))
        assertTrue(RelayHint.message(Problem.TAILSCALE_IP, "Mac").contains(".ts.net"))
    }
}

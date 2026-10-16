package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TailnetTest {
    @Test fun aTailnetAddressMeansConnected() {
        assertTrue(Tailnet.isConnected(listOf("192.168.1.20", "100.101.102.103")))
        assertTrue(Tailnet.isConnected(listOf("fd7a:115c:a1e0:ab12::1")))
        assertTrue(Tailnet.isConnected(listOf("FD7A:115C:A1E0::5%tun0")))
    }

    @Test fun otherAddressesDoNot() {
        assertFalse(Tailnet.isConnected(listOf("192.168.1.20", "10.0.0.4", "fe80::1%wlan0", "127.0.0.1")))
        assertFalse(Tailnet.isConnected(listOf("100.63.255.255", "100.128.0.1"))) // just outside 100.64/10
        assertFalse(Tailnet.isConnected(emptyList()))
    }

    @Test fun tailnetRelays() {
        assertTrue(Tailnet.isTailnetRelay("ws://studio.tail1234.ts.net:4400"))
        assertTrue(Tailnet.isTailnetRelay("ws://100.100.1.2:4400"))
        assertTrue(Tailnet.isTailnetRelay("ws://[fd7a:115c:a1e0::9]:4400"))
        assertFalse(Tailnet.isTailnetRelay("wss://relay.nekkoagent.com"))
        assertFalse(Tailnet.isTailnetRelay("ws://192.168.1.5:4400"))
    }

    @Test fun theHintOnlyWhenATailnetRelayMeetsTailscaleOff() {
        assertEquals(
            "Tailscale is off on this phone. Open the Tailscale app and connect to your tailnet to reach Studio.",
            Tailnet.hint("ws://studio.tail1234.ts.net:4400", phoneOnTailnet = false, computer = "Studio"),
        )
        assertNull(Tailnet.hint("ws://studio.tail1234.ts.net:4400", phoneOnTailnet = true, computer = "Studio"))
        assertNull(Tailnet.hint("wss://relay.nekkoagent.com", phoneOnTailnet = false, computer = "Studio"))
    }
}

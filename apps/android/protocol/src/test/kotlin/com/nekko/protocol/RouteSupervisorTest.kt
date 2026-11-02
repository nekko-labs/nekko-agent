package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** AN-28: which address of a computer's relay to dial. Ported from the iPhone's RouteSupervisorTests. */
class RouteSupervisorTest {
    private val lan = "ws://192.168.1.20:4400"
    private val tailnet = "ws://studio.tail1234.ts.net:4400"
    private val hosted = "wss://relay.example.com"
    private val t0 = 1_000_000_000L
    private val rules = RouteRules(successesToReturn = 3, failureCooldownMs = 60_000, minDwellMs = 30_000)

    private fun s(vararg routes: String, rules: RouteRules = this.rules, path: NetworkPath = NetworkPath.UNKNOWN) =
        RouteSupervisor(routes.toList(), rules, path, t0)

    @Test fun `every route kind matches the shared golden`() {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-remote/tests/golden/relay-route.json")
        val cases = Json.parseToJsonElement(f.readText()).jsonArray
        assertTrue(cases.size > 10)
        for (c in cases) {
            val url = c.jsonObject["url"]!!.jsonPrimitive.content
            assertEquals(url, c.jsonObject["route"]!!.jsonPrimitive.content, RelayRoute.of(url).name.lowercase())
        }
    }

    @Test fun `orders the LAN first, then the tailnet, then the internet`() {
        assertEquals(listOf(lan, tailnet, hosted), RouteSupervisor.order(listOf(hosted, tailnet, lan, tailnet)))
        assertEquals(listOf(tailnet, "ws://100.101.102.103:4400"), RouteSupervisor.order(listOf(tailnet, "ws://100.101.102.103:4400")))
        assertEquals(lan, s(tailnet, lan).url)
    }

    @Test fun `one route never moves or cools`() {
        val s = s(tailnet)
        assertFalse(s.hasAlternatives)
        assertFalse(s.fallbackExists)
        assertFalse(s.failed(t0).changed)
        assertEquals(tailnet, s.routeToDial(t0))
        assertTrue(s.onBest)
    }

    @Test fun `a failure moves down at once and cools the route down`() {
        val s = s(tailnet, lan)
        assertTrue("the LAN dial gets the short open timeout", s.fallbackExists)
        assertEquals(RouteSupervisor.Failover(changed = true, ready = true), s.failed(t0))
        assertEquals(tailnet, s.url)
        assertFalse("the last resort keeps the transport's own timeout", s.fallbackExists)
        // The LAN is cooling: nothing to probe yet.
        assertNull(s.probeTarget(t0 + 59_000))
        assertEquals(0, s.probeTarget(t0 + 61_000))
        // The tailnet failing too goes back to the LAN, but it is still cooling: not at once.
        assertEquals(RouteSupervisor.Failover(changed = true, ready = false), s.failed(t0 + 1_000))
        assertEquals(lan, s.url)
    }

    @Test fun `moves back only after enough probes and the dwell`() {
        val s = s(tailnet, lan)
        s.failed(t0)
        val t = t0 + 61_000
        s.probed(0, true, t)
        s.probed(0, true, t)
        assertFalse("two successes are not enough", s.shouldMoveBack(t))
        s.probed(0, true, t)
        assertTrue(s.shouldMoveBack(t))
        // The dwell: just after a move, stay put however good the probes.
        val short = s(tailnet, lan, rules = rules.copy(failureCooldownMs = 1_000))
        short.failed(t0)
        val soon = t0 + 5_000
        repeat(5) { short.probed(0, true, soon) }
        assertFalse("30 s dwell", short.shouldMoveBack(soon))
        assertTrue(short.shouldMoveBack(t0 + 31_000))
        assertEquals(lan, short.moveBack(t0 + 31_000))
        assertTrue(short.onBest)
        val fresh = s(tailnet, lan)
        fresh.failed(t0)
        assertNull(fresh.probeTarget(t0))
    }

    @Test fun `a failed probe starts the count again and cools the route`() {
        val s = s(tailnet, lan, rules = rules.copy(minDwellMs = 0))
        s.failed(t0)
        val t = t0 + 61_000
        s.probed(0, true, t)
        s.probed(0, true, t)
        s.probed(0, false, t)
        assertNull("cooling again", s.probeTarget(t))
        val later = t + 61_000
        s.probed(0, true, later)
        s.probed(0, true, later)
        assertFalse(s.shouldMoveBack(later))
        s.probed(0, true, later)
        assertTrue(s.shouldMoveBack(later))
        // A probe of anything else is ignored.
        s.probed(1, false, later)
        assertTrue(s.shouldMoveBack(later))
    }

    @Test fun `cellular skips the LAN and a network change starts afresh`() {
        val s = s(tailnet, lan, path = NetworkPath.CELLULAR)
        assertEquals(tailnet, s.url)
        assertTrue(s.onBest)
        assertFalse("the LAN is no fallback on cellular", s.failed(t0).changed)
        // Back on Wi-Fi: the LAN first again.
        assertTrue(s.pathChanged(NetworkPath.LOCAL, t0))
        assertEquals(lan, s.url)
        // A failure on this Wi-Fi cools the LAN; joining another clears it.
        s.failed(t0)
        assertEquals(tailnet, s.url)
        assertTrue(s.pathChanged(NetworkPath.LOCAL, t0 + 1_000))
        assertEquals(lan, s.url)
        // Leaving Wi-Fi while on the LAN: the next dial takes the tailnet.
        s.pathChanged(NetworkPath.CELLULAR, t0 + 2_000)
        assertEquals(tailnet, s.routeToDial(t0 + 2_000))
    }

    @Test fun `a route the phone may not dial is kept but never chosen`() {
        val s = RouteSupervisor(listOf(tailnet, lan, hosted), rules, NetworkPath.LOCAL, t0, allowed = { !it.startsWith("ws://192.168.") })
        assertEquals(listOf(lan, tailnet, hosted), s.routes)
        assertEquals(tailnet, s.url)
        assertTrue("nothing better this phone may dial", s.onBest)
        assertNull(s.probeTarget(t0 + 120_000))
        assertTrue(s.hasAlternatives)
        assertEquals(RouteSupervisor.Failover(changed = true, ready = true), s.failed(t0))
        assertEquals(hosted, s.url)
        // The tailnet cools off first: back to it, never to the LAN.
        s.failed(t0 + 1_000)
        assertEquals(tailnet, s.url)
        assertTrue(s.pathChanged(NetworkPath.CELLULAR, t0 + 2_000).not())
        assertEquals(tailnet, s.routeToDial(t0 + 2_000))
    }

    @Test fun `the health check sits at the same address`() {
        assertEquals("http://studio.tail1234.ts.net:4400/healthz", HealthProber.healthUrl("ws://studio.tail1234.ts.net:4400/"))
        assertEquals("https://relay.example.com/healthz", HealthProber.healthUrl(" WSS://relay.example.com"))
        assertNull(HealthProber.healthUrl("http://relay.example.com"))
        assertEquals("http://192.168.1.20:4400/healthz", HealthProber.healthUrl("ws://192.168.1.20:4400"))
    }

    @Test fun `no plain http health check goes to the open internet`() {
        assertNull(HealthProber.healthUrl("ws://relay.example.com:4400"))
        assertNull(HealthProber.healthUrl("WS://8.8.8.8:4400"))
    }
}

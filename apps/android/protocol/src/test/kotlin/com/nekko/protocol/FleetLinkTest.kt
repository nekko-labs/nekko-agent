package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FleetLinkTest {
    private val acct = "a1111111-2b3d-4e5f-8a6b-9c0d1e2f3a4b"
    private val org = "0b7c2d4e-6f1a-4c3b-9d8e-5a4f3e2d1c0b"
    private val dev = "7e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b"
    private val other = "8e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b"
    private val ring = AccountKeyring(ByteArray(64) { it.toByte() })
    private val salt = ByteArray(32) { (255 - it).toByte() }

    // The same bytes crates/nekko-sync's `matches_the_vectors_the_phones_check` asserts, made by an independent Node implementation.
    private val connectVector = "Af_-_fz7-vn49_b19PPy8fDv7u3s6-rp6Ofm5eTj4uHgEQi7QXKQ1mE_WqWTbDmKTSL088myJiCOC9GdT_48iwYlsZwvrE0JHmhXPjm1s5YoaPbVg8lUFTep_Nn23n7Zk9ZOavmjJae9_9n43-TQgSzkkt5sfX71i2kp1ZHhEuY7HSscUosbPTFBLkW1ENmOeLUW5CbPRxXaxvJUWgjHajok5oiMWDqzlZMUWROzWD0PxczVIq3I35jWFPc-QW8UMh7dFzfvhwHm2p3m92SQA1XZC8hZD99CcDloPoiVJufH_sqqj8AJIFZxq0XMr0fiZRKmPoaKFCuQ6AY4KFiNInHRuPQYHM4PBetgNDnZoPYe7MEgTLiBW-8C4JGlYNw-4qkHiTZuGTlxmoRACp28QZg"
    private val helloVector = "Af_-_fz7-vn49_b19PPy8fDv7u3s6-rp6Ofm5eTj4uHgEQi7QXCNzHo8WqWTbDmKTSL088myJiCOC9GdT_48iwYlsZwvrE0JHmhXPjm1s5YoaPbVg8lUFTep_Nn23n7Zk9ZOavmjJae9_9n43-TQgSzkkt5sfX71i2kp1ZHhEuY7HSscUosbPTFBLkW1ENmOeLUW5CbPRxXaxvJUWgjHajok5oiMWDqzlZMUWROzWD0PxczVIq3I35jWFPc-QW8UMh7dFzfvhwHm2p3m92SQA1XZC8hZD99CcDloPoiVJufH_sqqj8AJIFZxq0XMr0fiZRKmPoaKFCuQ6AY4KFiNInHRuPQYHM4PBetgNDnZoPYe7MEgTLiBW-8C4JGlYNw-4khm8NKkH7zTvzv1uQekTHQ"

    private fun refused(block: () -> Unit) = try { block(); fail("should refuse") } catch (_: FleetLink.Failure) {}

    @Test fun `seals byte for byte as nekko-sync does`() {
        assertEquals(connectVector, FleetLink.sealConnect(ring, acct, 2, org, dev, 5, "route".toByteArray(), salt))
        assertEquals(helloVector, FleetLink.seal(ring, FleetLink.helloAad(acct, 4, dev), "proof".toByteArray(), salt))
        assertEquals("route", String(FleetLink.openConnect(ring, acct, 2, org, dev, 5, connectVector)))
        assertEquals("proof", String(FleetLink.openHelloProof(ring, acct, 4, dev, helloVector)))
    }

    @Test fun `a connect block opens only for its account, epoch, org, device, revision and key`() {
        refused { FleetLink.openConnect(ring, other, 2, org, dev, 5, connectVector) }
        refused { FleetLink.openConnect(ring, acct, 3, org, dev, 5, connectVector) }
        refused { FleetLink.openConnect(ring, acct, 2, other, dev, 5, connectVector) }
        refused { FleetLink.openConnect(ring, acct, 2, org, other, 5, connectVector) }
        refused { FleetLink.openConnect(ring, acct, 2, org, dev, 4, connectVector) }
        refused { FleetLink.openConnect(AccountKeyring(ByteArray(64) { 9 }), acct, 2, org, dev, 5, connectVector) }
    }

    @Test fun `a hello proof opens only for its account, epoch, device and key, and not as a connect block`() {
        refused { FleetLink.openHelloProof(ring, other, 4, dev, helloVector) }
        refused { FleetLink.openHelloProof(ring, acct, 5, dev, helloVector) }
        refused { FleetLink.openHelloProof(ring, acct, 4, other, helloVector) }
        refused { FleetLink.openHelloProof(AccountKeyring(ByteArray(64) { 9 }), acct, 4, dev, helloVector) }
        refused { FleetLink.openHelloProof(ring, acct, 2, dev, connectVector) }
        refused { FleetLink.openConnect(ring, acct, 4, org, dev, 5, helloVector) }
        refused { FleetLink.openHelloProof(ring, acct, 4, dev, "not a blob") }
        refused { FleetLink.openHelloProof(ring, acct, 4, dev, helloVector.dropLast(4)) }
    }

    @Test fun `ids cannot smuggle associated-data separators`() {
        refused { FleetLink.helloAad("a\nb", 1, dev) }
        refused { FleetLink.helloAad(acct, 1, "x\n1") }
        refused { FleetLink.helloAad("", 1, dev) }
        refused { FleetLink.helloAad(acct, 0, dev) }
        refused { FleetLink.connectAad(acct, 1, org, dev, 0) }
        assertEquals("nekko-sync/v1 fleet-hello\n$acct\n2\n$dev", FleetLink.helloAad(acct, 2, dev))
        assertEquals("nekko-sync/v1 fleet-connect\n$acct\n2\n$org\n$dev\n3", FleetLink.connectAad(acct, 2, org, dev, 3))
    }

    @Test fun `long plaintexts round trip through the padding`() {
        val big = ByteArray(5000) { 7 }
        assertTrue(FleetLink.open(ring, "x", FleetLink.seal(ring, "x", big, salt)).contentEquals(big))
        assertEquals(272, FleetLink.padme(257)); assertEquals(1024, FleetLink.padme(1000)); assertEquals(1088, FleetLink.padme(1025))
    }

    @Test fun `the connect block is read only for its org and in shape`() {
        fun plain(orgId: String = org, routes: String = "\"wss://r.example/relay\",\"ftp://x\"") =
            """{"v":1,"orgId":"$orgId","routes":[$routes],"room":"rm","secret":"sec","hostKey":"hk"}""".toByteArray()
        val info = FleetLink.parseConnect(plain(), org)!!
        assertEquals(listOf("wss://r.example/relay"), info.routes)
        assertEquals("rm", info.room)
        assertEquals("ConnectInfo([wss://r.example/relay], ..)", info.toString())
        assertNull(FleetLink.parseConnect(plain(), other))
        assertNull(FleetLink.parseConnect(plain(routes = "\"ftp://x\""), org))
        assertNull(FleetLink.parseConnect("""{"v":2}""".toByteArray(), org))
        assertNull(FleetLink.parseConnect("nope".toByteArray(), org))
        assertEquals(4, FleetLink.parseConnect(plain(routes = (1..9).joinToString(",") { "\"ws://h$it\"" }), org)!!.routes.size)
    }

    @Test fun `the link is named apart from every pairing and refusals read the same, retrying only after a stale answer`() {
        assertEquals("fleet:$dev", FleetLink.linkDeviceId(dev))
        for (c in listOf("fleet-off", "fleet-locked", "fleet-epoch", "fleet-device", "fleet-account")) assertNotNull(FleetLink.refusalText(c))
        assertNull(FleetLink.refusalText("other"))
        assertTrue(FleetLink.retryable("fleet-device") && FleetLink.retryable("fleet-epoch"))
        assertTrue(!FleetLink.retryable("fleet-off") && !FleetLink.retryable("fleet-locked") && !FleetLink.retryable("fleet-account"))
    }
}

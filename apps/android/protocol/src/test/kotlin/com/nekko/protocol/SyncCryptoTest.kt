package com.nekko.protocol

import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The phone's sync crypto (#2835) against the vectors `crates/nekko-sync` and the iPhone are tested with
 * (`crates/nekko-sync/tests/golden/sync-crypto.json`): the iPhone's SyncCryptoTests, case for case.
 */
class SyncCryptoTest {
    private val v: JsonObject by lazy {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-sync/tests/golden/sync-crypto.json")
        assumeTrue("running outside the monorepo", f.exists())
        Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun s(o: JsonObject, k: String) = o[k]!!.jsonPrimitive.content
    private fun b(o: JsonObject, k: String) = SyncCrypto.fromBase64url(s(o, k))
    private fun o(k: String) = v[k]!!.jsonObject
    private val account get() = s(v, "account")
    private val keyring get() = SyncCrypto.Keyring(b(v, "keyring"))

    /** The vectors' fixed inputs: the SHA-256 of a seed name (as in the Rust test). */
    private fun seed(name: String) = MessageDigest.getInstance("SHA-256").digest(name.toByteArray())

    private fun failsWith(reason: SyncCrypto.Failure.Reason?, block: () -> Unit) {
        val e = assertThrows(SyncCrypto.Failure::class.java) { block() }
        if (reason != null) assertEquals(reason, e.reason)
    }

    @Test fun `object ids and records are byte identical`() {
        for (e in v["objectIds"]!!.jsonArray) {
            val x = e.jsonObject
            assertEquals(s(x, "objectId"), SyncCrypto.objectId(keyring, s(x, "collection"), s(x, "localId")))
        }
        for (e in v["records"]!!.jsonArray + v["longRecord"]!!) {
            val r = e.jsonObject
            val (c, oid) = s(r, "collection") to s(r, "objectId")
            val rev = r["revision"]!!.jsonPrimitive.long
            val kid = r["keyId"]!!.jsonPrimitive.long
            val text = s(r, "plaintext")
            val sealed = SyncCrypto.sealRecord(keyring, account, kid, c, oid, rev, text.toByteArray(), salt = b(r, "salt"))
            assertEquals(s(r, "blob"), sealed)
            assertEquals(text, String(SyncCrypto.openRecord(keyring, account, kid, c, oid, rev, s(r, "blob"))))
            // Relabelled by the server: another revision or account.
            failsWith(SyncCrypto.Failure.Reason.UNAUTHENTIC) { SyncCrypto.openRecord(keyring, account, kid, c, oid, rev + 1, sealed) }
            failsWith(SyncCrypto.Failure.Reason.UNAUTHENTIC) { SyncCrypto.openRecord(keyring, "someone-else", kid, c, oid, rev, sealed) }
        }
    }

    @Test fun `epoch proofs match`() {
        val proofs = v["epochProofs"]!!.jsonArray
        assertFalse(proofs.isEmpty())
        for (e in proofs) {
            val p = e.jsonObject
            assertArrayEquals(b(p, "proof"), SyncCrypto.epochProof(keyring, p["keyId"]!!.jsonPrimitive.long))
        }
        assertFalse(SyncCrypto.epochProof(keyring, 1).contentEquals(SyncCrypto.epochProof(keyring.rotated(), 1)))
    }

    @Test fun `padme matches`() {
        for (e in v["padme"]!!.jsonArray) {
            val pair = e.jsonArray
            assertEquals(pair[1].jsonPrimitive.int, SyncCrypto.padme(pair[0].jsonPrimitive.int))
        }
        assertEquals(256, SyncCrypto.frame(ByteArray(0)).size)
        assertArrayEquals("hi".toByteArray(), SyncCrypto.unframe(SyncCrypto.frame("hi".toByteArray())))
    }

    @Test fun `wrap, join, recovery and donation match`() {
        val device = SyncCrypto.SoftwareKey.fromRaw(b(o("device"), "private"))
        val eph = SyncCrypto.SoftwareKey.fromRaw(b(o("ephemeral"), "private"))
        val deviceId = s(o("device"), "id")
        assertEquals(s(o("device"), "public"), SyncCrypto.base64url(device.publicKeyX963))
        assertEquals(s(o("device"), "fingerprint"), SyncCrypto.fingerprint(device.publicKeyX963))

        val sender = SyncCrypto.SoftwareKey.fromRaw(b(o("sender"), "private"))
        val senderId = s(o("sender"), "id")
        assertEquals(s(o("sender"), "public"), SyncCrypto.base64url(sender.publicKeyX963))
        val wrap = SyncCrypto.wrapKeyring(keyring, account, 1, deviceId, device.publicKeyX963, senderId, sender, eph)
        assertEquals(s(o("wrap"), "blob"), wrap)
        fun open(key: SyncAgreementKey, dev: String, from: String, fromKey: ByteArray) =
            SyncCrypto.unwrapKeyring(key, account, 1, dev, from, fromKey, wrap)
        assertEquals(keyring, open(device, deviceId, senderId, sender.publicKeyX963))
        failsWith(null) { open(device, "another", senderId, sender.publicKeyX963) }
        failsWith(null) { open(SyncCrypto.SoftwareKey.generate(), deviceId, senderId, sender.publicKeyX963) }
        // Only as coming from the device that made it: anyone else's key, or another sender id, fails.
        failsWith(null) { open(device, deviceId, senderId, SyncCrypto.SoftwareKey.generate().publicKeyX963) }
        failsWith(null) { open(device, deviceId, "dev_other", sender.publicKeyX963) }

        // Join codes: the same tag and wrap as the computer makes.
        val join = o("join")
        val code = SyncCrypto.JoinCode.parse(s(join, "code").lowercase())
        assertEquals(SyncCrypto.JoinCode(seed("join-code").copyOfRange(0, 10)), code)
        assertEquals(s(join, "code"), code.text)
        val tag = b(join, "tag")
        assertArrayEquals(tag, code.tag(account, device.publicKeyX963))
        assertTrue(code.verifies(account, device.publicKeyX963, tag))
        assertFalse("a swapped key fails", code.verifies(account, sender.publicKeyX963, tag))
        val joinWrap = SyncCrypto.wrapForJoin(keyring, account, 3, deviceId, device.publicKeyX963, code, eph)
        assertEquals(s(join, "blob"), joinWrap)
        assertEquals(keyring, SyncCrypto.unwrapJoin(device, account, 3, deviceId, code, joinWrap))
        failsWith(null) { SyncCrypto.unwrapJoin(device, account, 3, deviceId, SyncCrypto.JoinCode.generate(), joinWrap) }

        val rv = o("recovery")
        val recovery = SyncCrypto.RecoveryKey(b(rv, "key"))
        assertEquals(s(rv, "text"), recovery.text)
        assertEquals(recovery, SyncCrypto.RecoveryKey.parse(s(rv, "text").lowercase().replace("-", " ")))
        val recoveryPublic = SyncCrypto.recoveryAgreementKey(recovery).publicKeyX963
        assertEquals(s(rv, "public"), SyncCrypto.base64url(recoveryPublic))
        val rblob = SyncCrypto.sealRecovery(recoveryPublic, keyring, account, 1, eph)
        assertEquals(s(rv, "blob"), rblob)
        assertEquals(keyring, SyncCrypto.openRecovery(recovery, account, 1, rblob))
        failsWith(null) { SyncCrypto.openRecovery(recovery, account, 2, rblob) }

        val dv = o("donation")
        val research = SyncCrypto.SoftwareKey.fromRaw(b(dv, "researchPrivate"))
        assertEquals(s(dv, "researchPublic"), SyncCrypto.base64url(research.publicKeyX963))
        val donation = SyncCrypto.sealDonation(
            research.publicKeyX963, s(dv, "payload").toByteArray(),
            id = seed("donation-id").copyOfRange(0, 16), deleteToken = seed("delete-token"), ephemeral = eph,
        )
        assertEquals(SyncCrypto.Donation(s(dv, "id"), s(dv, "blob"), s(dv, "deleteToken"), s(dv, "deleteHash")), donation)
        val framed = SyncCrypto.openSealed(research, "nekko-donation/v1\n${donation.id}", donation.blob)
        assertEquals(s(dv, "payload"), String(SyncCrypto.unframe(framed)))
    }

    @Test fun `recovery keys catch typos and round trip`() {
        val key = SyncCrypto.RecoveryKey.generate()
        assertEquals(65, key.text.length)
        assertEquals(key, SyncCrypto.RecoveryKey.parse(key.text))
        val chars = key.text.toCharArray()
        chars[3] = if (chars[3] == 'A') 'B' else 'A'
        failsWith(null) { SyncCrypto.RecoveryKey.parse(String(chars)) }
        failsWith(null) { SyncCrypto.RecoveryKey.parse(key.text.dropLast(1)) }
        failsWith(null) { SyncCrypto.RecoveryKey.parse(key.text + "0") }
        // ASCII only, as on the computer: no Unicode case mapping ("ß" would become "SS").
        failsWith(SyncCrypto.Failure.Reason.MALFORMED) { SyncCrypto.RecoveryKey.parse(key.text.replace("-", "ß")) }
        val code = SyncCrypto.JoinCode.generate()
        assertEquals(19, code.text.length)
        assertEquals(code, SyncCrypto.JoinCode.parse(code.text.lowercase().replace("-", " ")))
        failsWith(null) { SyncCrypto.JoinCode.parse(code.text.dropLast(1)) }
    }

    @Test fun `every flipped bit is caught and seals never repeat`() {
        val ring = SyncCrypto.Keyring.generate()
        val oid = SyncCrypto.objectId(ring, "chat", "s_1")
        assertEquals("the id key survives a rotation", oid, SyncCrypto.objectId(ring.rotated(), "chat", "s_1"))
        val blob = SyncCrypto.sealRecord(ring, "a", 1, "chat", oid, 1, "x".toByteArray())
        assertNotEquals(blob, SyncCrypto.sealRecord(ring, "a", 1, "chat", oid, 1, "x".toByteArray()))
        val raw = SyncCrypto.fromBase64url(blob)
        for (i in raw.indices step 7) {
            val bad = raw.copyOf().also { it[i] = (it[i].toInt() xor 1).toByte() }
            failsWith(null) { SyncCrypto.openRecord(ring, "a", 1, "chat", oid, 1, SyncCrypto.base64url(bad)) }
        }
        failsWith(SyncCrypto.Failure.Reason.UNAUTHENTIC) { SyncCrypto.openRecord(ring.rotated(), "a", 1, "chat", oid, 1, blob) }
    }

    @Test fun `bad inputs are refused before any crypto`() {
        failsWith(SyncCrypto.Failure.Reason.MALFORMED) { SyncCrypto.Keyring(ByteArray(63)) }
        failsWith(SyncCrypto.Failure.Reason.INVALID) { SyncCrypto.objectId(keyring, "Chat", "x") }
        failsWith(SyncCrypto.Failure.Reason.INVALID) { SyncCrypto.objectId(keyring, "chat", "") }
        failsWith(SyncCrypto.Failure.Reason.INVALID) { SyncCrypto.sealRecord(keyring, "a", 1, "chat", "short", 1, ByteArray(0)) }
        failsWith(SyncCrypto.Failure.Reason.MALFORMED) { SyncCrypto.fromBase64url("not base64!") }
        failsWith(SyncCrypto.Failure.Reason.MALFORMED) { SyncCrypto.fromBase64url("AAAA==") }
        failsWith(SyncCrypto.Failure.Reason.INVALID) { SyncCrypto.SoftwareKey.fromRaw(ByteArray(32)) }
        failsWith(SyncCrypto.Failure.Reason.INVALID) { SyncCrypto.seal(ByteArray(65), "ctx", ByteArray(1)) }
        // A software key survives being stored as its scalar.
        val key = SyncCrypto.SoftwareKey.generate()
        assertArrayEquals(key.publicKeyX963, SyncCrypto.SoftwareKey.fromRaw(key.rawRepresentation).publicKeyX963)
        // Secrets never reach a log line.
        assertEquals("Keyring(..)", keyring.toString())
        assertEquals("RecoveryKey(..)", SyncCrypto.RecoveryKey.generate().toString())
    }

    @Test fun `pkce challenge is RFC 7636's example`() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", SyncCrypto.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }
}

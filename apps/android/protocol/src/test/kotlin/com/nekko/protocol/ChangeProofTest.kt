package com.nekko.protocol

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.Base64

/**
 * The Change proof against the computer's own test vector
 * (`crates/nekko-remote/tests/golden/change-proof.json`), which `proof.rs`
 * and the iPhone's `ChangeProofTests` read too: the same canonical JSON, the
 * same signed text, and signatures each side accepts.
 */
class ChangeProofTest {
    private val golden: JsonObject by lazy {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-remote/tests/golden/change-proof.json")
        assumeTrue("running outside the monorepo", f.exists())
        Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun str(k: String) = golden[k]!!.jsonPrimitive.content
    private fun b64(k: String) = Base64.getDecoder().decode(str(k))
    private val args get() = golden["args"]!!.jsonArray

    @Test fun `canonical JSON, its hash and the signed text match the computer's`() {
        assertEquals(ChangeProof.VERSION, str("version"))
        assertEquals(str("canonical"), ChangeProof.canonicalJson(args))
        assertEquals(str("argsSha256"), ChangeProof.sha256Hex(ChangeProof.canonicalJson(args)))
        val text = ChangeProof.payload(str("deviceId"), str("channel"), args, golden["ts"]!!.jsonPrimitive.long)
        assertEquals(str("payload"), text)
    }

    @Test fun `every canonical case`() {
        for (case in golden["canonicalCases"]!!.jsonArray) {
            val o = case.jsonObject
            assertEquals(o["canonical"]!!.jsonPrimitive.content, ChangeProof.canonicalJson(o["value"]!!))
        }
    }

    @Test fun `fractions and integers past 2^53 can't be signed`() {
        for (case in golden["unsignable"]!!.jsonArray) {
            assertTrue(runCatching { ChangeProof.canonicalJson(case) }.exceptionOrNull() is ChangeProof.Unsignable)
        }
        // A whole number written with a fraction part is still that integer, as on the computer.
        assertEquals("[1]", ChangeProof.canonicalJson(JsonArray(listOf(JsonPrimitive(1.0)))))
    }

    @Test fun `the vector's signature verifies, and a changed text does not`() {
        val key = b64("publicKey")
        assertTrue(ChangeProof.verify(key, str("payload"), b64("sig")))
        assertFalse(ChangeProof.verify(key, str("payload") + "1", b64("sig")))
        assertFalse(ChangeProof.verify(key, str("payload"), ByteArray(64)))
    }

    @Test fun `a proof this phone signs is one the computer's key check accepts`() = runBlocking {
        val signer = SoftwareChangeSigner.of(b64("privateKey"), b64("publicKey"))
        assertArrayEquals(b64("publicKey"), signer.publicKey())
        val ts = golden["ts"]!!.jsonPrimitive.long
        val proof = ChangeProof.proof(signer, str("deviceId"), str("channel"), args, ts)
        assertEquals(ts, proof["ts"]!!.jsonPrimitive.long)
        val sig = Base64.getDecoder().decode(proof["sig"]!!.jsonPrimitive.content)
        assertEquals("raw r||s", 64, sig.size)
        assertTrue(ChangeProof.verify(b64("publicKey"), str("payload"), sig))
    }

    @Test fun `DER and raw signatures convert both ways, short integers included`() = runBlocking {
        val signer = SoftwareChangeSigner.generate()
        val key = signer.publicKey()
        assertEquals(65, key.size)
        assertEquals(4.toByte(), key[0])
        // Enough signatures that some r or s has a leading zero byte or its top bit set.
        repeat(200) { i ->
            val text = "message $i"
            val raw = signer.sign(text.toByteArray())
            assertEquals(64, raw.size)
            assertArrayEquals(raw, P256.derToRaw(P256.rawToDer(raw)))
            assertTrue(ChangeProof.verify(key, text, raw))
        }
    }
}

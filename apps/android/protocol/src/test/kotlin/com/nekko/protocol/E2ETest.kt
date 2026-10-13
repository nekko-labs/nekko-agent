package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.util.Base64

class E2ETest {
    private val vector: JsonObject =
        Json.parseToJsonElement(javaClass.getResource("/e2e-vector.json")!!.readText()).jsonObject
    private fun v(k: String) = vector[k]!!.jsonPrimitive.content

    @Test fun `derives the same key as WebCrypto PBKDF2`() {
        assertEquals(v("keyHex"), E2E.toHex(E2E.deriveKey(v("secret"), v("room"))))
    }

    @Test fun `seals byte-identical to WebCrypto AES-GCM for the same iv`() {
        val key = E2E.fromHex(v("keyHex"))
        assertEquals(v("sealed"), E2E.sealText(key, v("plaintext"), E2E.fromHex(v("ivHex"))))
    }

    @Test fun `opens a frame WebCrypto sealed`() {
        val key = E2E.fromHex(v("keyHex"))
        assertEquals(v("plaintext"), E2E.openText(key, v("sealed")))
        val frame = E2E.open(key, v("sealed")).jsonObject
        assertEquals("héllo ✓ 🐱", (frame["args"] as kotlinx.serialization.json.JsonArray)[0].jsonPrimitive.content)
    }

    @Test fun `round trips with random ivs that never repeat`() {
        val key = E2E.randomBytes(32)
        val value = buildJsonObject { put("type", "event"); put("payload", "x".repeat(70_000)) }
        val a = E2E.seal(key, value)
        val b = E2E.seal(key, value)
        assertNotEquals(a, b)
        assertEquals(value, E2E.open(key, a))
        assertEquals(value, E2E.open(key, b))
    }

    @Test fun `rejects a wrong key and a tampered frame`() {
        val key = E2E.fromHex(v("keyHex"))
        assertThrows(Exception::class.java) { E2E.openText(E2E.randomBytes(32), v("sealed")) }
        val bytes = Base64.getDecoder().decode(v("sealed"))
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        assertThrows(Exception::class.java) { E2E.openText(key, Base64.getEncoder().encodeToString(bytes)) }
        assertThrows(IllegalArgumentException::class.java) { E2E.openText(key, "AAAA") }
    }

    @Test fun `hex helpers round trip and refuse garbage`() {
        val b = byteArrayOf(0, 1, 127, -128, -1)
        assertArrayEquals(b, E2E.fromHex(E2E.toHex(b)))
        assertThrows(IllegalArgumentException::class.java) { E2E.fromHex("zz") }
    }

    /**
     * Writes Kotlin-sealed frames for `scripts/e2e-vector.mjs open`, which opens
     * them with the agent's implementation. Opt-in: set NEKKO_E2E_OUT.
     */
    @Test fun `exports kotlin-sealed frames for the node check`() {
        val out = System.getenv("NEKKO_E2E_OUT") ?: return
        val key = E2E.deriveKey(v("secret"), v("room"))
        val plaintexts = listOf(
            v("plaintext"),
            buildJsonObject { put("type", "hello"); put("deviceId", "d-1"); put("platform", "android"); put("pair", "ABCD2345") }.toString(),
            buildJsonObject { put("type", "req"); put("id", 1); put("channel", "chat:send"); put("text", "ñ".repeat(5000)) }.toString(),
        )
        val frames = plaintexts.joinToString(",") { pt ->
            buildJsonObject { put("sealed", E2E.sealText(key, pt)); put("plaintext", pt) }.toString()
        }
        File(out).writeText("""{"secret":${JsonPrimitive(v("secret"))},"room":${JsonPrimitive(v("room"))},"frames":[$frames]}""")
    }
}

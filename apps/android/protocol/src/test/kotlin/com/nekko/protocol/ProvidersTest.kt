package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.security.KeyPair
import java.security.interfaces.ECPublicKey

/** AN-36: the sealed box byte for byte as `nekko-sync` makes it, and provider setup with the iPhone's ProviderSetupTests cases. */
class ProvidersTest {
    private val vectors: JsonObject by lazy {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-sync/tests/golden/sync-crypto.json")
        assumeTrue("running outside the monorepo", f.exists())
        Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun b(o: JsonObject, k: String) = SealedBox.fromBase64url(o[k]!!.jsonPrimitive.content)

    /** A software key pair standing in for the computer's sealing key. */
    private fun computer(): KeyPair = SealedBox.newKeyPair()
    private fun pub(k: KeyPair) = P256.x963(k.public as ECPublicKey)

    @Test fun `seals byte for byte as nekko-sync does`() {
        val dv = vectors["donation"]!!.jsonObject
        val ev = vectors["ephemeral"]!!.jsonObject
        val research = SealedBox.privateKey(b(dv, "researchPrivate"))
        val researchPublic = b(dv, "researchPublic")
        val context = "nekko-donation/v1\n" + dv["id"]!!.jsonPrimitive.content
        val blob = dv["blob"]!!.jsonPrimitive.content
        // Rust sealed it; this opens it.
        val framed = SealedBox.open(research, researchPublic, context, blob)
        val len = ((framed[0].toInt() and 0xff) shl 24) or ((framed[1].toInt() and 0xff) shl 16) or ((framed[2].toInt() and 0xff) shl 8) or (framed[3].toInt() and 0xff)
        assertEquals(dv["payload"]!!.jsonPrimitive.content, framed.copyOfRange(4, 4 + len).toString(Charsets.UTF_8))
        // And sealing the same bytes with the same one-time key gives the same blob.
        val eph = KeyPair(P256.publicKey(b(ev, "public")), SealedBox.privateKey(b(ev, "private")))
        assertEquals(blob, SealedBox.seal(researchPublic, context, framed, eph))
    }

    @Test fun `seals the key to the computer and opens there only`() {
        val computer = computer()
        val request = ProviderSetup.request("anthropic", "anthropic", " Anthropic ", null, " sk-ant-secret ", pub(computer))
        assertEquals("anthropic", request["id"]!!.jsonPrimitive.content)
        assertEquals("Anthropic", request["label"]!!.jsonPrimitive.content)
        assertNull("the kind's default address is the computer's to fill in", request["baseUrl"])
        assertNull(request["apiKey"])
        val blob = request["sealedKey"]!!.jsonPrimitive.content
        assertFalse(blob.contains("sk-ant"))
        assertFalse(request.toString().contains("sk-ant-secret"))
        assertEquals("sk-ant-secret", SealedBox.open(computer.private as java.security.interfaces.ECPrivateKey, pub(computer), ProviderSetup.CONTEXT, blob).toString(Charsets.UTF_8))
        val other = computer()
        assertTrue(runCatching { SealedBox.open(other.private as java.security.interfaces.ECPrivateKey, pub(other), ProviderSetup.CONTEXT, blob) }.isFailure)
        assertTrue(runCatching { SealedBox.open(computer.private as java.security.interfaces.ECPrivateKey, pub(computer), "other", blob) }.isFailure)
        // A one-time key each time: the same key never seals to the same blob.
        assertTrue(blob != ProviderSetup.request("anthropic", "anthropic", "A", null, "sk-ant-secret", pub(computer))["sealedKey"]!!.jsonPrimitive.content)
    }

    @Test fun `local kinds need no key and cloud kinds need https`() {
        val key = pub(computer())
        val ollama = ProviderSetup.request("ollama", "ollama", "Ollama", "http://localhost:11434", null, key)
        assertEquals("http://localhost:11434", ollama["baseUrl"]!!.jsonPrimitive.content)
        assertNull(ollama["sealedKey"])
        fun problem(block: () -> Unit) = runCatching(block).exceptionOrNull()
        assertEquals(ProviderSetup.Problem.KEY, problem { ProviderSetup.request("o", "openai", "OpenAI", null, "", key) })
        assertEquals(ProviderSetup.Problem.LABEL, problem { ProviderSetup.request("o", "openai", "", null, "sk", key) })
        assertEquals(ProviderSetup.Problem.URL, problem { ProviderSetup.request("o", "openai", "x", "http://api.openai.com/v1", "sk", key) })
        assertEquals(ProviderSetup.Problem.COMPUTER_KEY, problem { ProviderSetup.request("o", "openai", "x", null, "sk", byteArrayOf(4, 5)) })
    }

    @Test fun `ids are slugs unique among the computer's providers`() {
        assertEquals("anthropic", ProviderSetup.id("Anthropic", "anthropic", emptyList()))
        assertEquals("my-openai-key", ProviderSetup.id("My OpenAI  key!", "openai", emptyList()))
        assertEquals("anthropic-3", ProviderSetup.id("Anthropic", "anthropic", listOf("anthropic", "anthropic-2")))
        assertEquals("openrouter", ProviderSetup.id("日本語", "openrouter", emptyList()))
    }

    @Test fun `the computer's sealing key and a save's answer`() {
        val key = pub(computer())
        val view = Json.parseToJsonElement("""{"publicKey":"${SealedBox.base64url(key)}","context":"nekko-provider-key-v1"}""")
        assertTrue(key.contentEquals(ProviderSetup.computerKey(view)))
        assertEquals(ProviderSetup.Problem.COMPUTER_KEY, runCatching { ProviderSetup.computerKey(Json.parseToJsonElement("""{"publicKey":"BAE"}""")) }.exceptionOrNull())
        val r = ProviderSaveResult.from(Json.parseToJsonElement("""{"ok":true,"models":[{"id":"m1","name":"Model 1"},{"id":"m2"},{"name":"no id"}]}"""))
        assertTrue(r.ok)
        assertEquals(listOf("Model 1", "m2"), r.models.map { it.name })
        val failed = ProviderSaveResult.from(Json.parseToJsonElement("""{"ok":false,"message":"401"}"""))
        assertFalse(failed.ok)
        assertEquals("401", failed.message)
        assertFalse(ProviderSaveResult.from(null).ok)
        assertTrue(Channels.PROVIDERS_SAVE_SEALED in Channels.CHANGE)
        assertTrue(Channels.PROVIDERS_SET_ENABLED in Channels.CHANGE)
        assertFalse("reading the sealing key needs no proof", Channels.PROVIDERS_SEAL_KEY in Channels.CHANGE)
    }
}

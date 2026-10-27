package com.nekko.android

import com.nekko.android.providers.ProviderSetupController
import com.nekko.protocol.Channels
import com.nekko.protocol.P256
import com.nekko.protocol.ProviderSetup
import com.nekko.protocol.SealedBox
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey

/** AN-36: adding a provider with a sealed key and switching one, as the computer sees the calls. */
class ProviderSetupControllerTest {
    /** A computer: its sealing key, what reached it, and the key it opened (never sent back). */
    private class Computer {
        val pair = SealedBox.newKeyPair()
        val public = P256.x963(pair.public as ECPublicKey)
        val sent = mutableListOf<Pair<String, String>>()
        var opened: String? = null
        var answer = """{"ok":true,"models":[{"id":"claude-opus-5.5","name":"Claude Opus 5.5"}]}"""
        var refreshes = 0

        fun read(channel: String): JsonElement {
            sent += channel to "[]"
            return Json.parseToJsonElement("""{"publicKey":"${SealedBox.base64url(public)}","context":"${ProviderSetup.CONTEXT}"}""")
        }

        fun change(channel: String, args: List<JsonElement>): JsonElement {
            sent += channel to JsonArray(args).toString()
            if (channel == Channels.PROVIDERS_SAVE_SEALED) {
                (args[0] as JsonObject)["sealedKey"]?.jsonPrimitive?.content?.let {
                    opened = SealedBox.open(pair.private as ECPrivateKey, public, ProviderSetup.CONTEXT, it).toString(Charsets.UTF_8)
                }
            }
            return Json.parseToJsonElement(answer)
        }

        fun controller() = ProviderSetupController({ read(it) }, { ch, args, _ -> change(ch, args) }, { refreshes++ })
    }

    @Test fun `a key reaches the computer sealed, and only it can open it`() = runTest {
        val c = Computer()
        val result = c.controller().save("anthropic", "anthropic", "Anthropic", null, "sk-ant-api03-secret")
        assertEquals(listOf("Claude Opus 5.5"), result.models.map { it.name })
        assertEquals("sk-ant-api03-secret", c.opened)
        assertEquals(listOf(Channels.PROVIDERS_SEAL_KEY, Channels.PROVIDERS_SAVE_SEALED), c.sent.map { it.first })
        assertTrue("never in clear in anything sent", c.sent.none { "sk-ant" in it.second })
        assertEquals("the computer's providers are read again", 1, c.refreshes)
    }

    @Test fun `a refused key says why and changes nothing here`() = runTest {
        val c = Computer()
        c.answer = """{"ok":false,"message":"Anthropic said the key is invalid (401)."}"""
        val e = runCatching { c.controller().save("anthropic", "anthropic", "Anthropic", null, "sk-bad") }.exceptionOrNull()
        assertEquals("Anthropic said the key is invalid (401).", e?.message)
        assertEquals(0, c.refreshes)
    }

    @Test fun `a local server needs no key and an old computer is said plainly`() = runTest {
        val c = Computer()
        c.controller().save("ollama", "ollama", "Ollama", "http://localhost:11434", null)
        assertFalse("sealedKey" in c.sent.last().second)
        val old = ProviderSetupController({ Json.parseToJsonElement("null") }, { _, _, _ -> error("not sent") }, {})
        val e = runCatching { old.save("o", "openai", "OpenAI", null, "sk-x") }.exceptionOrNull()
        assertEquals(ProviderSetup.Problem.COMPUTER_KEY.message, e?.message)
    }

    @Test fun `a switch flips one provider and reads them again`() = runTest {
        val c = Computer()
        c.answer = """{"ok":true}"""
        c.controller().setEnabled("openai", false)
        assertEquals(Channels.PROVIDERS_SET_ENABLED to """["openai",false]""", c.sent.single())
        assertEquals(1, c.refreshes)
    }
}

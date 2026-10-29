package com.nekko.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.protocol.P256
import com.nekko.protocol.ProviderSetup
import com.nekko.protocol.SealedBox
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyPair
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey

/**
 * AN-36: the provider key's sealed box on Android's own crypto providers
 * (ECDH, HKDF, AES-GCM), byte for byte as `nekko-sync` makes it
 * (`crates/nekko-sync/tests/golden/sync-crypto.json`).
 */
@RunWith(AndroidJUnit4::class)
class SealedBoxDeviceTest {
    @Test fun sealsByteForByteAsTheComputerOpens() {
        val text = InstrumentationRegistry.getInstrumentation().context.assets.open("sync-crypto.json").bufferedReader().readText()
        val v = Json.parseToJsonElement(text).jsonObject
        val dv = v["donation"]!!.jsonObject
        val ev = v["ephemeral"]!!.jsonObject
        fun b(o: kotlinx.serialization.json.JsonObject, k: String) = SealedBox.fromBase64url(o[k]!!.jsonPrimitive.content)
        val researchPublic = b(dv, "researchPublic")
        val context = "nekko-donation/v1\n" + dv["id"]!!.jsonPrimitive.content
        val blob = dv["blob"]!!.jsonPrimitive.content
        val framed = SealedBox.open(SealedBox.privateKey(b(dv, "researchPrivate")), researchPublic, context, blob)
        val eph = KeyPair(P256.publicKey(b(ev, "public")), SealedBox.privateKey(b(ev, "private")))
        assertEquals(blob, SealedBox.seal(researchPublic, context, framed, eph))
    }

    @Test fun aProviderKeyRoundTripsWithAFreshKey() {
        val computer = SealedBox.newKeyPair()
        val public = P256.x963(computer.public as ECPublicKey)
        val sealed = SealedBox.seal(public, ProviderSetup.CONTEXT, "sk-test".toByteArray())
        assertEquals("sk-test", SealedBox.open(computer.private as ECPrivateKey, public, ProviderSetup.CONTEXT, sealed).toString(Charsets.UTF_8))
    }
}

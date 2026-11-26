package com.nekko.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.protocol.P256
import com.nekko.protocol.ProviderSetup
import com.nekko.protocol.SealedBox
import com.nekko.protocol.SyncCrypto
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.long
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

    /** #2835: the account keyring's wrap, join and recovery on Android's providers, as the computer and the iPhone make them. */
    @Test fun syncKeysOpenByteForByteAsTheComputerMakesThem() {
        val text = InstrumentationRegistry.getInstrumentation().context.assets.open("sync-crypto.json").bufferedReader().readText()
        val v = Json.parseToJsonElement(text).jsonObject
        fun o(k: String) = v[k]!!.jsonObject
        fun s(x: kotlinx.serialization.json.JsonObject, k: String) = x[k]!!.jsonPrimitive.content
        fun b(x: kotlinx.serialization.json.JsonObject, k: String) = SyncCrypto.fromBase64url(s(x, k))
        val account = v["account"]!!.jsonPrimitive.content
        val keyring = SyncCrypto.Keyring(SyncCrypto.fromBase64url(v["keyring"]!!.jsonPrimitive.content))
        val device = SyncCrypto.SoftwareKey.fromRaw(b(o("device"), "private"))
        val sender = SyncCrypto.SoftwareKey.fromRaw(b(o("sender"), "private"))
        val eph = SyncCrypto.SoftwareKey.fromRaw(b(o("ephemeral"), "private"))
        val deviceId = s(o("device"), "id")
        assertEquals(s(o("device"), "public"), SyncCrypto.base64url(device.publicKeyX963))
        assertEquals(s(o("wrap"), "blob"), SyncCrypto.wrapKeyring(keyring, account, 1, deviceId, device.publicKeyX963, s(o("sender"), "id"), sender, eph))
        assertEquals(keyring, SyncCrypto.unwrapKeyring(device, account, 1, deviceId, s(o("sender"), "id"), sender.publicKeyX963, s(o("wrap"), "blob")))
        val code = SyncCrypto.JoinCode.parse(s(o("join"), "code"))
        assertEquals(keyring, SyncCrypto.unwrapJoin(device, account, 3, deviceId, code, s(o("join"), "blob")))
        val recovery = SyncCrypto.RecoveryKey.parse(s(o("recovery"), "text"))
        assertEquals(s(o("recovery"), "public"), SyncCrypto.base64url(SyncCrypto.recoveryAgreementKey(recovery).publicKeyX963))
        assertEquals(keyring, SyncCrypto.openRecovery(recovery, account, 1, s(o("recovery"), "blob")))
        val proof = v["epochProofs"]!!.jsonArray[0].jsonObject
        assertEquals(s(proof, "proof"), SyncCrypto.base64url(SyncCrypto.epochProof(keyring, proof["keyId"]!!.jsonPrimitive.long)))
    }

    @Test fun aProviderKeyRoundTripsWithAFreshKey() {
        val computer = SealedBox.newKeyPair()
        val public = P256.x963(computer.public as ECPublicKey)
        val sealed = SealedBox.seal(public, ProviderSetup.CONTEXT, "sk-test".toByteArray())
        assertEquals("sk-test", SealedBox.open(computer.private as ECPrivateKey, public, ProviderSetup.CONTEXT, sealed).toString(Charsets.UTF_8))
    }
}

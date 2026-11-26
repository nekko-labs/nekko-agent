package com.nekko.android

import com.nekko.android.cloud.CloudBrowserSignIn
import com.nekko.android.cloud.SyncDeviceKeys
import com.nekko.android.data.SecureStore
import com.nekko.protocol.CloudHTTP
import com.nekko.protocol.CloudSecrets
import com.nekko.protocol.CloudSync
import com.nekko.protocol.SyncCrypto
import java.net.URI
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The app's Nekko Cloud glue (#2835): the device key's software path and the browser sign-in's one-time verifier. */
class CloudPlatformTest {
    private class Memory : SecureStore, CloudSecrets {
        val items = mutableMapOf<String, String>()
        override suspend fun get(key: String) = items[key]
        override suspend fun set(key: String, value: String?) {
            if (value == null) items.remove(key) else items[key] = value
        }
    }

    @Test fun `without Keystore agreement the phone keeps one sealed software key for good`() = runBlocking {
        // The JVM reports API 0, below Keystore ECDH (API 31): the sealed software key.
        val store = Memory()
        val first = SyncDeviceKeys(store).key()
        assertFalse(SyncDeviceKeys(store).inSecureHardware())
        val raw = store.items[SyncDeviceKeys.SOFTWARE]!!
        assertArrayEquals("the same key after a relaunch", first.publicKeyX963, SyncDeviceKeys(store).key().publicKeyX963)
        assertEquals(raw, store.items[SyncDeviceKeys.SOFTWARE])
        assertEquals("SoftwareKey(..)", first.toString())
    }

    private fun cloud(sessions: MutableList<String>): CloudSync {
        val http = CloudHTTP { method, url, _, body ->
            when (URI(url).path) {
                "/v1/auth/config" -> 200 to """{"supabaseUrl":"https://sb.example","supabaseAnonKey":"anon"}"""
                "/auth/v1/token" -> { sessions += body.orEmpty(); 200 to """{"access_token":"jwt"}""" }
                "/v1/auth/session" -> 201 to """{"token":"nk","account":{"id":"a","email":"ada@example.com","plan":"pro","canSync":true}}"""
                "/v1/auth/me" -> 200 to """{"account":{"id":"a","email":"ada@example.com","plan":"pro","canSync":true}}"""
                "/v1/sync/state" -> 200 to """{"currentKeyId":null,"devices":[]}"""
                else -> 404 to """{"error":"not-found","method":"$method"}"""
            }
        }
        return CloudSync("https://api.example", http, Memory(), null, "Pixel") { SyncCrypto.SoftwareKey.generate() }.also { runBlocking { it.load() } }
    }

    @Test fun `a callback finishes only the sign-in this phone started, once`() = runBlocking {
        val sessions = mutableListOf<String>()
        val cloud = cloud(sessions)
        val signIn = CloudBrowserSignIn()
        // A callback nobody asked for is ignored.
        signIn.finish(cloud, "nekko-agent://cloud-callback?code=planted")
        assertTrue(sessions.isEmpty())
        assertFalse(cloud.view.value.signedIn)
        val start = cloud.oauthStart("github")
        signIn.started(start.verifier)
        signIn.finish(cloud, "nekko-agent://cloud-callback?code=abc")
        assertEquals(1, sessions.size)
        assertTrue(sessions.single().contains(start.verifier))
        assertTrue(cloud.view.value.signedIn)
        assertNull(signIn.error.value)
        // The verifier was used up: the same link again does nothing.
        signIn.finish(cloud, "nekko-agent://cloud-callback?code=abc")
        assertEquals(1, sessions.size)
    }

    @Test fun `a callback without a code says so in our own words`() = runBlocking {
        val cloud = cloud(mutableListOf())
        val signIn = CloudBrowserSignIn()
        signIn.started(cloud.oauthStart("google").verifier)
        signIn.finish(cloud, "nekko-agent://cloud-callback?error=access_denied")
        assertEquals("Sign-in didn't finish. Try again.", signIn.error.value)
        assertFalse(signIn.finishing.value)
    }
}

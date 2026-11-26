package com.nekko.android.cloud

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.annotation.RequiresApi
import com.nekko.android.data.OfflineFileStore
import com.nekko.android.data.SecureStore
import com.nekko.protocol.CloudFiles
import com.nekko.protocol.CloudHTTP
import com.nekko.protocol.CloudSecrets
import com.nekko.protocol.P256
import com.nekko.protocol.SyncAgreementKey
import com.nekko.protocol.SyncCrypto
import java.io.IOException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.TimeUnit
import javax.crypto.KeyAgreement
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Nekko Cloud's secrets in the app's Keystore-sealed store (never backed up). */
class SecureCloudSecrets(private val store: SecureStore) : CloudSecrets {
    override suspend fun get(key: String) = store.get(key)
    override suspend fun set(key: String, value: String?) = store.set(key, value)
}

/** The synced chats, decrypted, in the app's no-backup storage, as the computers' saved chats are kept. */
class CloudChatFiles(private val files: OfflineFileStore) : CloudFiles {
    override suspend fun load(): String? = withContext(Dispatchers.IO) { files.load(FOLDER, NAME)?.toString() }
    override suspend fun save(text: String) = withContext(Dispatchers.IO) { files.save(FOLDER, NAME, Json.parseToJsonElement(text)) }
    override suspend fun remove() = withContext(Dispatchers.IO) { files.remove(FOLDER) }

    private companion object {
        const val FOLDER = "cloud"
        const val NAME = "chats"
    }
}

/** HTTPS only, no redirects (a token must never follow one), bounded answers. */
class OkHttpCloudHTTP : CloudHTTP {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).callTimeout(90, TimeUnit.SECONDS).build()

    override suspend fun send(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String> = withContext(Dispatchers.IO) {
        require(url.startsWith("https://")) { "Nekko Cloud needs HTTPS." }
        val builder = Request.Builder().url(url)
        headers.forEach { (k, v) -> builder.header(k, v) }
        val payload = body?.toRequestBody("application/json".toMediaType())
        builder.method(method, payload ?: if (method == "POST" || method == "PUT") ByteArray(0).toRequestBody() else null)
        client.newCall(builder.build()).execute().use { r ->
            val source = r.body.source()
            source.request(MAX_BODY + 1)
            if (source.buffer.size > MAX_BODY) throw IOException("Nekko Cloud's answer is too large.")
            r.code to source.buffer.readUtf8()
        }
    }

    private companion object {
        const val MAX_BODY = 8_000_000L
    }
}

/**
 * This phone's sync key (#2835), as decided: an Android Keystore agreement key from API 31, which never
 * leaves the secure hardware; below that (and on any phone whose Keystore refuses one), a P-256 software key
 * sealed in the Keystore-backed store. Once made, the same key is used for good: Nekko Cloud knows this phone by it.
 */
class SyncDeviceKeys(private val store: SecureStore) {
    private val lock = Mutex()
    private var cached: SyncAgreementKey? = null

    suspend fun key(): SyncAgreementKey = lock.withLock {
        cached ?: withContext(Dispatchers.IO) { loadOrMake() }.also { cached = it }
    }

    /** Which kind this phone uses, for the Cloud page's footnote. */
    suspend fun inSecureHardware(): Boolean = key() is KeystoreSyncKey

    private suspend fun loadOrMake(): SyncAgreementKey {
        store.get(SOFTWARE)?.let { raw ->
            runCatching { return SyncCrypto.SoftwareKey.fromRaw(SyncCrypto.fromBase64url(raw)) }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching { KeystoreSyncKey.existing() ?: KeystoreSyncKey.make() }.getOrNull()?.let { return it }
        }
        val made = SyncCrypto.SoftwareKey.generate()
        store.set(SOFTWARE, SyncCrypto.base64url(made.rawRepresentation))
        return made
    }

    companion object {
        const val SOFTWARE = "cloud.deviceKey.software"
    }
}

/** A P-256 agreement key inside Android Keystore (API 31+): only ECDH is ever asked of it. */
@RequiresApi(Build.VERSION_CODES.S)
class KeystoreSyncKey private constructor(private val private: PrivateKey, override val publicKeyX963: ByteArray) : SyncAgreementKey {
    override fun sharedSecret(peer: ECPublicKey): ByteArray = KeyAgreement.getInstance("ECDH", PROVIDER).run {
        init(private)
        doPhase(peer, true)
        generateSecret()
    }

    override fun toString() = "KeystoreSyncKey(..)"

    companion object {
        private const val PROVIDER = "AndroidKeyStore"
        const val ALIAS = "nekko.syncKey"

        fun existing(): KeystoreSyncKey? {
            val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
            val entry = ks.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry ?: return null
            return KeystoreSyncKey(entry.privateKey, P256.x963(entry.certificate.publicKey as ECPublicKey))
        }

        fun make(): KeystoreSyncKey {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_AGREE_KEY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .build()
            val pair = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec) }.generateKeyPair()
            return KeystoreSyncKey(pair.private, P256.x963(pair.public as ECPublicKey))
        }
    }
}

/**
 * The browser sign-in while it runs: the PKCE verifier waits here (memory only) until the browser comes back
 * on `nekko-agent://cloud-callback`. A callback with no sign-in waiting is ignored.
 */
class CloudBrowserSignIn {
    private var verifier: String? = null
    private val _finishing = kotlinx.coroutines.flow.MutableStateFlow(false)
    private val _error = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)
    /** The callback came back and the session is being traded. */
    val finishing: kotlinx.coroutines.flow.StateFlow<Boolean> = _finishing
    /** Why the browser sign-in didn't finish, in our own words. */
    val error: kotlinx.coroutines.flow.StateFlow<String?> = _error

    fun started(verifier: String) {
        this.verifier = verifier
        _error.value = null
    }

    /** Trade the callback for a session, once, on the main thread like every other Cloud call. */
    suspend fun finish(cloud: com.nekko.protocol.CloudSync, callback: String) {
        val v = verifier ?: return
        verifier = null
        _finishing.value = true
        try {
            cloud.finishOAuth(callback, v)
            _error.value = null
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            _error.value = (e as? com.nekko.protocol.CloudError)?.message ?: "Sign-in didn't finish. Try again."
        } finally {
            _finishing.value = false
        }
    }

    fun clearError() {
        _error.value = null
    }
}

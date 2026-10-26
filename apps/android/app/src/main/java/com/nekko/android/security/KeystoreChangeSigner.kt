package com.nekko.android.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.security.keystore.UserNotAuthenticatedException
import com.nekko.android.lock.AuthResult
import com.nekko.android.lock.Authenticator
import com.nekko.protocol.ChangeSigner
import com.nekko.protocol.P256
import com.nekko.protocol.RelayException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import kotlin.coroutines.resume

/** Asks the owner for the fingerprint, face or screen lock (the activity's `Authenticator`). */
fun interface OwnerCheck {
    suspend fun confirm(title: String): AuthResult
}

/**
 * [OwnerCheck] through the activity on screen: `MainActivity` attaches its
 * `Authenticator` when created and detaches it when destroyed.
 */
class ActivityOwnerCheck : OwnerCheck {
    @Volatile private var auth: Authenticator? = null

    fun attach(a: Authenticator) {
        auth = a
    }

    fun detach(a: Authenticator) {
        if (auth === a) auth = null
    }

    override suspend fun confirm(title: String): AuthResult = withContext(Dispatchers.Main) {
        val a = auth ?: return@withContext AuthResult.Failed("Open Nekko Agent to confirm this change.") as AuthResult
        suspendCancellableCoroutine<AuthResult> { cont ->
            a.authenticate(title, "One check covers changes for 5 minutes") { cont.resume(it) }
        }
    }
}

/**
 * This phone's Change key (TASKS.md AN-32): a P-256 key in the Android
 * Keystore, in StrongBox where the phone has one, that signs every Change
 * action the computer is asked to run. The computer verifies the signature,
 * so a Change needs the owner here, not just the app open. The iPhone's
 * twin is `SecureEnclaveChangeSigner`.
 *
 * The key can only sign within five minutes of the fingerprint, face or
 * screen lock (`setUserAuthenticationParameters(300, STRONG | CREDENTIAL)`),
 * and is not lost when a finger is enrolled. The app asks itself rather than
 * relying on that window alone: one check here covers five minutes, and a
 * recent unlock of the phone does not count, as on the iPhone.
 *
 * The key never leaves the Keystore; *Forget* of the last computer deletes it.
 */
class KeystoreChangeSigner(
    private val owner: OwnerCheck,
    private val now: () -> Long = System::currentTimeMillis,
) : ChangeSigner {
    private val lock = Mutex()
    @Volatile private var confirmedAt: Long? = null

    override suspend fun publicKey(): ByteArray = withContext(Dispatchers.IO) {
        lock.withLock { P256.x963(entry().certificate.publicKey as ECPublicKey) }
    }

    override suspend fun sign(message: ByteArray): ByteArray {
        if (!recent()) ask()
        return try {
            signNow(message)
        } catch (_: UserNotAuthenticatedException) {
            // The Keystore's own window ran out first (or the key was made after the check): ask once more.
            confirmedAt = null
            ask()
            try {
                signNow(message)
            } catch (_: UserNotAuthenticatedException) {
                throw RelayException("Your fingerprint or screen lock wasn’t accepted for this change. Try again.")
            }
        }
    }

    override suspend fun forget() = withContext(Dispatchers.IO) {
        lock.withLock {
            confirmedAt = null
            keyStore().deleteEntry(ALIAS)
        }
    }

    private suspend fun signNow(message: ByteArray): ByteArray = withContext(Dispatchers.IO) {
        lock.withLock {
            val s = Signature.getInstance("SHA256withECDSA")
            s.initSign(entry().privateKey as PrivateKey)
            s.update(message)
            P256.derToRaw(s.sign())
        }
    }

    private fun recent(): Boolean = confirmedAt?.let { now() - it < REUSE_MS } == true

    private suspend fun ask() {
        when (val r = owner.confirm("Confirm a change on your computer")) {
            AuthResult.Success -> confirmedAt = now()
            AuthResult.Cancelled -> throw RelayException("Not confirmed, so nothing changed on your computer.")
            is AuthResult.Failed -> throw RelayException(
                if (r.message == NO_LOCK) "Set a screen lock on this phone to make changes on your computer from it." else r.message,
            )
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    /** The saved key, or a new one made now. */
    private fun entry(): KeyStore.PrivateKeyEntry {
        val ks = keyStore()
        (ks.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry)?.let { return it }
        try {
            try {
                generate(strongBox = true)
            } catch (_: StrongBoxUnavailableException) {
                generate(strongBox = false)
            }
        } catch (_: Exception) {
            // A key that needs the owner can't be made on a phone without a screen lock.
            throw RelayException("Set a screen lock on this phone to make changes on your computer from it.")
        }
        return ks.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
    }

    private fun generate(strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(false)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setUserAuthenticationParameters(
                        (REUSE_MS / 1000).toInt(),
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                    )
                } else {
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds((REUSE_MS / 1000).toInt())
                }
                if (strongBox) setIsStrongBoxBacked(true)
            }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec) }.generateKeyPair()
    }

    companion object {
        const val ALIAS = "nekko.changeKey"
        private const val PROVIDER = "AndroidKeyStore"
        /** One check covers five minutes, the computer's proof window too. */
        const val REUSE_MS = 300_000L
        /** `Authenticator`'s words when the phone has no screen lock. */
        const val NO_LOCK = "This phone has no screen lock."
    }
}

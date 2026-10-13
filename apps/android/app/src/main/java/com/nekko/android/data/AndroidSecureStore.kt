package com.nekko.android.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * [SecureStore] backed by a private SharedPreferences file. Every value is
 * sealed with AES-256-GCM under a non-exportable Android Keystore key; the
 * entry name is bound as associated data so ciphertexts can't be swapped
 * between slots. Values are never logged.
 */
class AndroidSecureStore(context: Context) : SecureStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        val blob = prefs.getString(key, null) ?: return@withContext null
        try {
            val packed = Base64.decode(blob, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, packed, 0, IV_BYTES))
            cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(packed, IV_BYTES, packed.size - IV_BYTES), Charsets.UTF_8)
        } catch (_: Exception) {
            // The Keystore key is gone (app data restored elsewhere, key invalidated):
            // the value is unreadable for good, so drop it rather than fail forever.
            prefs.edit(commit = true) { remove(key) }
            null
        }
    }

    override suspend fun set(key: String, value: String?) {
        withContext(Dispatchers.IO) {
            if (value == null) {
                prefs.edit(commit = true) { remove(key) }
                return@withContext
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
            val ct = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val packed = cipher.iv + ct
            prefs.edit(commit = true) { putString(key, Base64.encodeToString(packed, Base64.NO_WRAP)) }
        }
    }

    @Synchronized
    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val PREFS = "nekko_secure"
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "nekko.securestore.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}

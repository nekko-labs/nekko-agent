package com.nekko.android.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.nekko.protocol.HelloSigner
import com.nekko.protocol.P256
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * The phone's device key for the relay HELLO (decision 0036): an EC P-256 key
 * in the Android Keystore that never leaves it. Unlike the Change key it needs
 * no fingerprint or screen lock, since every connection signs with it; what it
 * proves is that the HELLO comes from the phone that enrolled, not from
 * someone who only holds the pairing secret.
 */
class KeystoreHelloSigner : HelloSigner {
    private val lock = Any()

    override fun publicKey(): ByteArray = synchronized(lock) {
        P256.x963(entry().certificate.publicKey as ECPublicKey)
    }

    override fun sign(message: ByteArray): ByteArray = synchronized(lock) {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(entry().privateKey as PrivateKey)
        s.update(message)
        P256.derToRaw(s.sign())
    }

    private fun entry(): KeyStore.PrivateKeyEntry {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec) }.generateKeyPair()
        return ks.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
    }

    companion object {
        const val ALIAS = "nekko.helloKey"
        private const val PROVIDER = "AndroidKeyStore"
    }
}

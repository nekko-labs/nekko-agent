package com.nekko.protocol

import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * The phone's device key for the relay HELLO (protocol 5, decision 0036). The
 * computer enrolls its public half with the pairing code and requires every
 * later HELLO to be signed with it, so the pairing secret alone is not enough
 * to connect as this phone. It signs without asking the owner (every
 * connection uses it); the Change key ([ChangeSigner]) is the one that asks.
 */
interface HelloSigner {
    /** X9.63 uncompressed P-256 public key (65 bytes). */
    fun publicKey(): ByteArray

    /** ECDSA P-256 SHA-256 signature of [message], raw r||s (64 bytes). */
    fun sign(message: ByteArray): ByteArray
}

object HelloKey {
    /** The first line of the signed text (crates/nekko-remote `HELLO_KEY_VERSION`). */
    const val VERSION = "nekko-hello-v1"

    /** What a HELLO answering [challenge] signs: the version, deviceId, room and challenge, one per line. */
    fun text(deviceId: String, room: String, challenge: String): String =
        listOf(VERSION, deviceId, room, challenge).joinToString("\n")

    /** The HELLO's `helloKey` and `sig`, both base64. */
    fun proof(signer: HelloSigner, deviceId: String, room: String, challenge: String): Pair<String, String> {
        val enc = Base64.getEncoder()
        return enc.encodeToString(signer.publicKey()) to
            enc.encodeToString(signer.sign(text(deviceId, room, challenge).toByteArray(Charsets.UTF_8)))
    }
}

/** A P-256 device key in memory: for tests, and the fallback where the Keystore is unavailable. */
class SoftwareHelloSigner(private val private: PrivateKey, private val public: ECPublicKey) : HelloSigner {
    override fun publicKey(): ByteArray = P256.x963(public)

    override fun sign(message: ByteArray): ByteArray {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(private)
        s.update(message)
        return P256.derToRaw(s.sign())
    }

    companion object {
        fun generate(): SoftwareHelloSigner {
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            return SoftwareHelloSigner(pair.private, pair.public as ECPublicKey)
        }
    }
}

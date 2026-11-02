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
    const val VERSION = "nekko-hello-v2"

    /**
     * What a HELLO answering [challenge] signs: the version, deviceId, room,
     * challenge and both ephemeral keys, one per line. The keys bind it to this
     * one exchange, so a challenge relayed from elsewhere gets nothing usable.
     */
    fun text(deviceId: String, room: String, challenge: String, hostEph: String, clientEph: String): String =
        listOf(VERSION, deviceId, room, challenge, hostEph, clientEph).joinToString("\n")

    /** The HELLO's `helloKey` and `sig`, both base64. */
    fun proof(signer: HelloSigner, deviceId: String, room: String, challenge: String, hostEph: String, clientEph: String): Pair<String, String> {
        val enc = Base64.getEncoder()
        return enc.encodeToString(signer.publicKey()) to
            enc.encodeToString(signer.sign(text(deviceId, room, challenge, hostEph, clientEph).toByteArray(Charsets.UTF_8)))
    }
}

/**
 * How the computer proves itself (protocol 6, decision 0041): it signs every
 * challenge with the key pinned from the pairing link, so a device that kept
 * the room secret after being revoked can't pose as it.
 */
object HostKey {
    /** The first line of the signed text (crates/nekko-remote `HOST_KEY_VERSION`). */
    const val VERSION = "nekko-host-v1"

    /** What a computer signs in a challenge: the version, room, challenge and its ephemeral key, one per line. */
    fun text(room: String, challenge: String, hostEph: String): String =
        listOf(VERSION, room, challenge, hostEph).joinToString("\n")

    /** Whether [sig] (raw r||s, base64) is [hostKey]'s (X9.63, base64) signature of this challenge. */
    fun verify(hostKey: String, room: String, challenge: String, hostEph: String, sig: String): Boolean = runCatching {
        val b64 = Base64.getDecoder()
        ChangeProof.verify(b64.decode(hostKey), text(room, challenge, hostEph), b64.decode(sig))
    }.getOrDefault(false)
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

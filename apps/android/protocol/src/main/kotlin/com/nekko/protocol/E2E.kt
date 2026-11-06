package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.security.KeyPair
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * End-to-end encryption for relayed traffic, wire-compatible with
 * `packages/shared/src/e2e.ts` (agent side, WebCrypto) and
 * `apps/mobile/src/lib/e2e.ts` (Expo reference).
 *
 * PBKDF2-HMAC-SHA256, 100 000 iterations, salt `nekko-relay:<room>`, derives a
 * 256-bit AES-GCM key. A sealed frame is base64(iv[12] ‖ ciphertext ‖ tag[16]),
 * which is exactly what WebCrypto and javax.crypto produce for AES/GCM.
 *
 * Every device ever paired held that secret, so the room key carries nothing
 * worth having (decision 0041): only the computer's signed challenge. Everything
 * else is sealed under a key only that connection's two ends can derive ([Ephemeral]).
 */
object E2E {
    /** PROTOCOL CONSTANTS: changing any of these breaks every existing pairing. */
    const val SALT_PREFIX = "nekko-relay:"
    const val ITERATIONS = 100_000
    const val KEY_BYTES = 32
    const val IV_BYTES = 12
    private const val TAG_BITS = 128

    /** PROTOCOL CONSTANT: the label of the room credential the relay checks (decision 0036). */
    const val RELAY_AUTH_LABEL = "nekko-relay-auth:"

    /** PROTOCOL CONSTANT: the first line of a connection key's HKDF info. */
    const val SESSION_KEY_VERSION = "nekko-session-v1"

    /**
     * How a stored pairing connects: 2 is [relayAuth], 3 pins the computer's host
     * key (decision 0041). Older stored pairings must pair again.
     */
    const val PAIRING_VERSION = 3

    private val secureRandom = SecureRandom()

    /**
     * The `key=` presented to the relay: hex of HMAC-SHA256 keyed with the
     * pairing secret over `"nekko-relay-auth:" + room`. One-way, so the relay
     * never sees the secret [deriveKey] starts from.
     */
    fun relayAuth(secret: String, room: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return toHex(mac.doFinal((RELAY_AUTH_LABEL + room).toByteArray(Charsets.UTF_8)))
    }

    /**
     * Derive the 32-byte room key. Slow on purpose (about a second on a phone):
     * call it once at pairing time and keep the result in secure storage.
     */
    fun deriveKey(secret: String, room: String): ByteArray {
        // PBEKeySpec takes chars and encodes them as UTF-8 for HMAC-based PBKDF2,
        // matching TextEncoder on the JS side (pairing secrets are ASCII hex anyway).
        val spec = PBEKeySpec(secret.toCharArray(), (SALT_PREFIX + room).toByteArray(Charsets.UTF_8), ITERATIONS, KEY_BYTES * 8)
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }

    /** The HKDF info of a connection's key: both ephemeral keys bind it to this one exchange. */
    fun sessionInfo(room: String, challenge: String, hostEph: String, clientEph: String): String =
        listOf(SESSION_KEY_VERSION, room, challenge, hostEph, clientEph).joinToString("\n")

    /** Encrypt raw UTF-8 text. `iv` is injectable for deterministic tests only. */
    fun sealText(key: ByteArray, plaintext: String, iv: ByteArray = randomBytes(IV_BYTES)): String {
        require(key.size == KEY_BYTES) { "key must be $KEY_BYTES bytes" }
        require(iv.size == IV_BYTES) { "iv must be $IV_BYTES bytes" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        val ct = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(iv + ct)
    }

    /** Decrypt a frame sealed here or on the agent. Throws on a wrong key or tampering. */
    fun openText(key: ByteArray, blob: String): String {
        require(key.size == KEY_BYTES) { "key must be $KEY_BYTES bytes" }
        val packed = Base64.getMimeDecoder().decode(blob)
        if (packed.size < IV_BYTES + TAG_BITS / 8) throw IllegalArgumentException("frame too short")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, packed, 0, IV_BYTES))
        return String(cipher.doFinal(packed, IV_BYTES, packed.size - IV_BYTES), Charsets.UTF_8)
    }

    fun seal(key: ByteArray, value: JsonElement): String = sealText(key, Json.encodeToString(JsonElement.serializer(), value))

    fun open(key: ByteArray, blob: String): JsonElement = Json.parseToJsonElement(openText(key, blob))

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { secureRandom.nextBytes(it) }

    /**
     * A chat's opaque tag, as the computer computes it (`activity_tag` in
     * crates/nekko-remote/src/agent.rs, `E2E.activityTag` on the iPhone): the
     * relay's `dismiss` frames name a chat by it, never by its id.
     */
    fun activityTag(sessionId: String): String =
        toHex(java.security.MessageDigest.getInstance("SHA-256").digest("nekko-activity:$sessionId".toByteArray()).copyOf(16))

    fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0 && hex.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) { "not hex" }
        return ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
}

/**
 * One side of a connection's key exchange: a P-256 key used once. [keys] is
 * injectable for the shared test vector only.
 */
class Ephemeral(private val keys: KeyPair = SealedBox.newKeyPair()) {
    /** The public half as frames carry it: X9.63 uncompressed, base64. */
    val public: String = Base64.getEncoder().encodeToString(P256.x963(keys.public as ECPublicKey))

    /** `HKDF-SHA256(ECDH(ours, theirs), zero salt, info)`, or null when [theirs] is not a point on the curve. */
    fun sessionKey(theirs: String, info: String): ByteArray? = runCatching {
        val secret = SealedBox.agree(keys.private as ECPrivateKey, P256.publicKey(Base64.getDecoder().decode(theirs)))
        SealedBox.hkdf(secret, ByteArray(E2E.KEY_BYTES), info.toByteArray(Charsets.UTF_8), E2E.KEY_BYTES).also { secret.fill(0) }
    }.getOrNull()
}

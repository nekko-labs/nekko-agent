package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// Setting up a model provider on a computer from the phone (AN-36, the
// iPhone's `ProviderSetup`, decision 0016): the phone *carries* the key,
// sealed to the computer's own key, and never holds, stores or reads one. The
// computer opens it, tests it, keeps it, and answers with the models it can
// now use. Mirrors `ProviderSetup.swift`; the computer's side is
// `crates/nekko-remote/src/phone_providers.rs`.

/**
 * The sealed box `nekko-sync` uses for keyrings (the iPhone's
 * `SyncCrypto.seal`): ECIES to a P-256 public key. A one-time key agrees a
 * secret with the recipient; HKDF-SHA256 over it (salt: the one-time public
 * key then the recipient's, info: the context) gives an AES-256-GCM key and
 * nonce; the context is also the associated data. The blob is base64url
 * (no padding) of `0x01 ‖ one-time public key (65) ‖ ciphertext ‖ tag`.
 */
object SealedBox {
    private const val VERSION: Byte = 1
    private const val PUBLIC_KEY_BYTES = 65
    private const val TAG_BYTES = 16

    class Failure(message: String) : Exception(message)

    /** Seal [plaintext] to [recipient] (an X9.63 P-256 public key). [ephemeral] is injectable for tests only. */
    fun seal(recipient: ByteArray, context: String, plaintext: ByteArray, ephemeral: KeyPair = newKeyPair()): String {
        if (recipient.size != PUBLIC_KEY_BYTES || recipient[0] != 4.toByte()) throw Failure("not a P-256 public key")
        val peer = runCatching { P256.publicKey(recipient) }.getOrElse { throw Failure("not a P-256 public key") }
        val ephPub = P256.x963(ephemeral.public as ECPublicKey)
        val secret = agree(ephemeral.private as ECPrivateKey, peer)
        val (key, nonce) = keyAndNonce(secret, ephPub + recipient, context.toByteArray(Charsets.UTF_8))
        secret.fill(0)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
        cipher.updateAAD(context.toByteArray(Charsets.UTF_8))
        val box = cipher.doFinal(plaintext)
        key.fill(0)
        return base64url(byteArrayOf(VERSION) + ephPub + box)
    }

    /** Open a blob sealed to [private] (its public half [publicX963]); the computer's side, here for tests. */
    fun open(private: ECPrivateKey, publicX963: ByteArray, context: String, blob: String): ByteArray {
        val raw = fromBase64url(blob)
        if (raw.size < 1 + PUBLIC_KEY_BYTES + TAG_BYTES || raw[0] != VERSION) throw Failure("malformed")
        val ephPub = raw.copyOfRange(1, 1 + PUBLIC_KEY_BYTES)
        val secret = agree(private, P256.publicKey(ephPub))
        val (key, nonce) = keyAndNonce(secret, ephPub + publicX963, context.toByteArray(Charsets.UTF_8))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
        cipher.updateAAD(context.toByteArray(Charsets.UTF_8))
        return try {
            cipher.doFinal(raw, 1 + PUBLIC_KEY_BYTES, raw.size - 1 - PUBLIC_KEY_BYTES)
        } catch (_: Exception) {
            throw Failure("unauthentic")
        }
    }

    fun newKeyPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1"), SecureRandom()) }.generateKeyPair()

    /** A P-256 private key from its 32-byte scalar (test vectors). */
    fun privateKey(scalar: ByteArray): ECPrivateKey =
        java.security.KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, scalar), P256.params)) as ECPrivateKey

    /** The raw ECDH secret: the shared point's x coordinate, 32 bytes. */
    private fun agree(private: ECPrivateKey, peer: ECPublicKey): ByteArray =
        KeyAgreement.getInstance("ECDH").run {
            init(private)
            doPhase(peer, true)
            generateSecret()
        }

    /** HKDF-SHA256 to 44 bytes: an AES-256 key, then a 12-byte nonce. */
    private fun keyAndNonce(ikm: ByteArray, salt: ByteArray, info: ByteArray): Pair<ByteArray, ByteArray> {
        val prk = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(salt, "HmacSHA256"))
            doFinal(ikm)
        }
        val okm = ByteArray(44)
        var t = ByteArray(0)
        var filled = 0
        var counter = 1
        while (filled < okm.size) {
            t = Mac.getInstance("HmacSHA256").run {
                init(SecretKeySpec(prk, "HmacSHA256"))
                update(t)
                update(info)
                update(counter.toByte())
                doFinal()
            }
            val n = minOf(t.size, okm.size - filled)
            System.arraycopy(t, 0, okm, filled, n)
            filled += n
            counter++
        }
        prk.fill(0)
        return okm.copyOfRange(0, 32) to okm.copyOfRange(32, 44)
    }

    fun base64url(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    fun fromBase64url(s: String): ByteArray {
        if (!s.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' || it == '=' }) throw Failure("malformed")
        return runCatching { Base64.getUrlDecoder().decode(s.trimEnd('=')) }.getOrElse { throw Failure("malformed") }
    }
}

/** Adding a provider to a computer from the phone (decision 0016). */
object ProviderSetup {
    /** The sealed box's context, the same string the computer opens under. */
    const val CONTEXT = "nekko-provider-key-v1"

    /** A kind a phone may add, in the order the screen shows them. */
    data class Kind(
        val id: String,
        val label: String,
        /** Needs an API key (and an https base URL). */
        val needsKey: Boolean,
        /** Takes a base URL (a local server, or an OpenAI-compatible one). */
        val takesUrl: Boolean,
        val defaultUrl: String,
    )

    val KINDS = listOf(
        Kind("anthropic", "Anthropic", needsKey = true, takesUrl = false, defaultUrl = "https://api.anthropic.com"),
        Kind("openai", "OpenAI", needsKey = true, takesUrl = false, defaultUrl = "https://api.openai.com/v1"),
        Kind("openrouter", "OpenRouter", needsKey = true, takesUrl = false, defaultUrl = "https://openrouter.ai/api/v1"),
        Kind("ollama", "Ollama", needsKey = false, takesUrl = true, defaultUrl = "http://localhost:11434"),
        Kind("lmstudio", "LM Studio", needsKey = false, takesUrl = true, defaultUrl = "http://localhost:1234/v1"),
        Kind("vllm", "vLLM", needsKey = false, takesUrl = true, defaultUrl = "http://localhost:8000/v1"),
        Kind("openai-compat", "OpenAI-compatible", needsKey = false, takesUrl = true, defaultUrl = "http://localhost:8080/v1"),
    )

    fun kind(id: String): Kind? = KINDS.firstOrNull { it.id == id }

    /** A kind's name for a provider row (`Anthropic`, `Ollama`), or the id as sent. */
    fun kindName(id: String): String = kind(id)?.label ?: id

    /** A provider id from its label: lowercase, dashes, unique among [existing]. */
    fun id(label: String, kind: String, existing: Collection<String>): String {
        val sb = StringBuilder()
        for (c in label.lowercase()) {
            val keep = c in 'a'..'z' || c in '0'..'9'
            if (keep) sb.append(c) else if (sb.lastOrNull() != '-') sb.append('-')
        }
        var slug = sb.toString().trim('-').ifEmpty { kind }.take(56)
        var candidate = slug
        var n = 2
        while (candidate in existing) candidate = "$slug-${n++}"
        return candidate
    }

    /** What the screen says when a request can't be made. */
    class Problem(message: String) : Exception(message) {
        companion object {
            val LABEL = Problem("Give the provider a name.")
            val KEY = Problem("Paste the API key.")
            val URL = Problem("The address must start with http:// or https://.")
            val COMPUTER_KEY = Problem("The computer didn’t send a key to seal to. Update Nekko Agent there.")
        }
    }

    /** The computer's sealing key from `providers:sealKey`: its X9.63 public key, or [Problem.COMPUTER_KEY]. */
    fun computerKey(v: JsonElement?): ByteArray {
        val o = v.obj() ?: throw Problem.COMPUTER_KEY
        if (o.str("context") != CONTEXT) throw Problem.COMPUTER_KEY
        val key = o.str("publicKey")?.let { runCatching { SealedBox.fromBase64url(it) }.getOrNull() } ?: throw Problem.COMPUTER_KEY
        if (key.size != 65 || key[0] != 4.toByte()) throw Problem.COMPUTER_KEY
        return key
    }

    /**
     * The `providers:saveSealed` argument: the provider without its key, and the
     * key sealed to [computerKey]. [key] is used once, here, and never kept.
     */
    fun request(id: String, kind: String, label: String, baseUrl: String?, key: String?, computerKey: ByteArray): JsonObject {
        val k = kind(kind) ?: throw Problem.URL
        val name = label.trim()
        if (name.isEmpty()) throw Problem.LABEL
        val url = baseUrl?.trim().orEmpty()
        val secret = key?.trim().orEmpty()
        if (k.needsKey && secret.isEmpty()) throw Problem.KEY
        val sendUrl = url.isNotEmpty() && (url != k.defaultUrl || k.takesUrl)
        if (sendUrl && (!(url.startsWith("https://") || (url.startsWith("http://") && !k.needsKey)) || url.any { it.isWhitespace() })) throw Problem.URL
        val sealed = if (secret.isNotEmpty()) {
            if (computerKey.size != 65) throw Problem.COMPUTER_KEY
            SealedBox.seal(computerKey, CONTEXT, secret.toByteArray(Charsets.UTF_8))
        } else {
            null
        }
        return buildJsonObject {
            put("id", id)
            put("kind", k.id)
            put("label", name)
            if (sendUrl) put("baseUrl", url)
            if (sealed != null) put("sealedKey", sealed)
        }
    }
}

/** `providers:saveSealed` and `providers:setEnabled` as the computer answers them. */
data class ProviderSaveResult(val ok: Boolean, val message: String? = null, val models: List<Model> = emptyList()) {
    data class Model(val id: String, val name: String)

    companion object {
        fun from(v: JsonElement?): ProviderSaveResult {
            val o = v.obj() ?: return ProviderSaveResult(false)
            val models = o["models"].arr().orEmpty().mapNotNull { m ->
                val mo = m.obj() ?: return@mapNotNull null
                mo.str("id")?.let { Model(it, mo.str("name") ?: it) }
            }
            return ProviderSaveResult((o["ok"] as? JsonPrimitive)?.content == "true", o.str("message"), models)
        }
    }
}

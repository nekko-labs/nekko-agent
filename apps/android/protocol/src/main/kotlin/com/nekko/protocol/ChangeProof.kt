package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.Base64

/**
 * The signed proof a phone attaches to a Change action (TASKS.md IO-33, AN-32).
 *
 * The computer refuses a change-class call (editing a file, a git commit, a
 * terminal, raising a chat's mode) unless it carries `proof: { ts, sig }`
 * beside `args`: an ECDSA P-256 SHA-256 signature, by the key this phone
 * registered over `device:registerKey`, of
 *
 *     nekko-change-v1 \n deviceId \n channel \n hex(sha256(canonical JSON of args)) \n ts
 *
 * (`ts` in milliseconds since the epoch). The computer refuses a proof more
 * than 5 minutes old or a minute ahead, and one it has seen before. Mirrors
 * `ChangeProof.swift` and `crates/nekko-remote/src/proof.rs`; all three are
 * tested against `crates/nekko-remote/tests/golden/change-proof.json`.
 */
object ChangeProof {
    const val VERSION = "nekko-change-v1"

    /** The phone channel the computer's gate answers itself (`PHONE_KEY_CHANNEL`). */
    const val KEY_CHANNEL = "device:registerKey"

    /** Arguments that hold a number other than an integer within ±2^53. */
    class Unsignable : Exception("This change can’t be signed.")

    private val MAX_SAFE = BigInteger.ONE.shiftLeft(53)

    /**
     * The canonical JSON of a call's arguments: no whitespace, object keys
     * sorted by their UTF-8 bytes, integers in plain decimal, strings escaping
     * only `"`, `\` and U+0000 to U+001F (as `\u00xx`).
     */
    fun canonicalJson(v: JsonElement): String = StringBuilder().also { write(v, it) }.toString()

    private fun write(v: JsonElement, out: StringBuilder) {
        when (v) {
            JsonNull -> out.append("null")
            is JsonPrimitive -> when {
                v.isString -> quote(v.content, out)
                v.content == "true" || v.content == "false" -> out.append(v.content)
                else -> out.append(integer(v.content))
            }
            is JsonArray -> {
                out.append('[')
                v.forEachIndexed { i, x ->
                    if (i > 0) out.append(',')
                    write(x, out)
                }
                out.append(']')
            }
            is JsonObject -> {
                out.append('{')
                v.keys.sortedWith(UTF8_ORDER).forEachIndexed { i, k ->
                    if (i > 0) out.append(',')
                    quote(k, out)
                    out.append(':')
                    write(v.getValue(k), out)
                }
                out.append('}')
            }
        }
    }

    /** A JSON number as a plain integer, or [Unsignable] (a fraction, an exponent past 2^53, not finite). */
    private fun integer(text: String): String {
        val n = runCatching { java.math.BigDecimal(text) }.getOrNull() ?: throw Unsignable()
        val whole = runCatching { n.toBigIntegerExact() }.getOrNull() ?: throw Unsignable()
        if (whole.abs() > MAX_SAFE) throw Unsignable()
        return whole.toString()
    }

    private val UTF8_ORDER = Comparator<String> { a, b ->
        val x = a.toByteArray(Charsets.UTF_8)
        val y = b.toByteArray(Charsets.UTF_8)
        for (i in 0 until minOf(x.size, y.size)) {
            val d = (x[i].toInt() and 0xff) - (y[i].toInt() and 0xff)
            if (d != 0) return@Comparator d
        }
        x.size - y.size
    }

    private fun quote(s: String, out: StringBuilder) {
        out.append('"')
        for (ch in s) {
            when {
                ch == '"' -> out.append("\\\"")
                ch == '\\' -> out.append("\\\\")
                ch.code < 0x20 -> out.append("\\u00").append(String.format("%02x", ch.code))
                else -> out.append(ch)
            }
        }
        out.append('"')
    }

    fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /** The text this phone signs for one call. */
    fun payload(deviceId: String, channel: String, args: JsonArray, ts: Long): String =
        listOf(VERSION, deviceId, channel, sha256Hex(canonicalJson(args)), ts.toString()).joinToString("\n")

    /** `{ ts, sig }` for a call, signed by [signer]. */
    suspend fun proof(signer: ChangeSigner, deviceId: String, channel: String, args: JsonArray, ts: Long): JsonObject {
        val sig = signer.sign(payload(deviceId, channel, args, ts).toByteArray(Charsets.UTF_8))
        return buildJsonObject {
            put("ts", ts)
            put("sig", Base64.getEncoder().encodeToString(sig))
        }
    }

    /** Whether [sig] (raw r||s) is [publicKey]'s (X9.63) signature of [text]. */
    fun verify(publicKey: ByteArray, text: String, sig: ByteArray): Boolean = runCatching {
        val v = Signature.getInstance("SHA256withECDSA")
        v.initVerify(P256.publicKey(publicKey))
        v.update(text.toByteArray(Charsets.UTF_8))
        v.verify(P256.rawToDer(sig))
    }.getOrDefault(false)
}

/**
 * What signs this phone's Change proofs. In the app, an Android Keystore key
 * behind the fingerprint or the screen lock (`KeystoreChangeSigner`); in
 * tests, [SoftwareChangeSigner].
 */
interface ChangeSigner {
    /** The public key the computer verifies with: X9.63 uncompressed P-256 (65 bytes). */
    suspend fun publicKey(): ByteArray

    /**
     * An ECDSA P-256 SHA-256 signature of [message], raw r||s (64 bytes). May
     * ask for the fingerprint or the screen lock; throws if the owner cancels.
     */
    suspend fun sign(message: ByteArray): ByteArray

    /** Delete the key (no computer is paired any more); the next Change makes a new one. */
    suspend fun forget() {}
}

/** A P-256 key in memory: for tests. */
class SoftwareChangeSigner(private val private: PrivateKey, private val public: ECPublicKey) : ChangeSigner {
    var signatures = 0
        private set

    override suspend fun publicKey(): ByteArray = P256.x963(public)

    override suspend fun sign(message: ByteArray): ByteArray {
        synchronized(this) { signatures++ }
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(private)
        s.update(message)
        return P256.derToRaw(s.sign())
    }

    companion object {
        fun generate(): SoftwareChangeSigner {
            val g = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
            val pair = g.generateKeyPair()
            return SoftwareChangeSigner(pair.private, pair.public as ECPublicKey)
        }

        /** From a raw 32-byte private scalar and its X9.63 public key (the shared test vector's). */
        fun of(rawPrivate: ByteArray, x963Public: ByteArray): SoftwareChangeSigner {
            val f = KeyFactory.getInstance("EC")
            val priv = f.generatePrivate(ECPrivateKeySpec(BigInteger(1, rawPrivate), P256.params))
            return SoftwareChangeSigner(priv, P256.publicKey(x963Public))
        }
    }
}

/** P-256 encodings: X9.63 public keys and raw r||s signatures, as the computer and the iPhone use them. */
object P256 {
    val params: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(ECParameterSpec::class.java)
    }

    /** `04 || x || y`, each coordinate 32 bytes. */
    fun x963(key: ECPublicKey): ByteArray =
        byteArrayOf(4) + fixed(key.w.affineX) + fixed(key.w.affineY)

    fun publicKey(x963: ByteArray): ECPublicKey {
        require(x963.size == 65 && x963[0] == 4.toByte()) { "not an uncompressed P-256 key" }
        val point = ECPoint(BigInteger(1, x963.copyOfRange(1, 33)), BigInteger(1, x963.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params)) as ECPublicKey
    }

    /** A Java/Keystore DER `SEQUENCE { r, s }` as raw r||s (64 bytes). */
    fun derToRaw(der: ByteArray): ByteArray {
        var i = 0
        fun next() = der[i++].toInt() and 0xff
        fun length(): Int {
            val first = next()
            if (first < 0x80) return first
            var n = 0
            repeat(first and 0x7f) { n = (n shl 8) or next() }
            return n
        }
        require(next() == 0x30) { "not a DER signature" }
        length()
        fun int(): BigInteger {
            require(next() == 0x02) { "not a DER integer" }
            val len = length()
            return BigInteger(1, der.copyOfRange(i, i + len)).also { i += len }
        }
        return fixed(int()) + fixed(int())
    }

    /** Raw r||s as DER, for `Signature.verify`. */
    fun rawToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64) { "not a raw P-256 signature" }
        fun int(b: ByteArray): ByteArray {
            val v = BigInteger(1, b).toByteArray() // minimal, with a leading 0 when the top bit is set
            return byteArrayOf(2, v.size.toByte()) + v
        }
        val body = int(raw.copyOfRange(0, 32)) + int(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    private fun fixed(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }
}

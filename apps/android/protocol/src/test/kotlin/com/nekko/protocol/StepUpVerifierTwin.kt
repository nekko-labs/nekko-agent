package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * A JVM twin of the computer's step-up verifier (`checkStepUp` in
 * packages/shared/src/step-up.ts, `check` in crates/nekko-remote/src/step_up.rs),
 * for tests only: the phone never verifies a step-up, the computer does. It
 * exists so the Kotlin side reads `step-up.json` the way the other two do, and
 * so the payloads the phone builds are proven to be what a verifier accepts.
 * Ported line by line; the order of the checks is the order of the refusals.
 */
internal object StepUpVerifierTwin {
    class Outcome(
        val result: String,
        val method: String? = null,
        val uv: Boolean? = null,
        val cloned: String? = null,
        val state: JsonObject,
        val issued: JsonArray,
    )

    private const val TTL_MS = StepUp.CHALLENGE_TTL_MS
    private const val WINDOW = 1
    private const val MAX_WRONG = 5L
    private const val LOCK_MS = 60_000L

    fun check(state: JsonObject, issued: JsonArray, now: Long, stepUp: JsonElement?): Outcome {
        val st = state.toMutable()
        @Suppress("UNCHECKED_CAST")
        val creds = (st["credentials"] as MutableList<Any?>).map { it as MutableMap<String, Any?> }
        val book = issued.map { (it as JsonObject).toMutable() }
        fun out(result: String, method: String? = null, uv: Boolean? = null, cloned: String? = null) =
            Outcome(result, method, uv, cloned, toJson(st) as JsonObject, JsonArray(book.map(::toJson)))

        if (stepUp == null || stepUp is JsonNull) return out("step-up-required")
        if (stepUp !is JsonObject) return out("step-up-invalid")
        if ("totp" in stepUp) return checkTotp(st, now, stepUp["totp"], ::out)
        val fields = listOf("credentialId", "authenticatorData", "clientDataJSON", "signature")
        val texts = fields.map { (stepUp[it] as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        if (texts.any { it == null }) return out("step-up-invalid")
        val bytes = texts.map { StepUp.fromB64url(it!!) }
        if (bytes.any { it == null }) return out("step-up-invalid")
        val (idB, authData, cdj, sigDer) = bytes.map { it!! }
        val cred = creds.firstOrNull { c -> StepUp.fromB64url(c["id"] as String)?.contentEquals(idB) == true }
            ?: return out("step-up-invalid")
        val client = runCatching {
            val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(cdj)).toString()
            WireJson.parseToJsonElement(text)
        }.getOrNull() as? JsonObject ?: return out("step-up-invalid")
        val type = (client["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val said = (client["challenge"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (type != StepUp.CLIENT_TYPE || said == null) return out("step-up-invalid")
        val saidB = StepUp.fromB64url(said)
        val entry = saidB?.let { s -> book.firstOrNull { StepUp.fromB64url(it["challenge"] as String)?.contentEquals(s) == true } }
            ?: return out("step-up-invalid")
        if (entry["used"] == true) return out("step-up-replayed")
        entry["used"] = true
        if (now - (entry["issuedAt"] as Long) > TTL_MS) return out("step-up-stale")
        val origin = (client["origin"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        @Suppress("UNCHECKED_CAST")
        if (origin == null || origin !in (st["origins"] as List<Any?>)) return out("step-up-invalid")
        if (authData.size < 37) return out("step-up-invalid")
        if (!authData.copyOfRange(0, 32).contentEquals(sha256((st["rpId"] as String).toByteArray()))) return out("step-up-invalid")
        val flags = authData[32].toInt() and 0xff
        if (flags and 0x01 == 0) return out("step-up-invalid")
        val raw = derToRaw(sigDer)
        val key = StepUp.fromB64url(cred["publicKey"] as String)
        if (raw == null || key == null || key.size != 65 || key[0] != 4.toByte()) return out("step-up-invalid")
        val ok = runCatching {
            val s = Signature.getInstance("SHA256withECDSAinP1363Format")
            s.initVerify(p256(key))
            s.update(authData + sha256(cdj))
            s.verify(raw)
        }.getOrDefault(false)
        if (!ok) return out("step-up-invalid")
        val counter = ((authData[33].toLong() and 0xff) shl 24) + ((authData[34].toLong() and 0xff) shl 16) +
            ((authData[35].toLong() and 0xff) shl 8) + (authData[36].toLong() and 0xff)
        val stored = (cred["counter"] as? Long)?.toDouble() ?: Double.POSITIVE_INFINITY
        if (!(counter == 0L && stored == 0.0) && counter.toDouble() <= stored) {
            cred["cloned"] = true
            return out("step-up-invalid", cloned = cred["id"] as String)
        }
        cred["counter"] = counter
        cred["lastUsedAt"] = now
        return out("ok", method = "fido2", uv = flags and 0x04 != 0)
    }

    private fun checkTotp(
        st: MutableMap<String, Any?>,
        now: Long,
        code: JsonElement?,
        out: (String, String?, Boolean?, String?) -> Outcome,
    ): Outcome {
        @Suppress("UNCHECKED_CAST")
        val t = st["totp"] as? MutableMap<String, Any?> ?: return out("step-up-invalid", null, null, null)
        val lockedUntil = t["lockedUntil"] as? Long
        if (lockedUntil != null && now < lockedUntil) return out("step-up-invalid", null, null, null)
        val secret = base32Decode(t["secret"] as String)
        if (secret == null || secret.isEmpty()) return out("step-up-invalid", null, null, null)
        val step = totpStep(now)
        val text = (code as? JsonPrimitive)?.takeIf { it.isString }?.content
        var matched: Long? = null
        if (text != null && Regex("^[0-9]{6}$").matches(text)) {
            for (d in -WINDOW..WINDOW) {
                if (totpAt(secret, step + d) == text) {
                    matched = step + d
                    break
                }
            }
        }
        if (matched != null) {
            val last = t["lastStep"] as? Long
            if (last != null && matched <= last) return out("step-up-replayed", null, null, null)
            t["lastStep"] = matched
            t["lastUsedAt"] = now
            t.remove("wrong"); t.remove("lockedUntil"); t.remove("locks")
            return out("ok", "totp", null, null)
        }
        val wrong = ((t["wrong"] as? Long) ?: 0L) + 1
        t["wrong"] = wrong
        if (wrong >= MAX_WRONG) {
            val locks = (t["locks"] as? Long) ?: 0L
            t["lockedUntil"] = now + LOCK_MS * (1L shl locks.toInt())
            t["locks"] = locks + 1
            t["wrong"] = 0L
        }
        return out("step-up-invalid", null, null, null)
    }

    fun totpStep(nowMs: Long): Long = Math.floorDiv(nowMs / 1000, StepUp.TOTP_PERIOD_S.toLong())

    fun totpAt(secret: ByteArray, step: Long): String {
        val msg = ByteArray(8) { i -> (step ushr (8 * (7 - i))).toByte() }
        val mac = Mac.getInstance("HmacSHA1").apply { init(SecretKeySpec(secret, "HmacSHA1")) }.doFinal(msg)
        val off = mac[mac.size - 1].toInt() and 0x0f
        val bin = ((mac[off].toInt() and 0x7f) shl 24) or ((mac[off + 1].toInt() and 0xff) shl 16) or
            ((mac[off + 2].toInt() and 0xff) shl 8) or (mac[off + 3].toInt() and 0xff)
        return (bin % 1_000_000).toString().padStart(StepUp.TOTP_DIGITS, '0')
    }

    fun base32Decode(text: String): ByteArray? {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var bits = 0
        var value = 0
        val out = java.io.ByteArrayOutputStream()
        for (c in text.filterNot { it.isWhitespace() || it == '=' }.uppercase()) {
            val i = alphabet.indexOf(c)
            if (i < 0) return null
            value = ((value shl 5) or i) and 0xffff
            bits += 5
            if (bits >= 8) {
                out.write((value ushr (bits - 8)) and 0xff)
                bits -= 8
            }
        }
        return out.toByteArray()
    }

    /** `hashRecoveryCode`: hex SHA-256 of the code, ignoring case, spaces and dashes. */
    fun hashRecoveryCode(code: String): String =
        sha256(code.lowercase().filter { it in 'a'..'z' || it in '0'..'9' }.toByteArray()).joinToString("") { "%02x".format(it) }

    fun derToRaw(der: ByteArray): ByteArray? {
        var i = 0
        fun byte(): Int = if (i < der.size) der[i++].toInt() and 0xff else -1
        if (byte() != 0x30) return null
        val total = byte()
        if (total < 0 || total and 0x80 != 0 || total != der.size - 2) return null
        val out = ByteArray(64)
        for (part in 0 until 2) {
            if (byte() != 0x02) return null
            val len = byte()
            if (len < 1 || len > 33 || i + len > der.size) return null
            var int = der.copyOfRange(i, i + len)
            i += len
            if (int.size == 33) {
                if (int[0] != 0.toByte()) return null
                int = int.copyOfRange(1, 33)
            }
            int.copyInto(out, part * 32 + (32 - int.size))
        }
        return if (i == der.size) out else null
    }

    private fun p256(point: ByteArray) = KeyFactory.getInstance("EC").generatePublic(
        ECPublicKeySpec(
            ECPoint(BigInteger(1, point.copyOfRange(1, 33)), BigInteger(1, point.copyOfRange(33, 65))),
            AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java),
        ),
    )

    private fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    // ---- JSON as mutable maps, so the updated state compares with the fixture's ----

    private fun JsonObject.toMutable(): MutableMap<String, Any?> = mapValuesTo(LinkedHashMap()) { (_, v) -> fromJson(v) }

    private fun fromJson(e: JsonElement): Any? = when (e) {
        is JsonNull -> null
        is JsonObject -> e.toMutable()
        is JsonArray -> e.mapTo(ArrayList()) { fromJson(it) }
        is JsonPrimitive -> when {
            e.isString -> e.content
            e.booleanOrNull != null -> e.booleanOrNull
            e.longOrNull != null -> e.longOrNull
            else -> e.contentOrNull?.toDouble()
        }
    }

    private fun toJson(v: Any?): JsonElement = when (v) {
        null -> JsonNull
        is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k as String to toJson(x) })
        is List<*> -> JsonArray(v.map(::toJson))
        is String -> JsonPrimitive(v)
        is Boolean -> JsonPrimitive(v)
        is Long -> JsonPrimitive(v)
        is Number -> JsonPrimitive(v)
        else -> error("unexpected $v")
    }
}

package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.util.Base64

/**
 * Step-up on the phone (SK-7): a second factor the owner holds, a FIDO2
 * security key, a passkey or a one-time code, asked for on top of the Change
 * proof before a guarded action (today: raising a chat's mode or the default
 * mode). Spec `spec/platform/hardware-keys-step-up-and-remote-sign-out.md`,
 * decision 0018. Mirrors `packages/shared/src/step-up.ts`; the computer
 * (`crates/nekko-remote/src/step_up.rs`) is the only verifier.
 *
 * What the phone does, and only that:
 * 1. A guarded call comes back refused `step-up-required` (or `-invalid`,
 *    `-stale`, `-replayed`): show the step-up sheet ([StepUpCode.asksAgain]).
 * 2. Fetch a fresh single-use challenge with `security:challenge`
 *    ([StepUpChallenge]); it also says which kinds of method exist.
 * 3. Get an assertion over that challenge from the platform's FIDO2 client
 *    (Credential Manager, [assertionRequestJson]), or read six digits.
 * 4. Send the same call again with `stepUp` beside `proof` in the sealed
 *    request ([StepUpProof.toJson]). A fresh challenge for every try: any
 *    answer to a live challenge spends it, accepted or not.
 *
 * Nothing about registered methods beyond their kinds ever reaches the phone.
 */
object StepUp {
    /** `security:challenge`: read class from a phone. */
    const val CHALLENGE_CHANNEL = "security:challenge"
    /** 18 random bytes as unpadded base64url. */
    const val CHALLENGE_BYTES = 18
    /** The computer refuses `step-up-stale` after this long. */
    const val CHALLENGE_TTL_MS = 2 * 60 * 1000L
    /** One accepted step-up covers the phone's guarded calls this long (the computer keeps it in memory). */
    const val COVER_MS = 5 * 60 * 1000L
    /** WebAuthn's assertion type in `clientDataJSON`. */
    const val CLIENT_TYPE = "webauthn.get"
    /** RFC 6238 as the computer checks it: 30 s steps, six digits, one step either side. */
    const val TOTP_DIGITS = 6
    const val TOTP_PERIOD_S = 30
    /** The guarded phone channels (`STEP_UP_PHONE_GUARDED`), when they raise a mode. */
    val GUARDED_CHANNELS = setOf(Channels.SESSION_SET_OPTIONS, Channels.SETTINGS_UPDATE)

    /** ES256, the only algorithm the computer verifies (P-256, `SecurityCredential.publicKey`). */
    const val COSE_ES256 = -7L

    /** How long the platform sheet may stay up; the challenge itself lives two minutes. */
    const val WEBAUTHN_TIMEOUT_MS = 90_000L

    /**
     * The relying-party id of a computer (`stepUpRpId`): per computer, so a
     * credential registered on one is useless on another.
     */
    fun rpId(installId: String): String = "nekko-computer:$installId"

    /**
     * Six digits from what the owner typed (spaces and dashes allowed, as
     * authenticator apps group them), or null when it is not a code.
     */
    fun normalizeCode(text: String): String? {
        val digits = text.filterNot { it == ' ' || it == '-' || it == ' ' }
        return digits.takeIf { it.length == TOTP_DIGITS && it.all { c -> c in '0'..'9' } }
    }

    // ---- base64url, as WebAuthn's JSON forms carry bytes ----

    /** Unpadded base64url. */
    fun b64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** Base64 or base64url, padded or not (`fromB64url` in step-up.ts); null when it is neither. */
    fun fromB64url(text: String): ByteArray? {
        if (!Regex("^[A-Za-z0-9+/_-]*={0,2}$").matches(text)) return null
        val url = text.replace('+', '-').replace('/', '_').trimEnd('=')
        if (url.length % 4 == 1) return null
        return try {
            Base64.getUrlDecoder().decode(url)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** Standard padded base64: how `security.json` keeps a credential's public key. */
    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    // ---- the platform requests ----

    /**
     * WebAuthn `PublicKeyCredentialRequestOptionsJSON` for Credential
     * Manager's `GetPublicKeyCredentialOption`: the computer's challenge and
     * relying-party id, no `allowCredentials` (the phone is never told which
     * credentials exist, only their kinds), so the authenticator offers its
     * discoverable credentials for this relying party. A security key that
     * holds only non-discoverable credentials cannot answer without the
     * computer naming them; the spec's Settings note covers that limit.
     */
    fun assertionRequestJson(challenge: String, rpId: String, timeoutMs: Long = WEBAUTHN_TIMEOUT_MS): String = buildJsonObject {
        put("challenge", challenge)
        put("rpId", rpId)
        put("timeout", timeoutMs)
        putJsonArray("allowCredentials") {}
        // The computer records UV but accepts presence alone (the golden's passkey case).
        put("userVerification", "preferred")
    }.toString()

    /**
     * WebAuthn `PublicKeyCredentialCreationOptionsJSON` for Credential
     * Manager's `CreatePublicKeyCredentialRequest`. ES256 only, no
     * attestation (the computer trusts the owner's touch, not a vendor
     * certificate), a discoverable credential so a step-up can find it with an
     * empty `allowCredentials`. [kind] picks the authenticator: a security key
     * over NFC or USB-C (`cross-platform`) or this phone (`platform`).
     *
     * [userId] is opaque bytes the computer chooses (never the owner's name);
     * [userName] is what the key or the password manager lists it under.
     */
    fun registrationRequestJson(
        challenge: String,
        rpId: String,
        rpName: String,
        userId: ByteArray,
        userName: String,
        kind: StepUpMethod,
        timeoutMs: Long = WEBAUTHN_TIMEOUT_MS,
    ): String {
        require(kind != StepUpMethod.TOTP) { "a one-time code is not a FIDO2 credential" }
        return buildJsonObject {
            put("challenge", challenge)
            putJsonObject("rp") {
                put("id", rpId)
                put("name", rpName)
            }
            putJsonObject("user") {
                put("id", b64url(userId))
                put("name", userName)
                put("displayName", userName)
            }
            putJsonArray("pubKeyCredParams") {
                add(buildJsonObject { put("type", "public-key"); put("alg", COSE_ES256) })
            }
            put("timeout", timeoutMs)
            put("attestation", "none")
            putJsonObject("authenticatorSelection") {
                put("authenticatorAttachment", if (kind == StepUpMethod.PASSKEY) "platform" else "cross-platform")
                put("residentKey", "required")
                put("requireResidentKey", true)
                put("userVerification", "preferred")
            }
        }.toString()
    }
}

/** The kinds of method a phone may learn exist (`stepUpMethodKinds`). */
enum class StepUpMethod(val wire: String) {
    SECURITY_KEY("security-key"), PASSKEY("passkey"), TOTP("totp");

    val isFido2: Boolean get() = this != TOTP

    companion object {
        fun of(s: String?): StepUpMethod? = entries.firstOrNull { it.wire == s }
    }
}

/**
 * The step-up refusals (`StepUpCode` and `quit-disabled`), and the plain
 * sentence each one shows (`STEP_UP_MESSAGES`, word for word).
 */
enum class StepUpCode(val wire: String, val message: String) {
    REQUIRED("step-up-required", "Confirm with your security key or a code to do this."),
    INVALID("step-up-invalid", "That key or code was not accepted. Try again."),
    STALE("step-up-stale", "That confirmation took too long. Try again."),
    REPLAYED("step-up-replayed", "That confirmation was already used. Try again."),
    QUIT_DISABLED("quit-disabled", "Quitting from a phone is turned off on the computer (Settings → Remote access).");

    /**
     * Whether the phone opens (or keeps open) the step-up sheet and asks
     * again with a fresh challenge. `quit-disabled` is a setting on the
     * computer, not a missing factor: no sheet can help.
     */
    val asksAgain: Boolean get() = this != QUIT_DISABLED

    companion object {
        fun of(s: String?): StepUpCode? = entries.firstOrNull { it.wire == s }
    }
}

/** What a guarded request carries beside `proof` (`StepUpProof` in step-up.ts). */
sealed class StepUpProof {
    abstract fun toJson(): JsonObject

    /** A FIDO2 assertion; every field unpadded base64url, as WebAuthn's JSON form gives it. */
    data class Assertion(
        val credentialId: String,
        val authenticatorData: String,
        val clientDataJSON: String,
        val signature: String,
    ) : StepUpProof() {
        override fun toJson(): JsonObject = buildJsonObject {
            put("credentialId", credentialId)
            put("authenticatorData", authenticatorData)
            put("clientDataJSON", clientDataJSON)
            put("signature", signature)
        }

        /** The challenge this assertion answers, read from its `clientDataJSON`; null when unreadable. */
        fun challenge(): String? = clientData()?.str("challenge")

        /** The origin the platform wrote (`android:apk-key-hash:...` for an app); null when unreadable. */
        fun origin(): String? = clientData()?.str("origin")

        private fun clientData(): JsonObject? = StepUp.fromB64url(clientDataJSON)?.let {
            runCatching { WireJson.parseToJsonElement(it.toString(Charsets.UTF_8)) }.getOrNull().obj()
        }

        override fun toString(): String = "Assertion(credentialId=$credentialId)"
    }

    /** Six digits from an authenticator app. */
    data class Totp(val code: String) : StepUpProof() {
        override fun toJson(): JsonObject = buildJsonObject { put("totp", code) }

        /** Never print the code. */
        override fun toString(): String = "Totp(******)"
    }

    companion object {
        /** The phone's own payloads read back (tests, logs); null for anything else. */
        fun from(e: JsonElement?): StepUpProof? {
            val o = e.obj() ?: return null
            if (o.containsKey("totp")) return o.str("totp")?.let(::Totp)
            return Assertion(
                o.str("credentialId") ?: return null,
                o.str("authenticatorData") ?: return null,
                o.str("clientDataJSON") ?: return null,
                o.str("signature") ?: return null,
            )
        }

        /**
         * Credential Manager's `PublicKeyCredential.authenticationResponseJson`
         * (WebAuthn's `AuthenticationResponseJSON`: `{ id, rawId, type,
         * response: { clientDataJSON, authenticatorData, signature, userHandle } }`)
         * as the payload the computer verifies. The bytes are passed through as
         * the authenticator produced them; only the encoding is normalised to
         * unpadded base64url. Null when a field is missing or not base64.
         */
        fun fromAuthenticationResponse(json: String): Assertion? {
            val o = runCatching { WireJson.parseToJsonElement(json) }.getOrNull().obj() ?: return null
            if (o.str("type") != null && o.str("type") != "public-key") return null
            val r = o["response"].obj() ?: return null
            fun field(s: String?): String? = s?.let(StepUp::fromB64url)?.let(StepUp::b64url)
            return Assertion(
                credentialId = field(o.str("rawId") ?: o.str("id")) ?: return null,
                authenticatorData = field(r.str("authenticatorData")) ?: return null,
                clientDataJSON = field(r.str("clientDataJSON")) ?: return null,
                signature = field(r.str("signature")) ?: return null,
            )
        }
    }
}

/**
 * What `security:challenge` answers (`StepUpChallengeReply`): a fresh
 * single-use challenge, when it expires, whether a guarded action needs a
 * step-up now, and the kinds of method registered.
 *
 * [rpId] is the computer's relying-party id (`nekko-computer:<installId>`),
 * which every FIDO2 API needs. Computers since the iPhone step-up change send
 * it; one from before does not, and then the phone cannot ask a key for an
 * assertion, so it offers the code only (see [offersKey]).
 *
 * [register] says the computer offers registering a method from the phone.
 * No computer sets it yet; it is read (a `true`, or an object describing the
 * offer) so a newer reply is understood, and nothing acts on it today.
 */
data class StepUpChallenge(
    val challenge: String,
    val expiresAt: Long,
    val required: Boolean,
    val methods: Set<StepUpMethod>,
    val rpId: String? = null,
    val register: Boolean = false,
) {
    /** A key or passkey is registered and the phone knows whom to ask for it. */
    val offersKey: Boolean get() = rpId != null && methods.any { it.isFido2 }

    /** A code is registered. */
    val offersCode: Boolean get() = StepUpMethod.TOTP in methods

    /** Step-up is on with nothing that can answer it (no method, or `security.json` unreadable on the computer). */
    val noWayToAnswer: Boolean get() = required && !offersKey && !offersCode

    /**
     * Too old to spend: fetch another before asking the key. [marginMs] keeps
     * a slow tap from landing just after the computer's two minutes.
     */
    fun isExpired(now: Long, marginMs: Long = 10_000): Boolean = now >= expiresAt - marginMs

    companion object {
        fun from(e: JsonElement?): StepUpChallenge? {
            val o = e.obj() ?: return null
            val challenge = o.str("challenge")?.takeIf { StepUp.fromB64url(it)?.isNotEmpty() == true } ?: return null
            val methods = (o["methods"] as? JsonArray).orEmpty()
                .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.let(StepUpMethod::of) }
                .toSet()
            return StepUpChallenge(
                challenge = challenge,
                expiresAt = o.long("expiresAt") ?: 0,
                required = o.bool("required"),
                methods = methods,
                rpId = o.str("rpId")?.takeIf { it.isNotBlank() },
                register = o.bool("register") || o["register"] is JsonObject,
            )
        }
    }
}

/**
 * A FIDO2 credential the phone just made (Credential Manager's
 * `registrationResponseJson`), in the shape `security.json` keeps
 * (`SecurityCredential`): its id, the 65-byte X9.63 P-256 point as base64,
 * the signature counter at creation, and the kind. [clientDataJSON] and
 * [attestationObject] go along so the computer can check the challenge and
 * origin itself before it stores anything.
 *
 * The phone cannot hand this to the computer yet: no phone channel registers
 * a method (the spec keeps `security:register*` desktop-only), so methods are
 * added on the computer. This is ready for the day the computer offers a
 * phone registration path (iPhone SK-6 names one, "when the computer allows it").
 */
data class StepUpRegistration(
    val credentialId: String,
    val publicKey: String,
    val counter: Long,
    val kind: StepUpMethod,
    val clientDataJSON: String,
    val attestationObject: String,
) {
    fun toJson(name: String, addedAt: Long): JsonObject = buildJsonObject {
        put("id", credentialId)
        put("publicKey", publicKey)
        put("counter", counter)
        put("name", name)
        put("kind", kind.wire)
        put("addedAt", addedAt)
        put("clientDataJSON", clientDataJSON)
        put("attestationObject", attestationObject)
    }

    companion object {
        /**
         * Read `{ id, rawId, type, authenticatorAttachment?, response: {
         * clientDataJSON, attestationObject } }`. The public key comes from the
         * attested credential data inside `attestationObject` (CBOR), never
         * from the optional `response.publicKey`, so the stored key is the one
         * the authenticator signed over. ES256 (P-256) only; null otherwise.
         * [asked] is the kind the request asked for, used when the platform
         * does not report the attachment.
         */
        fun fromRegistrationResponse(json: String, asked: StepUpMethod): StepUpRegistration? {
            val o = runCatching { WireJson.parseToJsonElement(json) }.getOrNull().obj() ?: return null
            val r = o["response"].obj() ?: return null
            val cdj = r.str("clientDataJSON")?.let(StepUp::fromB64url) ?: return null
            val att = r.str("attestationObject")?.let(StepUp::fromB64url) ?: return null
            val attMap = Cbor.decode(att) as? Map<*, *> ?: return null
            val authData = attMap["authData"] as? ByteArray ?: return null
            val parsed = AuthData.attested(authData) ?: return null
            val idField = (o.str("rawId") ?: o.str("id"))?.let(StepUp::fromB64url)
            // The JSON id and the attested one must be the same credential.
            if (idField != null && !idField.contentEquals(parsed.credentialId)) return null
            val kind = when (o.str("authenticatorAttachment")) {
                "platform" -> StepUpMethod.PASSKEY
                "cross-platform" -> StepUpMethod.SECURITY_KEY
                else -> asked
            }
            return StepUpRegistration(
                credentialId = StepUp.b64url(parsed.credentialId),
                publicKey = StepUp.b64(parsed.publicKey),
                counter = parsed.counter,
                kind = kind,
                clientDataJSON = StepUp.b64url(cdj),
                attestationObject = StepUp.b64url(att),
            )
        }
    }
}

/** The parts of WebAuthn `authenticatorData` the phone reads. */
internal object AuthData {
    class Attested(val counter: Long, val credentialId: ByteArray, val publicKey: ByteArray)

    private const val FLAG_AT = 0x40

    /** The attested credential (AT flag) with an ES256 P-256 key as an X9.63 point, or null. */
    fun attested(a: ByteArray): Attested? {
        if (a.size < 37 + 16 + 2) return null
        if (a[32].toInt() and FLAG_AT == 0) return null
        val counter = ((a[33].toLong() and 0xff) shl 24) or ((a[34].toLong() and 0xff) shl 16) or
            ((a[35].toLong() and 0xff) shl 8) or (a[36].toLong() and 0xff)
        var i = 37 + 16 // rpIdHash, flags, counter, aaguid
        val idLen = ((a[i].toInt() and 0xff) shl 8) or (a[i + 1].toInt() and 0xff)
        i += 2
        if (idLen == 0 || i + idLen > a.size) return null
        val id = a.copyOfRange(i, i + idLen)
        i += idLen
        val reader = Cbor.Reader(a, i)
        val key = runCatching { reader.read() }.getOrNull() as? Map<*, *> ?: return null
        // COSE_Key: kty 2 (EC2), alg -7 (ES256), crv 1 (P-256), x -2, y -3.
        if (key[1L] != 2L || key[3L] != StepUp.COSE_ES256 || key[-1L] != 1L) return null
        val x = key[-2L] as? ByteArray ?: return null
        val y = key[-3L] as? ByteArray ?: return null
        if (x.size != 32 || y.size != 32) return null
        return Attested(counter, id, byteArrayOf(4) + x + y)
    }
}

/**
 * Just enough CBOR (RFC 8949) for an attestation object and a COSE key:
 * unsigned and negative integers (as Long), byte and text strings, arrays,
 * maps, simple values and floats skipped as null. Definite lengths only, as
 * CTAP2 requires canonical CBOR.
 */
internal object Cbor {
    fun decode(bytes: ByteArray): Any? = runCatching { Reader(bytes, 0).read() }.getOrNull()

    class Reader(private val b: ByteArray, var pos: Int) {
        fun read(depth: Int = 0): Any? {
            require(depth < 16) { "too deep" }
            val head = byte()
            val major = head ushr 5
            val info = head and 0x1f
            return when (major) {
                0 -> length(info)
                1 -> -1 - length(info)
                2 -> bytes(length(info))
                3 -> bytes(length(info)).toString(Charsets.UTF_8)
                4 -> List(count(length(info))) { read(depth + 1) }
                5 -> {
                    val n = count(length(info))
                    val m = LinkedHashMap<Any?, Any?>(n)
                    repeat(n) { m[read(depth + 1)] = read(depth + 1) }
                    m
                }
                6 -> read(depth + 1) // a tag: its content
                else -> {
                    when (info) {
                        20 -> false
                        21 -> true
                        25 -> { skip(2); null }
                        26 -> { skip(4); null }
                        27 -> { skip(8); null }
                        else -> null
                    }
                }
            }
        }

        private fun byte(): Int {
            require(pos < b.size) { "truncated" }
            return b[pos++].toInt() and 0xff
        }

        private fun skip(n: Int) {
            require(pos + n <= b.size) { "truncated" }
            pos += n
        }

        private fun length(info: Int): Long = when {
            info < 24 -> info.toLong()
            info == 24 -> byte().toLong()
            info == 25 -> ((byte() shl 8) or byte()).toLong()
            info == 26 -> (0 until 4).fold(0L) { acc, _ -> (acc shl 8) or byte().toLong() }
            info == 27 -> (0 until 8).fold(0L) { acc, _ -> (acc shl 8) or byte().toLong() }.also { require(it >= 0) { "too long" } }
            else -> throw IllegalArgumentException("indefinite length")
        }

        private fun count(n: Long): Int {
            require(n in 0..(b.size - pos).toLong()) { "too long" }
            return n.toInt()
        }

        private fun bytes(n: Long): ByteArray {
            val len = count(n)
            return b.copyOfRange(pos, pos + len).also { pos += len }
        }
    }
}

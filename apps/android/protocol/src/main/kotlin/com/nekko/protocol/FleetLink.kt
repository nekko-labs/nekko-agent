package com.nekko.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Opening a chat on one of your own computers from an organization's list, with
 * no pairing (decision 0102, `crates/nekko-sync/src/fleet_link.rs`,
 * docs/SYNC-ENCRYPTION.md). Two values sealed under the *account* keyring in
 * `nekko-sync`'s record envelope with their own associated data:
 * the connect block a sharing computer puts in its fleet descriptor, and the
 * proof every fleet HELLO carries, which binds that one handshake.
 *
 * Only the sealing and checking live here. Nothing is persisted: the keyring
 * comes from an unlocked account and the caller drops it on sign-out or lock.
 */
class AccountKeyring(bytes: ByteArray) {
    private val enc: ByteArray
    init {
        require(bytes.size == 64) { "a keyring is 64 bytes" }
        enc = bytes.copyOfRange(0, 32)
    }

    internal fun encKey() = enc
}

object FleetLink {
    private const val VERSION = "nekko-sync/v1"
    private const val BLOB_VERSION: Byte = 1
    private const val SALT = 32
    private const val TAG = 16
    private const val MIN_PADDED = 256
    private const val MAX_ROUTES = 4
    private const val MAX_LEN = 64

    class Failure(message: String) : Exception(message)

    /** The id of a fleet link on the computer: no pairing can take it. */
    fun linkDeviceId(accountDeviceId: String) = "fleet:$accountDeviceId"

    /** Short codes a computer refuses a fleet HELLO with, and the sentence for each (the desktop's wording). */
    fun refusalText(code: String): String? = when (code) {
        "fleet-off" -> "Sharing is off on that computer."
        "fleet-locked" -> "That computer is signed out or locked."
        "fleet-epoch" -> "That computer doesn't have the newest key yet."
        "fleet-device" -> "That computer doesn't know this phone yet."
        "fleet-account" -> "That computer belongs to a different account."
        else -> null
    }

    /**
     * The sentence for a refusal of an account HELLO (decision 0126), where the phone may have no pairing to fall back on.
     * `invalid` is the computer's catch-all for a HELLO it could not check.
     */
    fun accountRefusalText(code: String): String? = when (code) {
        "fleet-off" -> "That computer has turned off connecting without pairing. Turn on \"Devices on my Nekko Cloud account connect without pairing\" there, or pair this phone."
        "fleet-locked" -> "That computer is signed out of Nekko Cloud or locked. Unlock it, then try again."
        "fleet-epoch" -> "That computer doesn't have the newest key yet. It will in a minute."
        "fleet-device" -> "That computer doesn't know this phone yet. It will after it next syncs."
        "fleet-account" -> "That computer belongs to a different Nekko Cloud account."
        "invalid" -> "That computer couldn't check this phone's account proof. Pair this phone instead."
        else -> null
    }

    /** The empty org id an account HELLO proof carries: account scope, not an organization's. */
    const val ACCOUNT_ORG = ""

    /** A `reach` record's plaintext (decision 0126), or null when it is not in shape. A tombstone is [Reach.deleted]. */
    fun parseReach(plain: ByteArray): Reach? = runCatching {
        val v = WireJson.parseToJsonElement(String(plain, Charsets.UTF_8)).jsonObject
        if (v["v"]?.jsonPrimitive?.intOrNull != 1) return null
        fun graphic(s: String?, max: Int) = s?.takeIf { it.isNotEmpty() && it.length <= max && it.all { c -> c.code in 0x21..0x7e } }
        val id = graphic(v["deviceId"]?.jsonPrimitive?.contentOrNull, MAX_LEN) ?: return null
        if (v["deleted"]?.jsonPrimitive?.contentOrNull == "true") return Reach(id, "", emptyList(), "", "", "", deleted = true)
        val routes = v["routes"]!!.jsonArray.mapNotNull { graphic(it.jsonPrimitive.contentOrNull, 200) }
            .filter { it.startsWith("ws://") || it.startsWith("wss://") }.take(MAX_ROUTES)
        if (routes.isEmpty()) return null
        Reach(
            id,
            v["name"]?.jsonPrimitive?.contentOrNull?.filter { !it.isISOControl() }?.take(80)?.ifBlank { null } ?: "Computer",
            routes,
            graphic(v["room"]?.jsonPrimitive?.contentOrNull, 64) ?: return null,
            graphic(v["secret"]?.jsonPrimitive?.contentOrNull, 128) ?: return null,
            graphic(v["hostKey"]?.jsonPrimitive?.contentOrNull, 200) ?: return null,
        )
    }.getOrNull()

    /** Whether one more try can help: the computer reads the account again after these two. */
    fun retryable(code: String) = code == "fleet-device" || code == "fleet-epoch"

    fun connectAad(accountId: String, keyId: Int, orgId: String, deviceId: String, revision: Long): String {
        check(listOf(accountId, orgId, deviceId), keyId, revision)
        return "$VERSION fleet-connect\n$accountId\n$keyId\n$orgId\n$deviceId\n$revision"
    }

    fun helloAad(accountId: String, keyId: Int, deviceId: String): String {
        check(listOf(accountId, deviceId), keyId, 1)
        return "$VERSION fleet-hello\n$accountId\n$keyId\n$deviceId"
    }

    /** A server-issued id may not carry a separator or newline into associated data. */
    private fun check(ids: List<String>, keyId: Int, revision: Long) {
        val ok = ids.all { it.isNotEmpty() && it.length <= MAX_LEN && it.all { c -> c.isLetterOrDigit() && c.code < 128 || c == '-' || c == '_' } }
        if (!ok || keyId <= 0 || revision <= 0) throw Failure("invalid")
    }

    /** The connect block's plaintext, refused unless it is for [orgId] and in shape. */
    fun parseConnect(plain: ByteArray, orgId: String): ConnectInfo? = runCatching {
        val v = WireJson.parseToJsonElement(String(plain, Charsets.UTF_8)).jsonObject
        if (v["v"]?.jsonPrimitive?.intOrNull != 1 || v["orgId"]?.jsonPrimitive?.contentOrNull != orgId) return null
        fun graphic(s: String?, max: Int) = s?.takeIf { it.isNotEmpty() && it.length <= max && it.all { c -> c.code in 0x21..0x7e } }
        val routes = v["routes"]!!.jsonArray.mapNotNull { graphic(it.jsonPrimitive.contentOrNull, 200) }
            .filter { it.startsWith("ws://") || it.startsWith("wss://") }.take(MAX_ROUTES)
        ConnectInfo(
            routes,
            graphic(v["room"]?.jsonPrimitive?.contentOrNull, 64) ?: return null,
            graphic(v["secret"]?.jsonPrimitive?.contentOrNull, 128) ?: return null,
            graphic(v["hostKey"]?.jsonPrimitive?.contentOrNull, 200) ?: return null,
        ).takeIf { routes.isNotEmpty() }
    }.getOrNull()

    /** Open a connect block; it fails unless account, epoch, org, device and revision are the ones it was sealed for. */
    fun openConnect(ring: AccountKeyring, accountId: String, keyId: Int, orgId: String, deviceId: String, revision: Long, blob: String): ByteArray =
        open(ring, connectAad(accountId, keyId, orgId, deviceId, revision), blob)

    fun sealConnect(ring: AccountKeyring, accountId: String, keyId: Int, orgId: String, deviceId: String, revision: Long, plain: ByteArray, salt: ByteArray = randomSalt()): String =
        seal(ring, connectAad(accountId, keyId, orgId, deviceId, revision), plain, salt)

    fun openHelloProof(ring: AccountKeyring, accountId: String, keyId: Int, deviceId: String, blob: String): ByteArray =
        open(ring, helloAad(accountId, keyId, deviceId), blob)

    /**
     * The HELLO's `fleet` object for one handshake: who this device is and a proof,
     * sealed under the account's *current* keyring, that binds the org, room,
     * challenge, both halves of the key exchange and the HELLO key.
     */
    fun hello(ring: AccountKeyring, accountId: String, keyId: Int, deviceId: String, orgId: String, b: FleetBinding): JsonObject {
        val plain = buildJsonObject {
            put("v", 1); put("orgId", orgId); put("room", b.room); put("challenge", b.challenge)
            put("hostEph", b.hostEph); put("clientEph", b.clientEph); put("helloKey", b.helloKey)
        }.toString().toByteArray(Charsets.UTF_8)
        val proof = seal(ring, helloAad(accountId, keyId, deviceId), plain, randomSalt())
        return buildJsonObject {
            put("v", 1); put("accountId", accountId); put("keyId", keyId); put("deviceId", deviceId); put("proof", JsonPrimitive(proof))
        }
    }

    private fun randomSalt() = ByteArray(SALT).also { SecureRandom().nextBytes(it) }

    private fun keyAndNonce(enc: ByteArray, salt: ByteArray): Pair<ByteArray, ByteArray> {
        val okm = SealedBox.hkdf(enc, salt, "$VERSION record".toByteArray(), 44)
        return okm.copyOfRange(0, 32) to okm.copyOfRange(32, 44)
    }

    internal fun seal(ring: AccountKeyring, aad: String, plain: ByteArray, salt: ByteArray): String {
        val (key, nonce) = keyAndNonce(ring.encKey(), salt)
        val framed = frame(plain)
        val ct = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG * 8, nonce))
            updateAAD(aad.toByteArray())
            doFinal(framed)
        }
        return SealedBox.base64url(byteArrayOf(BLOB_VERSION) + salt + ct)
    }

    internal fun open(ring: AccountKeyring, aad: String, blob: String): ByteArray {
        val raw = runCatching { SealedBox.fromBase64url(blob) }.getOrElse { throw Failure("malformed") }
        if (raw.size < 1 + SALT + TAG || raw[0] != BLOB_VERSION) throw Failure("malformed")
        val (key, nonce) = keyAndNonce(ring.encKey(), raw.copyOfRange(1, 1 + SALT))
        val framed = try {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG * 8, nonce))
                updateAAD(aad.toByteArray())
                doFinal(raw, 1 + SALT, raw.size - 1 - SALT)
            }
        } catch (_: Exception) {
            throw Failure("unauthentic")
        }
        if (framed.size < 4) throw Failure("malformed")
        val len = ((framed[0].toLong() and 0xff) shl 24) or ((framed[1].toLong() and 0xff) shl 16) or
            ((framed[2].toLong() and 0xff) shl 8) or (framed[3].toLong() and 0xff)
        if (4 + len > framed.size) throw Failure("malformed")
        return framed.copyOfRange(4, 4 + len.toInt())
    }

    /** The PADMÉ length: a long plaintext hides at most ~12% of its size (`pad.rs`). */
    fun padme(len: Int): Int {
        if (len < 2) return len
        val e = 31 - Integer.numberOfLeadingZeros(len)
        val s = 32 - Integer.numberOfLeadingZeros(e)
        val mask = (1 shl (e - s)) - 1
        return (len + mask) and mask.inv()
    }

    private fun frame(plain: ByteArray): ByteArray {
        val out = ByteArray(padme(maxOf(plain.size + 4, MIN_PADDED)))
        out[0] = (plain.size ushr 24).toByte(); out[1] = (plain.size ushr 16).toByte()
        out[2] = (plain.size ushr 8).toByte(); out[3] = plain.size.toByte()
        System.arraycopy(plain, 0, out, 4, plain.size)
        return out
    }
}

/** How to reach a computer's relay agent. Holds the room secret: its `toString` says nothing. */
class ConnectInfo(val routes: List<String>, val room: String, val secret: String, val hostKey: String) {
    override fun toString() = "ConnectInfo($routes, ..)"
}

/** What a fleet HELLO proof binds: this one handshake, as both ends hold it. */
class FleetBinding(val room: String, val challenge: String, val hostEph: String, val clientEph: String, val helloKey: String)

/**
 * A computer of this account, as it published itself in a `reach` record (decision 0126): how to dial it with no pairing.
 * [deviceId] is the computer's account device id. Holds the room secret, so its `toString` says nothing.
 */
data class Reach(
    val deviceId: String,
    val name: String,
    val routes: List<String>,
    val room: String,
    val secret: String,
    val hostKey: String,
    val deleted: Boolean = false,
) {
    override fun toString() = "Reach($deviceId, $name, $routes, ..)"
}

/**
 * What the account HELLO needs of a signed-in, unlocked phone: the current keyring and this phone's ids.
 * Held only in memory by the caller; [hello] is what [RelayConfig.fleetHello] runs per handshake.
 */
class AccountIdentity(private val ring: AccountKeyring, val accountId: String, val keyId: Int, val deviceId: String) {
    /** The HELLO `deviceId` for a computer this phone has no pairing with. */
    val linkDeviceId: String get() = FleetLink.linkDeviceId(deviceId)

    /** The HELLO's `fleet` object for one handshake, at account scope (empty org id). */
    fun hello(b: FleetBinding): JsonObject = FleetLink.hello(ring, accountId, keyId, deviceId, FleetLink.ACCOUNT_ORG, b)

    override fun toString() = "AccountIdentity($deviceId)"
}

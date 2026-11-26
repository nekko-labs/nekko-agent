package com.nekko.protocol

import java.math.BigInteger
import java.security.KeyPair
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * A device's sync agreement key (#2835): a software key here and below Android 12, an Android
 * Keystore key from API 31 (the app module's implementation). Only ECDH is asked of it, so a
 * Keystore key never has to leave the secure hardware.
 */
interface SyncAgreementKey {
    /** `04 ‖ x ‖ y`, 65 bytes. */
    val publicKeyX963: ByteArray

    /** The raw ECDH secret with [peer]: the shared point's x coordinate, 32 bytes. */
    fun sharedSecret(peer: ECPublicKey): ByteArray
}

/**
 * End-to-end encrypted sync with Nekko Cloud, byte for byte as `crates/nekko-sync` makes it and the
 * iPhone's `SyncCrypto` (#2835). All three are held to `crates/nekko-sync/tests/golden/sync-crypto.json`.
 * The design is `docs/SYNC-ENCRYPTION.md`; in short:
 *
 * - a **keyring** (record key ‖ object id key, 64 bytes) per key epoch, in plaintext only on the user's devices;
 * - **records** sealed with AES-256-GCM under a key and nonce derived from a fresh 32-byte salt, with the
 *   account, epoch, collection, object id and revision bound as associated data, and the plaintext Padmé-padded;
 * - the keyring **wrapped** to each device's P-256 key (ECIES), authenticated by the sending device's key,
 *   and to the public half of a P-256 key derived from a 256-bit **recovery key** the user keeps;
 * - a one-time **join code** for approving a new device, which checks the new device's key on the approver
 *   and the approver on the new device;
 * - opt-in **donations** sealed to Nekko Labs' offline research key.
 */
object SyncCrypto {
    const val VERSION = "nekko-sync/v1"
    const val DONATION_VERSION = "nekko-donation/v1"
    const val OBJECT_ID_LENGTH = 43
    const val PUBLIC_KEY_LENGTH = 65
    const val MIN_PADDED = 256
    private const val BLOB_VERSION: Byte = 1
    private const val SALT_BYTES = 32
    private const val TAG_BYTES = 16
    private val random = SecureRandom()

    /** Why a blob, id or key was refused. */
    class Failure(val reason: Reason) : Exception(reason.name.lowercase()) {
        enum class Reason {
            /** Too short, an unknown version byte, or not base64url. */
            MALFORMED,
            /** The tag did not verify: wrong key, wrong context, or tampered. */
            UNAUTHENTIC,
            /** A collection, id or key outside what the format allows. */
            INVALID,
            /** A recovery key whose checksum doesn't match (a typo). */
            CHECKSUM,
        }
    }

    private fun fail(r: Failure.Reason): Nothing = throw Failure(r)

    // ---- Keyring ----

    /** The account's secret for one key epoch. Its `toString` says nothing. */
    class Keyring(bytes: ByteArray) {
        internal val enc: ByteArray
        internal val id: ByteArray

        init {
            if (bytes.size != 64) fail(Failure.Reason.MALFORMED)
            enc = bytes.copyOfRange(0, 32)
            id = bytes.copyOfRange(32, 64)
        }

        /** `enc ‖ id`, for wrapping and the secure store. */
        val bytes: ByteArray get() = enc + id

        /** The next epoch's keyring: a new record key, the same id key. */
        fun rotated(): Keyring = Keyring(randomBytes(32) + id)

        override fun equals(other: Any?) = other is Keyring && MessageDigest.isEqual(bytes, other.bytes)
        override fun hashCode() = bytes.contentHashCode()
        override fun toString() = "Keyring(..)"

        companion object {
            /** The first keyring of an account. */
            fun generate(): Keyring = Keyring(randomBytes(64))
        }
    }

    // ---- Epoch proof ----

    const val EPOCH_PROOF_LABEL = "nekko-sync-epoch-proof/v1"

    /**
     * Proof that this device holds an epoch's keyring, shown to Nekko Cloud before it lets a sign-in change
     * keys, devices or data: HKDF-SHA256(keyring, empty salt, info = label + "\n" + keyId), 32 bytes.
     * One-way: the server keeps only its SHA-256 and can derive no key from it.
     */
    fun epochProof(keyring: Keyring, keyId: Long): ByteArray = derive32(keyring.bytes, "$EPOCH_PROOF_LABEL\n$keyId")

    // ---- Records ----

    internal fun validCollection(c: String): Boolean {
        val b = c.toByteArray(Charsets.UTF_8)
        if (b.isEmpty() || b.size > 32 || b[0] !in 0x61..0x7a) return false
        return b.all { it in 0x61..0x7a || it in 0x30..0x39 || it == 0x2d.toByte() }
    }

    internal fun validObjectId(id: String): Boolean =
        id.length == OBJECT_ID_LENGTH && id.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }

    /** The opaque id the server files a record under. */
    fun objectId(keyring: Keyring, collection: String, localId: String): String {
        if (!validCollection(collection) || localId.isEmpty()) fail(Failure.Reason.INVALID)
        return base64url(hmac(keyring.id, "$VERSION object\n$collection\n$localId".toByteArray(Charsets.UTF_8)))
    }

    fun recordAad(account: String, keyId: Long, collection: String, objectId: String, revision: Long): String =
        "$VERSION record\n$account\n$keyId\n$collection\n$objectId\n$revision"

    /** Seal one revision of a record. [salt] is injectable for the shared vectors only. */
    fun sealRecord(
        keyring: Keyring, account: String, keyId: Long, collection: String, objectId: String, revision: Long,
        plaintext: ByteArray, salt: ByteArray = randomBytes(SALT_BYTES),
    ): String {
        if (!validCollection(collection) || !validObjectId(objectId) || revision <= 0 || salt.size != SALT_BYTES) fail(Failure.Reason.INVALID)
        val aad = recordAad(account, keyId, collection, objectId, revision).toByteArray(Charsets.UTF_8)
        val (key, nonce) = keyAndNonce(keyring.enc, salt, "$VERSION record".toByteArray(Charsets.UTF_8))
        return base64url(byteArrayOf(BLOB_VERSION) + salt + gcmSeal(key, nonce, aad, frame(plaintext)))
    }

    /** Open a record; throws unless every field matches what it was sealed with. */
    fun openRecord(keyring: Keyring, account: String, keyId: Long, collection: String, objectId: String, revision: Long, blob: String): ByteArray {
        if (!validCollection(collection) || !validObjectId(objectId) || revision <= 0) fail(Failure.Reason.INVALID)
        val raw = fromBase64url(blob)
        if (raw.size < 1 + SALT_BYTES + TAG_BYTES || raw[0] != BLOB_VERSION) fail(Failure.Reason.MALFORMED)
        val aad = recordAad(account, keyId, collection, objectId, revision).toByteArray(Charsets.UTF_8)
        val (key, nonce) = keyAndNonce(keyring.enc, raw.copyOfRange(1, 1 + SALT_BYTES), "$VERSION record".toByteArray(Charsets.UTF_8))
        return unframe(gcmOpen(key, nonce, aad, raw.copyOfRange(1 + SALT_BYTES, raw.size)))
    }

    // ---- Padding ----

    /** The Padmé size for a length (leaks O(log log n) bits, at most ~12% overhead). */
    fun padme(len: Int): Int {
        if (len < 2) return len
        val e = 31 - Integer.numberOfLeadingZeros(len)
        val s = 32 - Integer.numberOfLeadingZeros(e)
        val mask = (1 shl (e - s)) - 1
        return (len + mask) and mask.inv()
    }

    /** A 4-byte big-endian length, the bytes, zeros to the Padmé size (at least 256). */
    fun frame(plaintext: ByteArray): ByteArray {
        val out = ByteArray(padme(maxOf(plaintext.size + 4, MIN_PADDED)))
        val n = plaintext.size
        out[0] = (n ushr 24).toByte(); out[1] = (n ushr 16).toByte(); out[2] = (n ushr 8).toByte(); out[3] = n.toByte()
        System.arraycopy(plaintext, 0, out, 4, n)
        return out
    }

    fun unframe(framed: ByteArray): ByteArray {
        if (framed.size < 4) fail(Failure.Reason.MALFORMED)
        val len = ((framed[0].toLong() and 0xff) shl 24) or ((framed[1].toLong() and 0xff) shl 16) or
            ((framed[2].toLong() and 0xff) shl 8) or (framed[3].toLong() and 0xff)
        if (4 + len > framed.size) fail(Failure.Reason.MALFORMED)
        return framed.copyOfRange(4, 4 + len.toInt())
    }

    // ---- Device keys and wrapping ----

    /** A P-256 agreement key held in memory: tests, the recovery key, and devices without Keystore ECDH. */
    class SoftwareKey(private val private: ECPrivateKey, override val publicKeyX963: ByteArray) : SyncAgreementKey {
        override fun sharedSecret(peer: ECPublicKey): ByteArray = SealedBox.agree(private, peer)

        /** The 32-byte scalar, to seal in the secure store. Never logged. */
        val rawRepresentation: ByteArray get() = fixed32(private.s)

        override fun toString() = "SoftwareKey(..)"

        companion object {
            fun generate(): SoftwareKey = of(SealedBox.newKeyPair())

            fun of(pair: KeyPair): SoftwareKey = SoftwareKey(pair.private as ECPrivateKey, P256.x963(pair.public as ECPublicKey))

            /** From a 32-byte scalar; throws [Failure] when it isn't a valid P-256 private key. */
            fun fromRaw(scalar: ByteArray): SoftwareKey {
                if (scalar.size != 32) fail(Failure.Reason.INVALID)
                val d = BigInteger(1, scalar)
                if (d.signum() == 0 || d >= P256.params.order) fail(Failure.Reason.INVALID)
                val w = multiplyG(d)
                val pub = java.security.KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(w, P256.params)) as ECPublicKey
                return SoftwareKey(SealedBox.privateKey(scalar), P256.x963(pub))
            }
        }
    }

    internal fun parsePublic(bytes: ByteArray): ECPublicKey {
        if (bytes.size != PUBLIC_KEY_LENGTH || bytes[0] != 4.toByte()) fail(Failure.Reason.INVALID)
        return runCatching { P256.publicKey(bytes) }.getOrElse { fail(Failure.Reason.INVALID) }
    }

    /** A short code to compare on two screens before trusting a device key: `XXXX-XXXX-XXXX-XXXX`. */
    fun fingerprint(publicKey: ByteArray): String = groups(crockford(sha256(publicKey).copyOfRange(0, 10)), 4)

    /** ECIES to a P-256 public key. [ephemeral] is injectable for the shared vectors only. */
    fun seal(to: ByteArray, context: String, plaintext: ByteArray, ephemeral: SoftwareKey = SoftwareKey.generate()): String =
        seal(to, context, plaintext, ephemeral, ByteArray(0), ByteArray(0))

    /**
     * ECIES with extra key material: [extraIkm] follows the ephemeral ECDH secret and [extraSalt] the salt
     * (an authenticated wrap passes the sender's static secret and public key; a join wrap the join code's key).
     */
    private fun seal(to: ByteArray, context: String, plaintext: ByteArray, ephemeral: SoftwareKey, extraIkm: ByteArray, extraSalt: ByteArray): String {
        val peer = parsePublic(to)
        val ephPub = ephemeral.publicKeyX963
        val secret = ephemeral.sharedSecret(peer)
        val ctx = context.toByteArray(Charsets.UTF_8)
        val (key, nonce) = keyAndNonce(secret + extraIkm, ephPub + to + extraSalt, ctx)
        secret.fill(0)
        return base64url(byteArrayOf(BLOB_VERSION) + ephPub + gcmSeal(key, nonce, ctx, plaintext))
    }

    fun openSealed(key: SyncAgreementKey, context: String, blob: String): ByteArray = openSealed(key, context, blob, ByteArray(0), ByteArray(0))

    private fun openSealed(key: SyncAgreementKey, context: String, blob: String, extraIkm: ByteArray, extraSalt: ByteArray): ByteArray {
        val raw = fromBase64url(blob)
        if (raw.size < 1 + PUBLIC_KEY_LENGTH + TAG_BYTES || raw[0] != BLOB_VERSION) fail(Failure.Reason.MALFORMED)
        val ephPub = raw.copyOfRange(1, 1 + PUBLIC_KEY_LENGTH)
        val peer = runCatching { parsePublic(ephPub) }.getOrElse { fail(Failure.Reason.MALFORMED) }
        val secret = key.sharedSecret(peer)
        val ctx = context.toByteArray(Charsets.UTF_8)
        val (k, nonce) = keyAndNonce(secret + extraIkm, ephPub + key.publicKeyX963 + extraSalt, ctx)
        secret.fill(0)
        return gcmOpen(k, nonce, ctx, raw.copyOfRange(1 + PUBLIC_KEY_LENGTH, raw.size))
    }

    internal fun wrapContext(account: String, keyId: Long, recipientId: String, senderId: String) =
        "$VERSION wrap\n$account\n$keyId\n$recipientId\n$senderId"

    /**
     * Wrap a keyring to a device, authenticated by the sending device's own key (a static-static ECDH secret
     * in the derivation): only the holder of [sender] could have made it, so a device takes keyrings only from
     * devices it already trusts.
     */
    fun wrapKeyring(
        keyring: Keyring, account: String, keyId: Long, recipientId: String, recipientPublic: ByteArray,
        senderId: String, sender: SyncAgreementKey, ephemeral: SoftwareKey = SoftwareKey.generate(),
    ): String {
        val staticSecret = sender.sharedSecret(parsePublic(recipientPublic))
        return seal(recipientPublic, wrapContext(account, keyId, recipientId, senderId), keyring.bytes, ephemeral, staticSecret, sender.publicKeyX963)
            .also { staticSecret.fill(0) }
    }

    /** Open a wrap made by [senderId], whose public key comes from this device's own trusted list. */
    fun unwrapKeyring(key: SyncAgreementKey, account: String, keyId: Long, deviceId: String, senderId: String, senderPublic: ByteArray, wrap: String): Keyring {
        val staticSecret = key.sharedSecret(parsePublic(senderPublic))
        return try {
            Keyring(openSealed(key, wrapContext(account, keyId, deviceId, senderId), wrap, staticSecret, senderPublic))
        } finally {
            staticSecret.fill(0)
        }
    }

    // ---- Join codes ----

    /**
     * The one-time code a device asking to join shows, typed on a device that already syncs. Its tag (published
     * with the new device's key) lets the approver check that key; the keyring is wrapped with a key derived
     * from it, so the new device knows the wrap came from someone shown the code.
     */
    class JoinCode(bytes: ByteArray) {
        internal val bytes: ByteArray = bytes.copyOf()

        init {
            if (bytes.size != 10) fail(Failure.Reason.INVALID)
        }

        /** `XXXX-XXXX-XXXX-XXXX`. */
        val text: String get() = groups(crockford(bytes), 4)

        /** The tag the new device publishes with its key. */
        fun tag(account: String, publicKey: ByteArray): ByteArray =
            hmac(derive32(bytes, "$VERSION join-tag"), "$account\n".toByteArray(Charsets.UTF_8) + publicKey)

        /** Does [tag] bind this code to that key? Constant time. */
        fun verifies(account: String, publicKey: ByteArray, tag: ByteArray): Boolean = MessageDigest.isEqual(tag(account, publicKey), tag)

        internal fun psk(account: String, deviceId: String): ByteArray = derive32(bytes, "$VERSION join-psk\n$account\n$deviceId")

        override fun equals(other: Any?) = other is JoinCode && MessageDigest.isEqual(bytes, other.bytes)
        override fun hashCode() = bytes.contentHashCode()
        override fun toString() = "JoinCode(..)"

        companion object {
            const val TEXT_LENGTH = 16

            fun generate(): JoinCode = JoinCode(randomBytes(10))

            /** What the user typed (as leniently as a recovery key; no checksum, a typo fails the tag). */
            fun parse(text: String): JoinCode = JoinCode(decodeCrockford(text, TEXT_LENGTH))
        }
    }

    internal fun joinContext(account: String, keyId: Long, deviceId: String) = "$VERSION join-wrap\n$account\n$keyId\n$deviceId"

    /** On the approving device: wrap the current keyring to the new device, keyed by the code the user typed. */
    fun wrapForJoin(
        keyring: Keyring, account: String, keyId: Long, recipientId: String, recipientPublic: ByteArray, code: JoinCode,
        ephemeral: SoftwareKey = SoftwareKey.generate(),
    ): String = seal(recipientPublic, joinContext(account, keyId, recipientId), keyring.bytes, ephemeral, code.psk(account, recipientId), ByteArray(0))

    /** On the new device: open the wrap made with its own code. */
    fun unwrapJoin(key: SyncAgreementKey, account: String, keyId: Long, deviceId: String, code: JoinCode, wrap: String): Keyring =
        Keyring(openSealed(key, joinContext(account, keyId, deviceId), wrap, code.psk(account, deviceId), ByteArray(0)))

    // ---- Recovery key ----

    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    const val RECOVERY_TEXT_LENGTH = 55

    /** 256 random bits the user keeps; the only way back in if every device is lost. */
    class RecoveryKey(bytes: ByteArray) {
        internal val bytes: ByteArray = bytes.copyOf()

        init {
            if (bytes.size != 32) fail(Failure.Reason.INVALID)
        }

        /** Eleven groups of five Crockford base32 characters (the key and a 2-byte checksum). */
        val text: String get() = groups(crockford(bytes + sha256(bytes).copyOfRange(0, 2)), 5)

        override fun equals(other: Any?) = other is RecoveryKey && MessageDigest.isEqual(bytes, other.bytes)
        override fun hashCode() = bytes.contentHashCode()
        override fun toString() = "RecoveryKey(..)"

        companion object {
            fun generate(): RecoveryKey = RecoveryKey(randomBytes(32))

            /** What the user typed: any case, dashes and spaces ignored, O read as 0, I and L as 1. */
            fun parse(text: String): RecoveryKey {
                val raw = decodeCrockford(text, RECOVERY_TEXT_LENGTH)
                if (raw.size != 34) fail(Failure.Reason.MALFORMED)
                val key = raw.copyOfRange(0, 32)
                if (!MessageDigest.isEqual(sha256(key).copyOfRange(0, 2), raw.copyOfRange(32, 34))) fail(Failure.Reason.CHECKSUM)
                return RecoveryKey(key)
            }
        }
    }

    internal fun recoveryContext(account: String, keyId: Long) = "$VERSION recovery\n$account\n$keyId"

    /**
     * The recovery key's P-256 key pair: the first valid scalar among
     * HKDF-SHA256(recovery key, info = "nekko-sync/v1 recovery-key" ‖ counter). Devices keep only its public
     * half, so a new key epoch can be sealed for recovery without any device holding the recovery secret.
     */
    fun recoveryAgreementKey(recovery: RecoveryKey): SoftwareKey {
        for (counter in 0..255) {
            val d = SealedBox.hkdf(recovery.bytes, ByteArray(0), "$VERSION recovery-key".toByteArray(Charsets.UTF_8) + byteArrayOf(counter.toByte()), 32)
            val key = runCatching { SoftwareKey.fromRaw(d) }.getOrNull()
            d.fill(0)
            if (key != null) return key
        }
        error("256 HKDF outputs are all outside the P-256 scalar range")
    }

    /** Seal a key epoch's keyring to the recovery key's public half (ECIES, like a device wrap). */
    fun sealRecovery(recoveryPublic: ByteArray, keyring: Keyring, account: String, keyId: Long, ephemeral: SoftwareKey = SoftwareKey.generate()): String =
        seal(recoveryPublic, recoveryContext(account, keyId), keyring.bytes, ephemeral)

    fun openRecovery(recovery: RecoveryKey, account: String, keyId: Long, blob: String): Keyring =
        Keyring(openSealed(recoveryAgreementKey(recovery), recoveryContext(account, keyId), blob))

    // ---- Donations ----

    /** [deleteToken] stays on the device: the only way to withdraw this donation. */
    data class Donation(val id: String, val blob: String, val deleteToken: String, val deleteHash: String)

    /** Seal an already-redacted sample to the research key. Opt-in only. */
    fun sealDonation(
        researchPublic: ByteArray, payload: ByteArray, id: ByteArray = randomBytes(16), deleteToken: ByteArray = randomBytes(32),
        ephemeral: SoftwareKey = SoftwareKey.generate(),
    ): Donation {
        val name = base64url(id)
        val blob = seal(researchPublic, "$DONATION_VERSION\n$name", frame(payload), ephemeral)
        return Donation(name, blob, base64url(deleteToken), base64url(sha256(deleteToken)))
    }

    /** The S256 challenge for a PKCE verifier (OAuth sign-in in the browser). */
    fun pkceChallenge(verifier: String): String = base64url(sha256(verifier.toByteArray(Charsets.UTF_8)))

    // ---- Crockford base32 ----

    internal fun crockford(bytes: ByteArray): String {
        val out = StringBuilder()
        var acc = 0
        var bits = 0
        for (b in bytes) {
            acc = (acc shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                out.append(ALPHABET[(acc ushr bits) and 31])
            }
            acc = acc and 0xff
        }
        if (bits > 0) out.append(ALPHABET[(acc shl (5 - bits)) and 31])
        return out.toString()
    }

    internal fun groups(text: String, n: Int): String = text.chunked(n).joinToString("-")

    /**
     * Exactly [chars] Crockford base32 characters back to bytes: any case, dashes and ASCII spaces ignored,
     * O read as 0, I and L as 1. ASCII only, so the phone reads text exactly as the computer does. The bits
     * after the last whole byte must be zero.
     */
    internal fun decodeCrockford(text: String, chars: Int): ByteArray {
        val raw = java.io.ByteArrayOutputStream()
        var acc = 0
        var bits = 0
        var n = 0
        for (ch in text) {
            if (ch == '-' || ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') continue
            if (ch.code >= 0x80) fail(Failure.Reason.MALFORMED)
            var c = if (ch in 'a'..'z') ch - 0x20 else ch
            if (c == 'O') c = '0' else if (c == 'I' || c == 'L') c = '1'
            val v = ALPHABET.indexOf(c)
            if (v < 0) fail(Failure.Reason.MALFORMED)
            n++
            if (n > chars) fail(Failure.Reason.MALFORMED)
            acc = ((acc shl 5) or v) and 0xFFFF
            bits += 5
            if (bits >= 8) {
                bits -= 8
                raw.write((acc ushr bits) and 0xFF)
            }
        }
        if (n != chars || acc and ((1 shl bits) - 1) != 0) fail(Failure.Reason.MALFORMED)
        return raw.toByteArray()
    }

    // ---- Primitives ----

    fun base64url(b: ByteArray): String = SealedBox.base64url(b)

    /** Strict base64url without padding, as the computer and the iPhone write it. */
    fun fromBase64url(s: String): ByteArray {
        if (!s.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }) fail(Failure.Reason.MALFORMED)
        return runCatching { java.util.Base64.getUrlDecoder().decode(s) }.getOrElse { fail(Failure.Reason.MALFORMED) }
    }

    internal fun randomBytes(n: Int) = ByteArray(n).also { random.nextBytes(it) }

    internal fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(data)
    }

    /** HKDF-SHA256 with an empty salt, 32 bytes. */
    internal fun derive32(ikm: ByteArray, info: String): ByteArray = SealedBox.hkdf(ikm, ByteArray(0), info.toByteArray(Charsets.UTF_8), 32)

    private fun keyAndNonce(ikm: ByteArray, salt: ByteArray, info: ByteArray): Pair<ByteArray, ByteArray> {
        val okm = SealedBox.hkdf(ikm, salt, info, 44)
        return okm.copyOfRange(0, 32) to okm.copyOfRange(32, 44).also { okm.fill(0) }
    }

    private fun gcmSeal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray = try {
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
            updateAAD(aad)
            doFinal(plaintext)
        }
    } finally {
        key.fill(0)
    }

    private fun gcmOpen(key: ByteArray, nonce: ByteArray, aad: ByteArray, sealed: ByteArray): ByteArray {
        if (sealed.size < TAG_BYTES) fail(Failure.Reason.MALFORMED)
        return try {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
                updateAAD(aad)
                doFinal(sealed)
            }
        } catch (_: Exception) {
            fail(Failure.Reason.UNAUTHENTIC)
        } finally {
            key.fill(0)
        }
    }

    private fun fixed32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    // The public point of a scalar (d·G). JCA can't derive a public key from a private one, so this is the
    // textbook double-and-add on P-256 in affine coordinates; it runs only on a recovery key or a stored key,
    // never on a secret an attacker can time remotely.
    private fun multiplyG(d: BigInteger): ECPoint {
        val curve = P256.params.curve
        val p = (curve.field as java.security.spec.ECFieldFp).p
        val a = curve.a
        fun add(x: ECPoint, y: ECPoint): ECPoint {
            if (x == ECPoint.POINT_INFINITY) return y
            if (y == ECPoint.POINT_INFINITY) return x
            val (x1, y1) = x.affineX to x.affineY
            val (x2, y2) = y.affineX to y.affineY
            val l = if (x1 == x2) {
                if ((y1 + y2).mod(p).signum() == 0) return ECPoint.POINT_INFINITY
                (x1.pow(2).multiply(BigInteger.valueOf(3)) + a).multiply(y1.shiftLeft(1).modInverse(p)).mod(p)
            } else {
                (y2 - y1).multiply((x2 - x1).modInverse(p)).mod(p)
            }
            val x3 = (l.pow(2) - x1 - x2).mod(p)
            return ECPoint(x3, (l.multiply(x1 - x3) - y1).mod(p))
        }
        var result = ECPoint.POINT_INFINITY
        var addend = P256.params.generator
        for (i in 0 until d.bitLength()) {
            if (d.testBit(i)) result = add(result, addend)
            addend = add(addend, addend)
        }
        return result
    }
}

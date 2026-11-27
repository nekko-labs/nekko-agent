package com.nekko.protocol

import java.net.ConnectException
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.net.UnknownHostException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** The phone's secrets for Nekko Cloud (the app's Keystore-sealed store; never backed up). */
interface CloudSecrets {
    suspend fun get(key: String): String?
    suspend fun set(key: String, value: String?)
}

/** Where the decrypted synced chats are kept to read offline (app storage, never backed up). */
interface CloudFiles {
    suspend fun load(): String?
    suspend fun save(text: String)
    suspend fun remove()
}

/** HTTP for Nekko Cloud and Supabase Auth, so tests answer without a network. Returns (status, body). */
fun interface CloudHTTP {
    suspend fun send(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String>
}

/** A Nekko Cloud refusal in our own words: [message] is what the screen shows. */
class CloudError(message: String, val status: Int = 0, val code: String = "") : Exception(message)

/**
 * Nekko Cloud on the phone (#2835, the iPhone's `CloudSync`): sign in (Supabase Auth proves who you are, the
 * device token comes from Nekko Cloud), join the account's end-to-end encrypted sync with the recovery key or
 * by being approved on a computer, approve a new computer from here (with the join code it shows), and read the
 * synced chats without the computer online. The phone reads sync; it doesn't write chats (they live on the
 * computer that runs them) and never starts a key epoch. It takes a new epoch only from a device its current
 * account record trusts, and only records under the epoch it holds.
 *
 * The crypto is [SyncCrypto] (held to `crates/nekko-sync`'s vectors); the flows match `crates/nekko-cloud`.
 * Call [load] once, then call one operation at a time from one coroutine (the screen's), as the iPhone's
 * main-actor model does.
 */
class CloudSync(
    api: String,
    private val http: CloudHTTP,
    private val secrets: CloudSecrets,
    private val files: CloudFiles?,
    private val deviceLabel: String,
    /** How long to wait before each retry of a brief Nekko Cloud stall, in milliseconds (tests pass tiny waits). */
    private val retryWaits: List<Long> = listOf(500, 2_000),
    /** This phone's agreement key, made on first use (a Keystore key from API 31). */
    private val key: suspend () -> SyncAgreementKey,
) {
    enum class Phase(val wire: String) {
        SIGNED_OUT("signed-out"),
        NEEDS_PLAN("needs-plan"),
        /** Signed in on Pro or Enterprise, but no computer has turned sync on yet. */
        NOT_SET_UP("off"),
        NEEDS_JOIN("needs-join"),
        AWAITING_APPROVAL("awaiting-approval"),
        SYNCING("syncing"),
        IDLE("idle"),
        ERROR("error"),
    }

    @Serializable
    data class Account(val id: String, val email: String, val plan: String, val canSync: Boolean)

    data class Device(
        val id: String,
        val label: String,
        val fingerprint: String,
        val revoked: Boolean,
        val trusted: Boolean,
        val thisDevice: Boolean,
        /** It asked to join: approve it with the code its screen shows. */
        val askedToJoin: Boolean,
    )

    data class Message(val role: String, val text: String)
    data class Chat(val id: String, val title: String, val updatedAt: Double, val messages: List<Message>)

    /** What the screens show. */
    data class View(
        val account: Account? = null,
        val signedIn: Boolean = false,
        val phase: Phase = Phase.SIGNED_OUT,
        val devices: List<Device> = emptyList(),
        val chats: List<Chat> = emptyList(),
        val syncing: Boolean = false,
        val error: String? = null,
        val lastSyncAt: Long? = null,
        /** The account already syncs (a key epoch exists on the server). */
        val accountSyncs: Boolean = false,
        /** This phone asked to join and is waiting for a computer to approve it. */
        val waitingForApproval: Boolean = false,
        /** While waiting: the one-time code to type on the computer that approves this phone. */
        val joinCode: String? = null,
        /** The account's computers that publish how to reach them (decision 0128); none while signed out. */
        val reach: List<Reach> = emptyList(),
    )

    /** What survives a relaunch, none of it secret (kept in the sealed store all the same). */
    @Serializable
    internal data class State(
        val account: Account? = null,
        /** The account this phone's keys and chats belong to; kept across sign-out, so signing in to another account forgets them. */
        val keysAccount: String? = null,
        val deviceId: String? = null,
        val keyId: Long? = null,
        val recoveryPublic: String? = null,
        val accountRecord: String? = null,
        val cursor: Long = 0,
        val revisions: Map<String, Long> = emptyMap(),
        val waiting: Boolean = false,
    )

    private val api = api.trimEnd('/')
    private val apiHost = runCatching { URI(this.api).host }.getOrNull()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private var state = State()
    private var hasToken = false
    private var hasKeys = false
    private var chats: List<Chat> = emptyList()
    private var devices: List<Device> = emptyList()
    private var syncing = false
    private var error: String? = null
    private var lastSyncAt: Long? = null
    private var joinCode: String? = null
    /** Each computer's `reach` record as its plaintext, by account device id. It holds room secrets, so it has its own sealed slot, not [State]. */
    private var reachRecords: Map<String, String> = emptyMap()
    private var reachDirty = false
    /** The newest key epoch on the server. */
    private var remoteKeyId: Long? = null
    /** The device the current token is bound to, per the server. */
    private var boundDevice: String? = null
    /** The (token, key epoch) Nekko Cloud last accepted this phone's epoch proof for. */
    private var proven: Pair<String, Long>? = null
    private var supabase: Pair<String, String>? = null

    private val mutable = MutableStateFlow(View())
    val view: StateFlow<View> = mutable.asStateFlow()

    /** Read what was saved: the sign-in, the keys' epoch, the synced chats. */
    suspend fun load() {
        state = secrets.get(STATE)?.let { runCatching { json.decodeFromString(State.serializer(), it) }.getOrNull() } ?: State()
        hasToken = secrets.get(TOKEN) != null
        hasKeys = state.keyId?.let { keyring(it) } != null
        joinCode = if (state.waiting) secrets.get(JOIN_CODE) else null
        chats = decodeChats(files?.load())
        reachRecords = secrets.get(REACH)?.let { runCatching { (json.parseToJsonElement(it) as JsonObject).mapValues { e -> (e.value as JsonPrimitive).content } }.getOrNull() } ?: emptyMap()
        publish()
    }

    private val signedIn get() = state.account != null && hasToken

    private fun phase(): Phase = when {
        !signedIn -> Phase.SIGNED_OUT
        state.account?.canSync != true -> Phase.NEEDS_PLAN
        syncing -> Phase.SYNCING
        hasKeys -> if (error == null) Phase.IDLE else Phase.ERROR
        state.waiting -> Phase.AWAITING_APPROVAL
        remoteKeyId != null -> Phase.NEEDS_JOIN
        else -> Phase.NOT_SET_UP
    }

    private fun publish() {
        mutable.value = View(
            account = state.account, signedIn = signedIn, phase = phase(), devices = devices, chats = chats, syncing = syncing,
            error = error, lastSyncAt = lastSyncAt, accountSyncs = remoteKeyId != null, waitingForApproval = state.waiting, joinCode = joinCode,
            // Signing out takes the account's computers away; they come back from the kept records on the next sign-in.
            reach = if (signedIn && hasKeys) reachList() else emptyList(),
        )
    }

    private fun reachList(): List<Reach> =
        reachRecords.values.mapNotNull { FleetLink.parseReach(it.toByteArray(Charsets.UTF_8)) }.filter { !it.deleted }.sortedBy { it.name.lowercase() }

    /**
     * What the account HELLO needs (decision 0128): null while signed out, not joined, or when this phone's id or the
     * account's ids can't be carried in a HELLO. Call it just before dialing; it reads the current epoch's keyring.
     */
    suspend fun accountIdentity(): AccountIdentity? {
        if (!signedIn) return null
        val accountId = state.account?.id ?: return null
        val deviceId = state.deviceId ?: return null
        val epoch = state.keyId?.takeIf { it in 1..0xFFFF_FFFFL && it <= Int.MAX_VALUE } ?: return null
        val kr = keyring(epoch) ?: return null
        return runCatching {
            // Fails on an id that may not travel in associated data; nothing is sent then.
            FleetLink.helloAad(accountId, epoch.toInt(), deviceId)
            AccountIdentity(AccountKeyring(kr.bytes), accountId, epoch.toInt(), deviceId)
        }.getOrNull()
    }

    /** A short code for this phone's key, to tell devices apart in the list. */
    suspend fun fingerprint(): String? = runCatching { SyncCrypto.fingerprint(key().publicKeyX963) }.getOrNull()

    // ---- Sign-in ----

    suspend fun sendCode(email: String) {
        val (url, anon) = supabaseConfig()
        request("POST", "$url/auth/v1/otp", buildJsonObject { put("email", email); put("create_user", true) }, headers = anonHeaders(anon))
    }

    suspend fun verifyCode(email: String, code: String) {
        val (url, anon) = supabaseConfig()
        val body = buildJsonObject { put("type", "email"); put("email", email); put("token", code) }
        val v = try {
            request("POST", "$url/auth/v1/verify", body, headers = anonHeaders(anon))
        } catch (e: CloudError) {
            if (e.status == 403 || e.status == 400) throw CloudError("That code didn't work. Check it, or send a new one.", e.status, e.code)
            throw e
        }
        finishSignIn(v.str("access_token").orEmpty())
    }

    /** The browser sign-in: open [OAuthStart.url], then pass the callback with [OAuthStart.verifier] to [finishOAuth]. */
    class OAuthStart(val url: String, val verifier: String) {
        override fun toString() = "OAuthStart($url, ..)"
    }

    suspend fun oauthStart(provider: String): OAuthStart {
        if (provider !in OAUTH_PROVIDERS) throw CloudError("That sign-in isn't offered.")
        val (url, _) = supabaseConfig()
        val verifier = SyncCrypto.base64url(SyncCrypto.randomBytes(32))
        val q = listOf(
            "provider" to provider, "redirect_to" to OAUTH_REDIRECT,
            "code_challenge" to SyncCrypto.pkceChallenge(verifier), "code_challenge_method" to "s256",
        ).joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, "UTF-8")}" }
        return OAuthStart("$url/auth/v1/authorize?$q", verifier)
    }

    suspend fun finishOAuth(callback: String, verifier: String) {
        val code = runCatching { URI(callback).rawQuery }.getOrNull().orEmpty().split('&')
            .map { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('=', ""), "UTF-8") }
            .firstOrNull { it.first == "code" }?.second?.takeIf { it.isNotEmpty() }
            // Not the callback's own text: only fixed wording is shown.
            ?: throw CloudError("Sign-in didn't finish. Try again.")
        val (url, anon) = supabaseConfig()
        val v = request("POST", "$url/auth/v1/token?grant_type=pkce", buildJsonObject { put("auth_code", code); put("code_verifier", verifier) }, headers = anonHeaders(anon))
        finishSignIn(v.str("access_token").orEmpty())
    }

    internal suspend fun finishSignIn(accessToken: String) {
        if (accessToken.isEmpty()) throw CloudError("Supabase didn't return a session.")
        val v = request("POST", path("/v1/auth/session"), buildJsonObject { put("accessToken", accessToken); put("label", deviceLabel) })
        val token = v.str("token") ?: throw CloudError("Nekko Cloud sent no token.")
        val a = account(v["account"])
        val old = state.keysAccount ?: state.account?.id
        if (old != null && old != a.id) {
            // Another account's keys and chats never mix with this one's.
            forgetKeys()
            state = State()
            devices = emptyList()
            remoteKeyId = null
        }
        secrets.set(TOKEN, token)
        hasToken = true
        state = state.copy(account = a, keysAccount = a.id)
        save()
        runCatching { refresh() }
        publish()
    }

    suspend fun signOut() {
        val t = secrets.get(TOKEN)
        secrets.set(TOKEN, null)
        hasToken = false
        state = state.copy(keysAccount = state.keysAccount ?: state.account?.id, account = null)
        devices = emptyList()
        boundDevice = null
        proven = null
        save()
        if (t != null) runCatching { request("DELETE", path("/v1/auth/session"), token = t) }
    }

    // ---- State from the server ----

    suspend fun refresh() {
        val t = token()
        val me = request("GET", path("/v1/auth/me"), token = t)
        state = state.copy(account = account(me["account"]))
        val remote = request("GET", path("/v1/sync/state"), token = t)
        // A number the server sends that doesn't fit is treated as missing, never trapped on.
        remoteKeyId = remote.epoch("currentKeyId")
        boundDevice = remote.str("device")
        val trusted = accountRecord(state.accountRecord)?.devices?.map { it.id }?.toSet().orEmpty()
        devices = remote.arr("devices").mapNotNull { d ->
            val o = d as? JsonObject ?: return@mapNotNull null
            val id = o.str("id") ?: return@mapNotNull null
            val pk = o.str("publicKey")?.let { runCatching { SyncCrypto.fromBase64url(it) }.getOrNull() } ?: ByteArray(0)
            Device(
                id = id, label = o.str("label") ?: "Device", fingerprint = SyncCrypto.fingerprint(pk),
                revoked = o["revokedAt"].present(), trusted = id in trusted, thisDevice = id == state.deviceId, askedToJoin = o["joinTag"].present(),
            )
        }
        save()
    }

    // ---- Joining ----

    /** Register this phone with a join code and wait for a computer to approve it. The code ([View.joinCode]) is typed on that computer. */
    suspend fun requestJoin() {
        val t = token()
        refresh()
        val accountId = state.account?.id ?: throw CloudError("Sign in first.")
        val code = secrets.get(JOIN_CODE)?.let { runCatching { SyncCrypto.JoinCode.parse(it) }.getOrNull() }
            ?: SyncCrypto.JoinCode.generate().also { secrets.set(JOIN_CODE, it.text) }
        joinCode = code.text
        val device = key()
        ensureDevice(t, code.tag(accountId, device.publicKeyX963))
        state = state.copy(waiting = true)
        save()
        refresh()
    }

    /** Join with the recovery key: open the current epoch's recovery wrap, check that epoch's account record names this recovery key, then add this phone. */
    suspend fun restore(recoveryKey: String) {
        val t = token()
        val rk = try { SyncCrypto.RecoveryKey.parse(recoveryKey) } catch (_: SyncCrypto.Failure) {
            throw CloudError("That isn't a valid recovery key. Check it for typos.")
        }
        refresh()
        val accountId = state.account?.id ?: throw CloudError("Sign in first.")
        val current = remoteKeyId ?: throw CloudError("This account doesn't sync yet. Turn sync on on your computer first.")
        val (device, deviceId) = ensureDevice(t, null)
        val ring = request("GET", path("/v1/sync/keyrings/$current"), token = t)
        val keyring = try {
            SyncCrypto.openRecovery(rk, accountId, current, ring.str("recoveryWrap").orEmpty())
        } catch (_: SyncCrypto.Failure) {
            throw CloudError("That recovery key doesn't belong to this account.")
        }
        state = state.copy(recoveryPublic = SyncCrypto.base64url(SyncCrypto.recoveryAgreementKey(rk).publicKeyX963))
        // Never invent a record: without the account's own, the other devices would be dropped.
        val (record, oid, rev) = fetchAccount(t, keyring, accountId, current)
            ?: throw CloudError("Nekko Cloud didn't send this account's record. Try again in a moment.")
        val wrap = SyncCrypto.wrapKeyring(keyring, accountId, current, deviceId, device.publicKeyX963, deviceId, device)
        val proof = SyncCrypto.base64url(SyncCrypto.epochProof(keyring, current))
        try {
            request("PUT", path("/v1/sync/keyrings/$current/wraps/$deviceId"), buildJsonObject { put("wrap", wrap); put("proof", proof) }, token = t)
            proven = t to current
        } catch (e: CloudError) {
            if (e.code != "wrap-exists") throw e
        }
        holdEpoch(current, keyring, record, oid, rev)
        prove(t, current)
        state = state.copy(waiting = false)
        save()
        val me = TrustedDevice(deviceId, SyncCrypto.base64url(device.publicKeyX963), deviceLabel)
        updateAccount(t) { it.add(me) }
        sync()
    }

    /** On this phone, approve a computer that asked to join, with the join code its screen shows. */
    suspend fun approve(deviceId: String, code: String) {
        val t = token()
        val joinCode = try { SyncCrypto.JoinCode.parse(code) } catch (_: SyncCrypto.Failure) {
            throw CloudError("Type the 16-character code the computer shows.")
        }
        sync()
        val accountId = state.account?.id
        val current = state.keyId
        val kr = current?.let { keyring(it) }
        if (accountId == null || current == null || kr == null) throw CloudError("This phone doesn't sync yet.")
        val remote = request("GET", path("/v1/sync/state"), token = t)
        val d = remote.arr("devices").firstOrNull { (it as? JsonObject)?.str("id") == deviceId } as? JsonObject
        val pk = d?.str("publicKey")?.let { runCatching { SyncCrypto.fromBase64url(it) }.getOrNull() }
        if (d == null || pk == null) throw CloudError("That device isn't on this account.")
        if (d["revokedAt"].present()) throw CloudError("That device was removed.")
        val label = d.str("label") ?: "the computer"
        // The key Nekko Cloud shows must be the one the code was made for; a swapped key fails here.
        val tag = d.str("joinTag")?.let { runCatching { SyncCrypto.fromBase64url(it) }.getOrNull() } ?: ByteArray(0)
        if (!joinCode.verifies(accountId, pk, tag)) throw CloudError("That code doesn't match $label. Check the code on that computer and type it again.")
        val joining = TrustedDevice(deviceId, SyncCrypto.base64url(pk), d.str("label").orEmpty())
        updateAccount(t) { it.add(joining) }
        val wrap = SyncCrypto.wrapForJoin(kr, accountId, current, deviceId, pk, joinCode)
        prove(t, current)
        request("PUT", path("/v1/sync/keyrings/$current/wraps/$deviceId"), buildJsonObject { put("wrap", wrap) }, token = t)
        refresh()
        publish()
    }

    // ---- Sync (read) ----

    suspend fun sync() {
        val t = token()
        syncing = true
        publish()
        try {
            refresh()
            if (state.keyId != null && remoteKeyId == null) {
                // Everything synced was deleted (on a computer, or by the server).
                forgetKeys()
                resetSync()
                throw CloudError("Everything synced was deleted from Nekko Cloud.")
            }
            if (!hasKeys) {
                if (!finishJoin(t)) return // still waiting to be approved
            } else {
                // Signed in again since this phone registered: bind the new token to it.
                ensureDevice(t, null)
            }
            val remote = remoteKeyId ?: 0
            val mine = state.keyId ?: 0
            if (remote < mine) throw CloudError("Nekko Cloud reports an older sync key than this phone holds. Nothing was synced.")
            if (remote > mine && !adopt(t, remote)) return
            for (attempt in 0 until 3) {
                if (pull(t)) break
                refresh()
                if (!adopt(t, remoteKeyId ?: 0)) return
            }
            error = null
            lastSyncAt = System.currentTimeMillis()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            error = (e as? CloudError)?.message ?: "Couldn't sync. Try again."
            throw e
        } finally {
            syncing = false
            publish()
        }
    }

    /**
     * One sync for the background loop: nothing unless this phone is signed in and joined (it never starts a join or
     * a sign-in), and no error escapes: the screens read [View.error]. True when it synced.
     */
    suspend fun syncQuietly(): Boolean {
        if (!signedIn || !hasKeys || syncing || state.account?.canSync != true) return false
        return try {
            sync()
            true
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            false
        }
    }

    /** The keyring a computer wrapped to this phone with its join code, once approved. */
    private suspend fun finishJoin(t: String): Boolean {
        val accountId = state.account?.id ?: return false
        val deviceId = state.deviceId ?: return false
        val code = secrets.get(JOIN_CODE)?.let { runCatching { SyncCrypto.JoinCode.parse(it) }.getOrNull() } ?: return false
        val current = remoteKeyId ?: return false
        val device = key()
        val me = SyncCrypto.base64url(device.publicKeyX963)
        // The approval may predate a rotation: look back a few epochs, then catch up through the chain.
        for (k in current downTo maxOf(1, current - 4)) {
            val ring = request("GET", path("/v1/sync/keyrings/$k"), token = t)
            val w = ring.str("wrap") ?: continue
            val kr = runCatching { SyncCrypto.unwrapJoin(device, accountId, k, deviceId, code, w) }.getOrNull() ?: continue
            val found = fetchAccount(t, kr, accountId, k) ?: return false
            if (!found.first.lists(deviceId, me)) return false
            holdEpoch(k, kr, found.first, found.second, found.third)
            secrets.set(JOIN_CODE, null)
            joinCode = null
            state = state.copy(waiting = false)
            save()
            return if (k < current) adopt(t, current) else true
        }
        return false
    }

    /**
     * Move to a newer key epoch, one at a time: each keyring only from a wrap made by a device the record of the
     * epoch this phone holds trusts, and only once that epoch's own record lists this phone. False while the new
     * epoch's record isn't written yet.
     */
    private suspend fun adopt(t: String, target: Long): Boolean {
        val accountId = state.account?.id
        val deviceId = state.deviceId
        if (accountId == null || deviceId == null) throw CloudError("This phone has no sync keys.")
        val device = key()
        val me = SyncCrypto.base64url(device.publicKeyX963)
        while (true) {
            val mine = state.keyId ?: break
            if (mine >= target) break
            val next = mine + 1
            val trusted = accountRecord(state.accountRecord)?.takeIf { it.epoch == mine }
                ?: throw CloudError("This phone hasn't read the account record yet.")
            val ring = request("GET", path("/v1/sync/keyrings/$next"), token = t)
            val w = ring.str("wrap") ?: throw CloudError(REMOVED)
            val kr = trusted.devices.firstNotNullOfOrNull { d ->
                val pk = runCatching { SyncCrypto.fromBase64url(d.publicKey) }.getOrNull() ?: return@firstNotNullOfOrNull null
                runCatching { SyncCrypto.unwrapKeyring(device, accountId, next, deviceId, d.id, pk, w) }.getOrNull()
            } ?: throw CloudError("A new sync key came from a device this phone doesn't trust. It was refused.")
            val (record, oid, rev) = fetchAccount(t, kr, accountId, next) ?: return false
            if (!record.lists(deviceId, me)) throw CloudError(REMOVED)
            holdEpoch(next, kr, record, oid, rev)
        }
        return true
    }

    /** Pull and apply everything new. False when it stopped at a record under a newer key epoch than this phone holds (it stays unread until then). */
    private suspend fun pull(t: String): Boolean {
        val accountId = state.account?.id ?: return true
        val byId = chats.associateBy { it.id }.toMutableMap()
        try {
            while (true) {
                val page = request("GET", path("/v1/sync/pull?since=${state.cursor}&limit=200"), token = t)
                val objects = page.arr("objects")
                for (e in objects) {
                    val o = e as? JsonObject ?: continue
                    val kid = o.long("keyId")
                    if (kid != null && kid > (state.keyId ?: 0)) return false
                    apply(o, accountId, byId)
                    o.long("seq")?.let { state = state.copy(cursor = maxOf(state.cursor, it)) }
                }
                state = state.copy(cursor = maxOf(state.cursor, page.long("next") ?: state.cursor))
                if (page.bool("more") != true || objects.isEmpty()) return true
            }
        } finally {
            chats = byId.values.sortedByDescending { it.updatedAt }
            if (reachDirty) {
                reachDirty = false
                secrets.set(REACH, JsonObject(reachRecords.mapValues { JsonPrimitive(it.value) }).toString())
            }
            files?.save(encodeChats(chats))
            save()
        }
    }

    /** Open one pulled object. Only records under the epoch this phone holds count; anything that doesn't open, or isn't newer than a revision seen (a rollback), is ignored. */
    private suspend fun apply(o: JsonObject, accountId: String, byId: MutableMap<String, Chat>) {
        val collection = o.str("collection") ?: return
        val oid = o.str("objectId") ?: return
        val rev = o.long("revision")?.takeIf { it >= 1 } ?: return
        val kid = o.epoch("keyId")?.takeIf { it == state.keyId } ?: return
        val blob = o.str("blob") ?: return
        state.revisions[oid]?.let { if (it >= rev) return }
        val kr = keyring(kid) ?: return
        when (collection) {
            "account" -> {
                val (record, _, _) = runCatching { openAccount(o, kr, accountId, kid) }.getOrNull() ?: return
                keepAccount(record, oid, rev)
                val me = state.deviceId
                if (me != null && !record.trusts(me)) throw CloudError(REMOVED)
                return
            }
            "chat" -> {
                val plain = runCatching { SyncCrypto.openRecord(kr, accountId, kid, collection, oid, rev, blob) }.getOrNull() ?: return
                val v = runCatching { json.parseToJsonElement(plain.toString(Charsets.UTF_8)) as? JsonObject }.getOrNull() ?: return
                val c = v["chat"] as? JsonObject
                if (v.bool("deleted") == true) {
                    byId.keys.firstOrNull { runCatching { SyncCrypto.objectId(kr, "chat", it) }.getOrNull() == oid }?.let { byId.remove(it) }
                } else if (c != null && c.str("id") != null &&
                    // The record must be the one filed under this chat's id: the server can't swap chats.
                    runCatching { SyncCrypto.objectId(kr, "chat", c.str("id")!!) }.getOrNull() == oid
                ) {
                    val chat = chat(c)
                    val had = byId[chat.id]
                    if (had == null || chat.updatedAt >= had.updatedAt) byId[chat.id] = chat
                } else {
                    return
                }
            }
            "reach" -> {
                // A computer's own record (decision 0128): it must open, be in shape, and hash back to the object id it is filed under.
                val plain = runCatching { SyncCrypto.openRecord(kr, accountId, kid, collection, oid, rev, blob) }.getOrNull() ?: return
                val r = FleetLink.parseReach(plain) ?: return
                if (runCatching { SyncCrypto.objectId(kr, "reach", r.deviceId) }.getOrNull() != oid) return
                // Never our own id: this phone is not a computer to dial.
                if (r.deviceId == state.deviceId) return
                reachRecords = if (r.deleted) reachRecords - r.deviceId else reachRecords + (r.deviceId to plain.toString(Charsets.UTF_8))
                reachDirty = true
            }
            else -> return
        }
        state = state.copy(revisions = state.revisions + (oid to rev))
    }

    // ---- The account record ----

    internal data class TrustedDevice(val id: String, val publicKey: String, val label: String)

    /** The sealed account record of one key epoch: the recovery key's public half and the trusted devices. */
    internal data class AccountRecord(val epoch: Long, val recoveryPublic: String, val devices: List<TrustedDevice>) {
        fun trusts(id: String) = devices.any { it.id == id }
        fun lists(id: String, publicKey: String) = devices.any { it.id == id && it.publicKey == publicKey }
        fun add(d: TrustedDevice) = copy(devices = devices.filterNot { it.id == d.id } + d)
    }

    /** Open an epoch's account record and check it: the right object, the epoch it claims, the pinned recovery key, and not older than one seen. */
    private fun openAccount(o: JsonObject, kr: SyncCrypto.Keyring, accountId: String, epoch: Long): Triple<AccountRecord, String, Long> {
        val bad = CloudError("Nekko Cloud sent an account record that doesn't check out.")
        val oid = SyncCrypto.objectId(kr, "account", accountLocalId(epoch))
        val rev = o.long("revision")?.takeIf { it >= 1 } ?: throw bad
        if (o.str("collection") != "account" || o.str("objectId") != oid || o.long("keyId") != epoch) throw bad
        val plain = runCatching { SyncCrypto.openRecord(kr, accountId, epoch, "account", oid, rev, o.str("blob").orEmpty()) }.getOrNull() ?: throw bad
        val record = accountRecord(plain.toString(Charsets.UTF_8))?.takeIf { it.epoch == epoch } ?: throw bad
        // The recovery key's public half never changes; a record naming another one is refused.
        state.recoveryPublic?.let { if (it != record.recoveryPublic) throw bad }
        state.revisions[oid]?.let { if (it > rev) throw CloudError("Nekko Cloud sent an older account record than this phone has seen.") }
        return Triple(record, oid, rev)
    }

    /** An epoch's account record, out of feed order. Null while it isn't written yet. */
    private suspend fun fetchAccount(t: String, kr: SyncCrypto.Keyring, accountId: String, epoch: Long): Triple<AccountRecord, String, Long>? {
        val oid = SyncCrypto.objectId(kr, "account", accountLocalId(epoch))
        return try {
            openAccount(request("GET", path("/v1/sync/objects/account/$oid"), token = t), kr, accountId, epoch)
        } catch (e: CloudError) {
            if (e.status == 404) null else throw e
        }
    }

    private suspend fun keepAccount(record: AccountRecord, oid: String, revision: Long) {
        state = state.copy(
            recoveryPublic = record.recoveryPublic,
            accountRecord = accountRecordJson(record),
            revisions = state.revisions + (oid to maxOf(state.revisions[oid] ?: 0, revision)),
        )
        save()
    }

    /** Hold a keyring as the current epoch and forget older ones: records under an older epoch are never accepted again. */
    private suspend fun holdEpoch(epoch: Long, kr: SyncCrypto.Keyring, record: AccountRecord, oid: String, revision: Long) {
        val old = state.keyId
        secrets.set(keyringSlot(epoch), SyncCrypto.base64url(kr.bytes))
        state = state.copy(keyId = epoch)
        hasKeys = true
        keepAccount(record, oid, revision)
        if (old != null && old < epoch) for (k in 1..old) secrets.set(keyringSlot(k), null)
    }

    /**
     * Change the current epoch's account record: apply [change] to the newest one and push it. Never builds one
     * from nothing (that would drop every other device), and never takes the server's word for an older revision.
     */
    private suspend fun updateAccount(t: String, change: (AccountRecord) -> AccountRecord) {
        val accountId = state.account?.id
        val k = state.keyId
        val kr = k?.let { keyring(it) }
        if (accountId == null || k == null || kr == null) throw CloudError("This phone doesn't sync yet.")
        val oid = SyncCrypto.objectId(kr, "account", accountLocalId(k))
        repeat(3) {
            val record = accountRecord(state.accountRecord)?.takeIf { it.epoch == k }?.let(change)
                ?: throw CloudError("This phone hasn't read the account record yet. Sync, then try again.")
            val seen = state.revisions[oid] ?: 0
            val revision = seen + 1
            val blob = SyncCrypto.sealRecord(kr, accountId, k, "account", oid, revision, accountRecordJson(record).toByteArray(Charsets.UTF_8))
            val obj = buildJsonObject { put("collection", "account"); put("objectId", oid); put("revision", revision); put("keyId", k); put("blob", blob) }
            prove(t, k)
            val res = request("POST", path("/v1/sync/push"), buildJsonObject { put("objects", buildJsonArray { add(obj) }) }, token = t)
            val r = res.arr("results").firstOrNull() as? JsonObject
            when (r?.str("status")) {
                "ok" -> {
                    keepAccount(record, oid, revision)
                    return
                }
                "conflict" -> {
                    if ((r.long("revision") ?: 0) < seen) throw CloudError("Nekko Cloud sent an older account record than this phone has seen.")
                    fetchAccount(t, kr, accountId, k)?.let { (rec, o, rev) -> keepAccount(rec, o, rev) }
                }
                else -> throw CloudError("Couldn't save the account's device list.")
            }
        }
        throw CloudError("Couldn't save the account's device list.")
    }

    // ---- Helpers ----

    /**
     * This phone's key and registered id. Registers (again) when this sign-in's token isn't bound to it yet, so
     * removing the phone always ends the token it uses.
     */
    private suspend fun ensureDevice(t: String, joinTag: ByteArray?): Pair<SyncAgreementKey, String> {
        val device = key()
        val known = state.deviceId
        if (known != null && boundDevice == known && joinTag == null) return device to known
        val body = buildJsonObject {
            put("publicKey", SyncCrypto.base64url(device.publicKeyX963))
            put("label", deviceLabel)
            if (joinTag != null) put("joinTag", SyncCrypto.base64url(joinTag))
        }
        val v = try {
            request("POST", path("/v1/sync/devices"), body, token = t)
        } catch (e: CloudError) {
            when (e.code) {
                "token-has-device" -> throw CloudError("This sign-in already belongs to another device. Sign out and in again.", e.status, e.code)
                "device-revoked" -> {
                    forgetKeys()
                    resetSync()
                    throw CloudError("This phone was removed from sync. Set sync up again to add it back.", e.status, e.code)
                }
                else -> throw e
            }
        }
        val id = v.str("deviceId") ?: throw CloudError("Nekko Cloud didn't register this phone.")
        if (known != null && known != id) throw CloudError("Nekko Cloud gave this phone a different id. Sign out and in again.")
        state = state.copy(deviceId = id)
        boundDevice = id
        save()
        return device to id
    }

    private suspend fun keyring(id: Long): SyncCrypto.Keyring? =
        secrets.get(keyringSlot(id))?.let { runCatching { SyncCrypto.Keyring(SyncCrypto.fromBase64url(it)) }.getOrNull() }

    /** Show Nekko Cloud this sign-in holds the epoch's keyring, once per (token, epoch). Changing keys, devices or data needs it. */
    private suspend fun prove(t: String, keyId: Long) {
        if (proven == t to keyId) return
        val kr = keyring(keyId) ?: throw CloudError("This phone has no sync keys.")
        request("POST", path("/v1/sync/keyrings/$keyId/proof"), buildJsonObject { put("proof", SyncCrypto.base64url(SyncCrypto.epochProof(kr, keyId))) }, token = t)
        proven = t to keyId
    }

    private suspend fun forgetKeys() {
        proven = null
        for (k in 1..maxOf(1, state.keyId ?: 1)) secrets.set(keyringSlot(k), null)
        hasKeys = false
        secrets.set(JOIN_CODE, null)
        joinCode = null
        secrets.set(REACH, null)
        reachRecords = emptyMap()
        reachDirty = false
        chats = emptyList()
        files?.remove()
    }

    /** Forget sync (keys already gone), keeping the sign-in. */
    private suspend fun resetSync() {
        state = State(account = state.account, keysAccount = state.account?.id)
        save()
    }

    /** Forget this phone's sync: keys, synced chats and sign-in (Settings → Forget everything). */
    suspend fun forgetAll() {
        forgetKeys()
        secrets.set(TOKEN, null)
        hasToken = false
        state = State()
        devices = emptyList()
        remoteKeyId = null
        boundDevice = null
        save()
    }

    private suspend fun save() {
        secrets.set(STATE, json.encodeToString(State.serializer(), state))
        publish()
    }

    private suspend fun token(): String = secrets.get(TOKEN) ?: throw CloudError("Sign in to Nekko Cloud first.")

    private fun path(p: String) = api + p

    private fun anonHeaders(anon: String) = mapOf("apikey" to anon, "Authorization" to "Bearer $anon")

    private suspend fun supabaseConfig(): Pair<String, String> {
        supabase?.let { return it }
        val v = try {
            request("GET", path("/v1/auth/config"))
        } catch (e: CloudError) {
            if (e.code == "sign-in-not-configured") throw CloudError("Nekko Cloud sign-in isn't switched on yet.", e.status, e.code)
            throw e
        }
        val url = v.str("supabaseUrl")
        val anon = v.str("supabaseAnonKey")
        if (url == null || anon == null) throw CloudError("Nekko Cloud sent no sign-in settings.")
        return (url.trimEnd('/') to anon).also { supabase = it }
    }

    /**
     * One request. Only Nekko Cloud's own API is retried (a sign-in code sent twice would send two emails), and
     * only when nothing reached it (a failed connect) or it said it couldn't do the work right now (502–504),
     * as on the desktop (#3186). A 5xx never shows the server's own text, only ours.
     */
    private suspend fun request(method: String, url: String, body: JsonObject? = null, token: String? = null, headers: Map<String, String> = emptyMap()): JsonObject {
        val h = headers.toMutableMap()
        if (token != null) h["Authorization"] = "Bearer $token"
        if (body != null) h["Content-Type"] = "application/json"
        val waits = ArrayDeque(if (runCatching { URI(url).host }.getOrNull() == apiHost) retryWaits else emptyList())
        var status: Int
        var text: String
        while (true) {
            val answer = try {
                http.send(method, url, h, body?.toString())
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                if ((e is ConnectException || e is UnknownHostException) && waits.isNotEmpty()) {
                    delay(waits.removeFirst())
                    continue
                }
                throw CloudError("Couldn't reach Nekko Cloud. Check your connection.")
            }
            status = answer.first
            text = answer.second
            if (status in 502..504 && waits.isNotEmpty()) {
                delay(waits.removeFirst())
                continue
            }
            break
        }
        val v = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
        if (status !in 200..299) {
            val code = v.str("error") ?: v.str("error_code") ?: ""
            val busy = status in 502..504 || (status >= 500 && code in setOf("unavailable", "database-unavailable", "busy"))
            val message = when {
                code == "account-not-available" -> "Nekko Cloud is invite-only for now. This account isn't on the list yet."
                busy -> "Nekko Cloud is busy right now. Try again in a moment."
                status >= 500 -> "Nekko Cloud ran into a problem. Try again in a moment."
                else -> v.str("message") ?: v.str("msg") ?: when (status) {
                    402 -> "Sync needs a Pro or Enterprise plan."
                    401 -> "You're signed out of Nekko Cloud."
                    else -> "Nekko Cloud answered $status."
                }
            }
            throw CloudError(message, status, code)
        }
        return v
    }

    companion object {
        val OAUTH_PROVIDERS = listOf("apple", "github", "google")
        /** Where the browser comes back to (the app's `nekko-agent` scheme; allowed in Supabase's redirect list). */
        const val OAUTH_REDIRECT = "nekko-agent://cloud-callback"
        const val REMOVED = "This phone was removed from sync on another device."

        internal const val TOKEN = "cloud.token"
        internal const val STATE = "cloud.state"
        internal const val JOIN_CODE = "cloud.joinCode"
        /** The account's computers' `reach` records: room secrets, sealed in their own slot. */
        internal const val REACH = "cloud.reach"
        internal fun keyringSlot(epoch: Long) = "cloud.keyring.$epoch"

        internal fun accountLocalId(epoch: Long) = "epoch-$epoch"

        internal fun accountRecord(text: String?): AccountRecord? {
            val v = text?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: return null
            if (v.long("v") != 2L) return null
            val e = v.epoch("epoch") ?: return null
            val rp = v.str("recoveryPublic") ?: return null
            val devices = v.arr("devices").mapNotNull { d ->
                val o = d as? JsonObject ?: return@mapNotNull null
                TrustedDevice(o.str("id") ?: return@mapNotNull null, o.str("publicKey") ?: return@mapNotNull null, o.str("label").orEmpty())
            }
            return AccountRecord(e, rp, devices)
        }

        internal fun accountRecordJson(r: AccountRecord): String = buildJsonObject {
            put("v", 2)
            put("epoch", r.epoch)
            put("recoveryPublic", r.recoveryPublic)
            put("devices", buildJsonArray { r.devices.forEach { d -> add(buildJsonObject { put("id", d.id); put("publicKey", d.publicKey); put("label", d.label) }) } })
        }.toString()

        internal fun account(v: JsonElement?): Account {
            val o = v as? JsonObject
            return Account(o?.str("id").orEmpty(), o?.str("email").orEmpty(), o?.str("plan") ?: "free", o?.bool("canSync") ?: false)
        }

        internal fun chat(c: JsonObject): Chat {
            val messages = c.arr("messages").mapNotNull { m ->
                val o = m as? JsonObject ?: return@mapNotNull null
                val text = o.str("content") ?: o.str("text") ?: ""
                if (text.isEmpty()) null else Message(o.str("role") ?: "assistant", text)
            }
            return Chat(c.str("id").orEmpty(), c.str("title") ?: "Chat", (c["updatedAt"] as? JsonPrimitive)?.doubleOrNull ?: 0.0, messages)
        }

        internal fun encodeChats(chats: List<Chat>): String = buildJsonArray {
            chats.forEach { c ->
                add(buildJsonObject {
                    put("id", c.id); put("title", c.title); put("updatedAt", c.updatedAt)
                    put("messages", buildJsonArray { c.messages.forEach { m -> add(buildJsonObject { put("role", m.role); put("content", m.text) }) } })
                })
            }
        }.toString()

        internal fun decodeChats(text: String?): List<Chat> =
            (text?.let { runCatching { Json.parseToJsonElement(it) as? JsonArray }.getOrNull() } ?: JsonArray(emptyList())).mapNotNull { (it as? JsonObject)?.let(::chat) }

        private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        private fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        private fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        private fun JsonObject.arr(k: String): List<JsonElement> = (this[k] as? JsonArray).orEmpty()
        /** A key epoch: a whole number from 1 to 2³²−1, else missing (never trapped on). */
        private fun JsonObject.epoch(k: String): Long? = long(k)?.takeIf { it in 1..0xFFFF_FFFFL }
        private fun JsonElement?.present(): Boolean = this != null && this !is JsonNull
    }
}

/**
 * Keeps the account's `reach` records fresh while the app is open (decision 0128): one sync at [start] (launch), one
 * on [onForeground], and one every [intervalMs] after that. Each is [CloudSync.syncQuietly], so a phone that is
 * signed out or not joined does nothing.
 */
class AccountSyncLoop(
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val cloud: CloudSync,
    private val intervalMs: Long = 3 * 60_000L,
) {
    private var job: kotlinx.coroutines.Job? = null
    private val turn = kotlinx.coroutines.sync.Mutex()

    /** Start the loop (at most one runs). */
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (true) {
                once()
                delay(intervalMs)
            }
        }
    }

    /** The app came to the foreground: read the account now. */
    fun onForeground() {
        scope.launch { once() }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    /** Syncs never overlap: a foreground that lands during one waits its turn. */
    private suspend fun once() = turn.withLock { cloud.syncQuietly() }
}

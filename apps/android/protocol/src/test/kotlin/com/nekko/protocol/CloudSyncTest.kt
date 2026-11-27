package com.nekko.protocol

import java.net.URI
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The phone's side of Nekko Cloud (#2835) against an in-memory Nekko Cloud and Supabase Auth: the iPhone's
 * CloudSyncTests, case for case. The "computer" that turned sync on is played by the test with [SyncCrypto],
 * the way `crates/nekko-cloud` seals records.
 */
class CloudSyncTest {
    class MemorySecrets : CloudSecrets {
        val items = mutableMapOf<String, String>()
        override suspend fun get(key: String) = items[key]
        override suspend fun set(key: String, value: String?) {
            if (value == null) items.remove(key) else items[key] = value
        }
    }

    data class Obj(val collection: String, val objectId: String, val revision: Long, val keyId: Long, val blob: String, val seq: Long)
    data class Dev(val id: String, var publicKey: String, val label: String, var joinTag: String?)
    class Ring(val recovery: String, val wraps: MutableMap<String, String>)

    /**
     * Just enough of the API for the phone's calls, with the server's rules (revisions one at a time, wraps never
     * overwritten, key changes and pushes only from a sign-in that proved the current epoch). Tests also play a
     * malicious server by editing its state or setting [rewrite].
     */
    class FakeCloud : CloudHTTP {
        var account = "acct-1"
        var plan = "pro"
        val keyrings = mutableMapOf<Long, Ring>()
        val devices = mutableListOf<Dev>()
        val objects = mutableListOf<Obj>()
        var seq = 0L
        /** The device the phone's token is bound to. */
        var bound: String? = null
        /** Each epoch's proof (the real server keeps only its hash), and the epoch the current sign-in proved. */
        val proofs = mutableMapOf<Long, String>()
        var proven: Long? = null
        var sessions = 0
        /** Change an answer before the phone sees it: (method, path, body) → body. */
        var rewrite: ((String, String, JsonElement) -> JsonElement)? = null

        fun add(collection: String, oid: String, rev: Long, keyId: Long, blob: String) {
            seq += 1
            objects.removeAll { it.objectId == oid && it.collection == collection }
            objects += Obj(collection, oid, rev, keyId, blob, seq)
        }

        fun wire(o: Obj) = buildJsonObject {
            put("collection", o.collection); put("objectId", o.objectId); put("revision", o.revision)
            put("keyId", o.keyId); put("blob", o.blob); put("seq", o.seq)
        }

        fun me() = buildJsonObject { put("id", account); put("email", "ada@example.com"); put("plan", plan); put("canSync", plan != "free") }

        override suspend fun send(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String> {
            val uri = URI(url)
            val (status, answered) = answer(method, uri.path, uri.rawQuery.orEmpty(), body?.let { Json.parseToJsonElement(it) as JsonObject } ?: JsonObject(emptyMap()))
            val v = rewrite?.invoke(method, uri.path, answered) ?: answered
            return status to v.toString()
        }

        private fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull

        private fun answer(method: String, p: String, query: String, b: JsonObject): Pair<Int, JsonElement> {
            val notFound = 404 to buildJsonObject { put("error", "not-found") }
            val err = { status: Int, code: String -> status to buildJsonObject { put("error", code) } }
            when (method to p) {
                "GET" to "/v1/auth/config" -> return 200 to buildJsonObject { put("supabaseUrl", "https://sb.example"); put("supabaseAnonKey", "anon") }
                "POST" to "/auth/v1/otp" -> return 200 to JsonObject(emptyMap())
                "POST" to "/auth/v1/verify" -> {
                    if (b.s("token") != "123456") return 403 to buildJsonObject { put("msg", "bad") }
                    return 200 to buildJsonObject { put("access_token", "supabase-jwt") }
                }
                "POST" to "/v1/auth/session" -> {
                    bound = null; proven = null; sessions += 1
                    return 201 to buildJsonObject { put("token", "nk_test_$sessions"); put("account", me()) }
                }
                "GET" to "/v1/auth/me" -> return 200 to buildJsonObject { put("account", me()) }
                "GET" to "/v1/sync/state" -> return 200 to buildJsonObject {
                    put("account", account)
                    put("currentKeyId", keyrings.keys.maxOrNull()?.let { JsonPrimitive(it) } ?: JsonNull)
                    put("device", bound?.let { JsonPrimitive(it) } ?: JsonNull)
                    put("devices", buildJsonArray {
                        devices.forEach { d ->
                            add(buildJsonObject {
                                put("id", d.id); put("publicKey", d.publicKey); put("label", d.label); put("revokedAt", JsonNull)
                                put("joinTag", d.joinTag?.let { JsonPrimitive(it) } ?: JsonNull)
                            })
                        }
                    })
                }
                "POST" to "/v1/sync/devices" -> {
                    val pk = b.s("publicKey").orEmpty()
                    devices.firstOrNull { it.publicKey == pk }?.let { d ->
                        b.s("joinTag")?.let { d.joinTag = it }
                        bound = d.id
                        return 200 to buildJsonObject { put("deviceId", d.id) }
                    }
                    val id = "dev-${devices.size + 1}"
                    devices += Dev(id, pk, b.s("label").orEmpty(), b.s("joinTag"))
                    bound = id
                    return 201 to buildJsonObject { put("deviceId", id) }
                }
                "GET" to "/v1/sync/pull" -> {
                    val since = query.split('&').firstOrNull { it.startsWith("since=") }?.substringAfter('=')?.toLongOrNull() ?: 0
                    val page = objects.filter { it.seq > since }.sortedBy { it.seq }
                    return 200 to buildJsonObject {
                        put("objects", buildJsonArray { page.forEach { add(wire(it)) } }); put("next", page.lastOrNull()?.seq ?: since); put("more", false)
                    }
                }
                "POST" to "/v1/sync/push" -> {
                    if (proven == null || proven != keyrings.keys.maxOrNull()) return err(403, "needs-synced-device")
                    val results = buildJsonArray {
                        (b["objects"] as JsonArray).forEach { e ->
                            val o = e as JsonObject
                            val c = o.s("collection").orEmpty(); val oid = o.s("objectId").orEmpty()
                            val rev = (o["revision"] as JsonPrimitive).longOrNull ?: 0
                            val have = objects.firstOrNull { it.collection == c && it.objectId == oid }?.revision ?: 0
                            if (rev != have + 1) {
                                add(buildJsonObject { put("objectId", oid); put("status", "conflict"); put("revision", have) })
                            } else {
                                add(c, oid, rev, (o["keyId"] as JsonPrimitive).longOrNull ?: 0, o.s("blob").orEmpty())
                                add(buildJsonObject { put("objectId", oid); put("status", "ok"); put("revision", rev) })
                            }
                        }
                    }
                    return 200 to buildJsonObject { put("results", results) }
                }
                "DELETE" to "/v1/auth/session" -> return 204 to JsonNull
            }
            val parts = p.split('/').filter { it.isNotEmpty() } // v1 sync keyrings K [wraps D | proof] | v1 sync objects C O
            if (parts.size == 5 && parts[2] == "objects") {
                val o = objects.firstOrNull { it.collection == parts[3] && it.objectId == parts[4] } ?: return notFound
                return 200 to wire(o)
            }
            val k = parts.getOrNull(3)?.toLongOrNull()
            val ring = k?.let { keyrings[it] }
            if (parts.size >= 4 && parts[2] == "keyrings" && k != null && ring != null) {
                if (method == "GET") return 200 to buildJsonObject {
                    put("keyId", k); put("recoveryWrap", ring.recovery)
                    put("wrap", bound?.let { ring.wraps[it] }?.let { JsonPrimitive(it) } ?: JsonNull)
                }
                if (method == "POST" && parts.size == 5 && parts[4] == "proof") {
                    if (k != keyrings.keys.maxOrNull()) return err(409, "key-epoch")
                    if (proofs[k] == null || b.s("proof") != proofs[k]) return err(403, "bad-proof")
                    proven = k
                    return 204 to JsonNull
                }
                if (method == "PUT" && parts.size == 6) {
                    val selfProof = parts[5] == bound && proofs[k] != null && b.s("proof") == proofs[k]
                    if (!selfProof && proven != k) return err(403, "needs-synced-device")
                    if (ring.wraps[parts[5]] != null) return err(409, "wrap-exists")
                    ring.wraps[parts[5]] = b.s("wrap").orEmpty()
                    if (selfProof) proven = k
                    return 204 to JsonNull
                }
            }
            return notFound
        }
    }

    /** The computer that turned sync on, played by the test the way `crates/nekko-cloud` does it. */
    class Computer {
        val id = "dev-mac"
        val key = SyncCrypto.SoftwareKey.generate()
        var keyring = SyncCrypto.Keyring.generate()
        var epoch = 1L
        val recovery = SyncCrypto.RecoveryKey.generate()
        val recoveryPublic: ByteArray get() = SyncCrypto.recoveryAgreementKey(recovery).publicKeyX963
        val publicKey: String get() = SyncCrypto.base64url(key.publicKeyX963)
    }

    /** A computer that turned sync on: keyring, recovery key, the epoch's account record and two chats. */
    private fun computer(fake: FakeCloud): Computer {
        val mac = Computer()
        fake.devices += Dev(mac.id, mac.publicKey, "Studio Mac", null)
        val selfWrap = SyncCrypto.wrapKeyring(mac.keyring, fake.account, 1, mac.id, mac.key.publicKeyX963, mac.id, mac.key)
        fake.keyrings[1] = Ring(SyncCrypto.sealRecovery(mac.recoveryPublic, mac.keyring, fake.account, 1), mutableMapOf(mac.id to selfWrap))
        fake.proofs[1] = SyncCrypto.base64url(SyncCrypto.epochProof(mac.keyring, 1))
        writeRecord(fake, mac, listOf(mac.id to mac.publicKey))
        sealChat(fake, mac, "s_1", "Plan the Kyoto trip", "Book the ryokan", 10.0, 1)
        sealChat(fake, mac, "s_2", "Fix the flaky test", "It's a race", 20.0, 1)
        return mac
    }

    /** Write the computer's epoch's account record listing [devices], one revision past what the server has. */
    private fun writeRecord(fake: FakeCloud, mac: Computer, devices: List<Pair<String, String>>, recoveryPublic: ByteArray? = null) {
        val list = devices.joinToString(",") { """{"id":"${it.first}","publicKey":"${it.second}","label":""}""" }
        val rp = SyncCrypto.base64url(recoveryPublic ?: mac.recoveryPublic)
        val record = """{"v":2,"epoch":${mac.epoch},"recoveryPublic":"$rp","devices":[$list]}"""
        val oid = SyncCrypto.objectId(mac.keyring, "account", "epoch-${mac.epoch}")
        val rev = (fake.objects.firstOrNull { it.objectId == oid }?.revision ?: 0) + 1
        fake.add("account", oid, rev, mac.epoch, SyncCrypto.sealRecord(mac.keyring, fake.account, mac.epoch, "account", oid, rev, record.toByteArray()))
    }

    private fun sealChat(
        fake: FakeCloud, mac: Computer, id: String, title: String, text: String, updated: Double, rev: Long,
        oid: String? = null, keyring: SyncCrypto.Keyring? = null, epoch: Long? = null,
    ) {
        val chat = """{"v":1,"chat":{"id":"$id","title":"$title","updatedAt":$updated,"messages":[{"role":"user","content":"$text"}]}}"""
        val k = keyring ?: mac.keyring
        val o = oid ?: SyncCrypto.objectId(k, "chat", id)
        val e = epoch ?: mac.epoch
        fake.add("chat", o, rev, e, SyncCrypto.sealRecord(k, fake.account, e, "chat", o, rev, chat.toByteArray()))
    }

    private fun phone(fake: CloudHTTP, key: SyncCrypto.SoftwareKey = SyncCrypto.SoftwareKey.generate(), secrets: MemorySecrets = MemorySecrets(), waits: List<Long> = listOf(1, 1)) =
        CloudSync("https://api.example", fake, secrets, null, "Pixel", waits) { key }.also { runBlocking { it.load() } }

    private fun CloudSync.text(id: String) = view.value.chats.firstOrNull { it.id == id }?.messages?.firstOrNull()?.text
    private val CloudSync.phase get() = view.value.phase
    private val CloudSync.me get() = view.value.devices.firstOrNull { it.thisDevice }

    private suspend fun fails(what: String, block: suspend () -> Unit): Exception {
        try {
            block()
        } catch (e: Exception) {
            return e
        }
        fail(what)
        error("unreachable")
    }

    @Test fun `sign in then restore with the recovery key reads the chats`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val p = phone(fake)
        assertEquals(CloudSync.Phase.SIGNED_OUT, p.phase)
        p.sendCode("ada@example.com")
        fails("a wrong code signs in") { p.verifyCode("ada@example.com", "000000") }
        p.verifyCode("ada@example.com", "123456")
        assertEquals(CloudSync.Phase.NEEDS_JOIN, p.phase)
        fails("another account's key opens it") { p.restore(SyncCrypto.RecoveryKey.generate().text) }
        p.restore(mac.recovery.text.lowercase())
        assertEquals(CloudSync.Phase.IDLE, p.phase)
        assertEquals(listOf("Fix the flaky test", "Plan the Kyoto trip"), p.view.value.chats.map { it.title })
        assertEquals("Book the ryokan", p.view.value.chats.last().messages.first().text)
        // The phone added itself to the sealed device list, keeping the computer.
        assertTrue(p.me?.trusted == true)
        assertTrue(p.view.value.devices.first { it.id == mac.id }.trusted)
        // Restoring proved the epoch to Nekko Cloud along with the phone's own wrap.
        assertEquals(1L, fake.proven)
    }

    @Test fun `a sign in again proves the epoch before changing devices`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val p = phone(fake)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        p.signOut()
        p.verifyCode("ada@example.com", "123456")
        assertNull("a new sign-in starts unproven", fake.proven)
        val laptop = SyncCrypto.SoftwareKey.generate()
        val code = SyncCrypto.JoinCode.generate()
        fake.devices += Dev("dev-laptop", SyncCrypto.base64url(laptop.publicKeyX963), "MacBook", SyncCrypto.base64url(code.tag(fake.account, laptop.publicKeyX963)))
        p.approve("dev-laptop", code.text)
        assertEquals(1L, fake.proven)
        assertNotNull(fake.keyrings[1]!!.wraps["dev-laptop"])
    }

    @Test fun `restore refuses to invent a missing account record`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        fake.objects.removeAll { it.collection == "account" }
        val p = phone(fake)
        p.verifyCode("ada@example.com", "123456")
        fails("restored without the account's record") { p.restore(mac.recovery.text) }
        assertNotEquals(CloudSync.Phase.IDLE, p.phase)
        assertFalse("no record listing only the phone was pushed", fake.objects.any { it.collection == "account" })
    }

    @Test fun `joining by approval with the join code`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val key = SyncCrypto.SoftwareKey.generate()
        val p = phone(fake, key)
        p.verifyCode("ada@example.com", "123456")
        p.requestJoin()
        assertEquals(CloudSync.Phase.AWAITING_APPROVAL, p.phase)
        val shown = p.view.value.joinCode!!
        val me = p.me!!
        assertTrue(me.askedToJoin)
        p.sync()
        assertEquals("nothing to open until approved", CloudSync.Phase.AWAITING_APPROVAL, p.phase)

        // The server (or anyone signed in) hands the phone a keyring without the code: refused.
        val forged = SyncCrypto.Keyring.generate()
        fake.keyrings[1]!!.wraps[me.id] = SyncCrypto.wrapKeyring(forged, fake.account, 1, me.id, key.publicKeyX963, mac.id, SyncCrypto.SoftwareKey.generate())
        p.sync()
        assertEquals(CloudSync.Phase.AWAITING_APPROVAL, p.phase)
        fake.keyrings[1]!!.wraps.remove(me.id)

        // The computer checks the tag with the typed code, lists the phone, and wraps with the code.
        val code = SyncCrypto.JoinCode.parse(shown)
        val tag = SyncCrypto.fromBase64url(fake.devices.first { it.id == me.id }.joinTag!!)
        assertTrue(code.verifies(fake.account, key.publicKeyX963, tag))
        writeRecord(fake, mac, listOf(mac.id to mac.publicKey, me.id to SyncCrypto.base64url(key.publicKeyX963)))
        fake.keyrings[1]!!.wraps[me.id] = SyncCrypto.wrapForJoin(mac.keyring, fake.account, 1, me.id, key.publicKeyX963, code)
        p.sync()
        assertEquals(CloudSync.Phase.IDLE, p.phase)
        assertEquals(2, p.view.value.chats.size)
        assertNull("the code is forgotten once used", p.view.value.joinCode)
    }

    @Test fun `approving a computer checks its code`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val p = phone(fake)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        // A new computer asks to join with a code.
        val laptop = SyncCrypto.SoftwareKey.generate()
        val code = SyncCrypto.JoinCode.generate()
        val real = Dev("dev-laptop", SyncCrypto.base64url(laptop.publicKeyX963), "MacBook", SyncCrypto.base64url(code.tag(fake.account, laptop.publicKeyX963)))
        fake.devices += real
        fails("a wrong code approved it") { p.approve("dev-laptop", SyncCrypto.JoinCode.generate().text) }
        assertNull(fake.keyrings[1]!!.wraps["dev-laptop"])
        // The server swaps in its own key: the right code no longer matches.
        val realKey = real.publicKey
        real.publicKey = SyncCrypto.base64url(SyncCrypto.SoftwareKey.generate().publicKeyX963)
        fails("approved a swapped key") { p.approve("dev-laptop", code.text) }
        assertNull(fake.keyrings[1]!!.wraps["dev-laptop"])
        real.publicKey = realKey
        p.approve("dev-laptop", code.text.lowercase())
        val wrap = fake.keyrings[1]!!.wraps["dev-laptop"]!!
        assertEquals(mac.keyring, SyncCrypto.unwrapJoin(laptop, fake.account, 1, "dev-laptop", code, wrap))
        assertTrue(p.view.value.devices.first { it.id == "dev-laptop" }.trusted)
    }

    @Test fun `a new epoch is taken only from a trusted device`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val key = SyncCrypto.SoftwareKey.generate()
        val p = phone(fake, key)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        val me = p.me!!.id
        val phonePub = SyncCrypto.base64url(key.publicKeyX963)

        // Someone else announces epoch 2 with a keyring wrapped "from the Mac" with their own key: refused.
        val forged = SyncCrypto.Keyring.generate()
        fake.keyrings[2] = Ring("", mutableMapOf(me to SyncCrypto.wrapKeyring(forged, fake.account, 2, me, key.publicKeyX963, mac.id, SyncCrypto.SoftwareKey.generate())))
        val e = fails("took a keyring from an untrusted key") { p.sync() }
        assertEquals("A new sync key came from a device this phone doesn't trust. It was refused.", e.message)
        fake.keyrings.remove(2)

        // The Mac rotates for real: epoch 2, wrapped by the Mac, record listing both, chats sealed again.
        val old = mac.keyring
        mac.keyring = mac.keyring.rotated()
        mac.epoch = 2
        fake.keyrings[2] = Ring(
            SyncCrypto.sealRecovery(mac.recoveryPublic, mac.keyring, fake.account, 2),
            mutableMapOf(me to SyncCrypto.wrapKeyring(mac.keyring, fake.account, 2, me, key.publicKeyX963, mac.id, mac.key)),
        )
        writeRecord(fake, mac, listOf(mac.id to mac.publicKey, me to phonePub))
        sealChat(fake, mac, "s_1", "Plan the Kyoto trip", "After the rotation", 40.0, 2)
        p.sync()
        assertEquals("After the rotation", p.text("s_1"))

        // A revoked device with the old keyring writes under epoch 1: ignored.
        sealChat(fake, mac, "s_1", "Plan the Kyoto trip", "Forged under epoch 1", 99.0, 3, keyring = old, epoch = 1)
        p.sync()
        assertEquals("After the rotation", p.text("s_1"))
    }

    @Test fun `tampered, swapped and rolled back records are ignored`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val p = phone(fake)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        // A newer revision of s_1 lands; then the server replays the old one (rollback).
        sealChat(fake, mac, "s_1", "Plan the Kyoto trip", "Changed plans", 30.0, 2)
        p.sync()
        assertEquals("Changed plans", p.text("s_1"))
        sealChat(fake, mac, "s_1", "Plan the Kyoto trip", "Book the ryokan", 10.0, 1)
        p.sync()
        assertEquals("a replayed old revision is ignored", "Changed plans", p.text("s_1"))
        // A chat filed under another chat's id (the server swapping records) is refused.
        val s2 = SyncCrypto.objectId(mac.keyring, "chat", "s_2")
        sealChat(fake, mac, "s_9", "Planted", "x", 99.0, 2, oid = s2)
        // A flipped bit doesn't open.
        val o = SyncCrypto.objectId(mac.keyring, "chat", "s_3")
        val raw = SyncCrypto.fromBase64url(
            SyncCrypto.sealRecord(mac.keyring, fake.account, 1, "chat", o, 1, """{"v":1,"chat":{"id":"s_3","title":"T","updatedAt":1,"messages":[]}}""".toByteArray()),
        )
        raw[40] = (raw[40].toInt() xor 1).toByte()
        fake.add("chat", o, 1, 1, SyncCrypto.base64url(raw))
        p.sync()
        assertEquals(setOf("s_1", "s_2"), p.view.value.chats.map { it.id }.toSet())
        // An account record naming another recovery key is refused.
        writeRecord(fake, mac, emptyList(), SyncCrypto.recoveryAgreementKey(SyncCrypto.RecoveryKey.generate()).publicKeyX963)
        p.sync()
        assertTrue("the swapped record was ignored", p.me?.trusted == true)
    }

    @Test fun `another account never sees the first account's keys or chats`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val secrets = MemorySecrets()
        val p = phone(fake, secrets = secrets)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        assertEquals(2, p.view.value.chats.size)
        p.signOut()
        fake.account = "acct-2"
        fake.keyrings.clear()
        fake.objects.clear()
        p.verifyCode("ada@example.com", "123456")
        assertEquals(emptyList<CloudSync.Chat>(), p.view.value.chats)
        assertNull(secrets.items["cloud.keyring.1"])
        assertEquals(CloudSync.Phase.NOT_SET_UP, p.phase)
    }

    @Test fun `out of range numbers from the server don't crash`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val p = phone(fake)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        val bads = listOf(JsonPrimitive(-1), JsonPrimitive(0), JsonPrimitive(0xFFFF_FFFFL + 1))
        // Revisions and key epochs in pulled objects: ignored, the chats stay.
        for (bad in bads) {
            fake.rewrite = { _, path, body ->
                if (path == "/v1/sync/pull") JsonObject((body as JsonObject) + ("objects" to buildJsonArray {
                    add(buildJsonObject { put("collection", "chat"); put("objectId", "A".repeat(43)); put("revision", bad); put("keyId", bad); put("blob", "AA"); put("seq", 1) })
                })) else body
            }
            runCatching { p.sync() }
        }
        assertEquals(2, p.view.value.chats.size)
        // The current epoch: whatever it is, no trap (a missing one reads as "everything was deleted").
        for (bad in bads) {
            fake.rewrite = { _, path, body -> if (path == "/v1/sync/state") JsonObject((body as JsonObject) + ("currentKeyId" to bad)) else body }
            runCatching { p.sync() }
            runCatching { p.refresh() }
        }
        fake.rewrite = null
    }

    @Test fun `free accounts are asked to upgrade and unset accounts to start on the computer`() = runBlocking {
        val fake = FakeCloud()
        fake.plan = "free"
        val p = phone(fake)
        p.verifyCode("ada@example.com", "123456")
        assertEquals(CloudSync.Phase.NEEDS_PLAN, p.phase)
        fake.plan = "pro"
        p.refresh()
        assertEquals(CloudSync.Phase.NOT_SET_UP, p.phase)
        p.signOut()
        assertEquals(CloudSync.Phase.SIGNED_OUT, p.phase)
    }

    @Test fun `the pkce challenge is S256`() = runBlocking {
        val p = phone(FakeCloud())
        val start = p.oauthStart("github")
        val uri = URI(start.url)
        val items = uri.rawQuery.split('&').associate { it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        assertEquals(SyncCrypto.pkceChallenge(start.verifier), items["code_challenge"])
        assertEquals(CloudSync.OAUTH_REDIRECT, items["redirect_to"])
        assertEquals("/auth/v1/authorize", uri.path)
        fails("an unknown provider is offered") { p.oauthStart("myspace") }
        // A callback without a code says only our own words.
        val e = fails("finished without a code") { p.finishOAuth("nekko-agent://cloud-callback?error=<script>", start.verifier) }
        assertEquals("Sign-in didn't finish. Try again.", e.message)
    }

    @Test fun `the browser sign in trades its code for a session`() = runBlocking {
        val fake = FakeCloud()
        var traded: String? = null
        val http = CloudHTTP { m, url, h, b ->
            if (URI(url).path == "/auth/v1/token") {
                traded = b
                200 to """{"access_token":"supabase-jwt"}"""
            } else fake.send(m, url, h, b)
        }
        val p = phone(http)
        val start = p.oauthStart("google")
        p.finishOAuth("nekko-agent://cloud-callback?code=abc%2B123", start.verifier)
        assertTrue(p.view.value.signedIn)
        val body = Json.parseToJsonElement(traded!!) as JsonObject
        assertEquals("abc+123", body["auth_code"]!!.jsonPrimitive.content)
        assertEquals(start.verifier, body["code_verifier"]!!.jsonPrimitive.content)
    }

    /** Answers `/v1/auth/me` with the scripted statuses first, then like the fake cloud. */
    class Stalling(val fake: FakeCloud, var script: MutableList<Pair<Int, String>>) : CloudHTTP {
        var meCalls = 0
        override suspend fun send(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String> {
            if (URI(url).path == "/v1/auth/me") {
                meCalls += 1
                if (script.isNotEmpty()) {
                    val (status, code) = script.removeAt(0)
                    return status to """{"error":"$code","message":"server text"}"""
                }
            }
            return fake.send(method, url, headers, body)
        }
    }

    private fun stalledPhone(script: List<Pair<Int, String>>): Pair<CloudSync, Stalling> = runBlocking {
        val http = Stalling(FakeCloud(), mutableListOf())
        val p = phone(http)
        p.verifyCode("ada@example.com", "123456")
        http.script = script.toMutableList()
        http.meCalls = 0
        p to http
    }

    @Test fun `a 502 then an answer is retried and succeeds`() = runBlocking {
        val (p, http) = stalledPhone(listOf(502 to ""))
        p.refresh()
        assertEquals(2, http.meCalls)
        assertTrue(p.view.value.signedIn)
    }

    @Test fun `three 503s end in the busy message, not the server's text`() = runBlocking {
        val (p, http) = stalledPhone(listOf(503 to "busy", 503 to "busy", 503 to "busy"))
        val e = fails("three stalls fail") { p.refresh() } as CloudError
        assertEquals(503, e.status)
        assertEquals("Nekko Cloud is busy right now. Try again in a moment.", e.message)
        assertEquals("one try and two retries", 3, http.meCalls)
    }

    @Test fun `a 500 internal is not retried and hides the server's text`() = runBlocking {
        val (p, http) = stalledPhone(listOf(500 to "internal"))
        val e = fails("a 500 fails") { p.refresh() } as CloudError
        assertEquals(500, e.status)
        assertEquals("Nekko Cloud ran into a problem. Try again in a moment.", e.message)
        assertEquals(1, http.meCalls)
    }

    @Test fun `a 401 is not retried and keeps its message`() = runBlocking {
        val (p, http) = stalledPhone(listOf(401 to "unauthorized"))
        val e = fails("a 401 fails") { p.refresh() } as CloudError
        assertEquals("server text", e.message)
        assertEquals(1, http.meCalls)
    }

    @Test fun `the invite only gate says so`() = runBlocking {
        val fake = FakeCloud()
        val http = CloudHTTP { m, url, h, b ->
            if (URI(url).path == "/v1/auth/session") 403 to """{"error":"account-not-available","message":"nope"}""" else fake.send(m, url, h, b)
        }
        val e = fails("signed in an account not on the list") { phone(http).verifyCode("ada@example.com", "123456") }
        assertEquals("Nekko Cloud is invite-only for now. This account isn't on the list yet.", e.message)
    }

    @Test fun `a relaunch keeps the sign in, the keys' epoch and nothing secret in the state`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val secrets = MemorySecrets()
        val key = SyncCrypto.SoftwareKey.generate()
        val p = phone(fake, key, secrets)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        val again = phone(fake, key, secrets)
        assertEquals(CloudSync.Phase.IDLE, again.phase)
        val state = secrets.items["cloud.state"]!!
        assertFalse("the token stays in its own slot", state.contains("nk_test"))
        assertFalse("the keyring stays in its own slot", state.contains(secrets.items["cloud.keyring.1"]!!))
        assertFalse("the recovery key is never stored", secrets.items.values.any { it.contains(mac.recovery.text) })
    }

    // ---- reach records (decision 0128) ----

    private fun sealReach(fake: FakeCloud, mac: Computer, deviceId: String, plain: String, rev: Long, oid: String? = null, keyring: SyncCrypto.Keyring? = null, epoch: Long? = null) {
        val k = keyring ?: mac.keyring
        val o = oid ?: SyncCrypto.objectId(k, "reach", deviceId)
        val e = epoch ?: mac.epoch
        fake.add("reach", o, rev, e, SyncCrypto.sealRecord(k, fake.account, e, "reach", o, rev, plain.toByteArray()))
    }

    private fun reachJson(id: String, name: String = "Studio Mac", routes: String = "\"wss://relay.nekko.example/r/1\"", room: String = "room-1") =
        "{\"v\":1,\"deviceId\":\"$id\",\"name\":\"$name\",\"routes\":[$routes],\"room\":\"$room\",\"secret\":\"s3cr3t-pairing-secret\",\"hostKey\":\"HOSTKEY1\"}"

    @Test fun `reach records are read, replaced by newer ones, and removed by a tombstone`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val secrets = MemorySecrets()
        val key = SyncCrypto.SoftwareKey.generate()
        val p = phone(fake, key, secrets)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        assertTrue(p.view.value.reach.isEmpty())
        val six = "\"wss://relay.nekko.example/r/1\",\"ws://100.64.1.2:7777\",\"http://not-a-relay\",\"wss://b.example/r\",\"wss://c.example/r\",\"wss://d.example/r\""
        sealReach(fake, mac, mac.id, reachJson(mac.id, routes = six), 1)
        p.sync()
        val r = p.view.value.reach.single()
        assertEquals(mac.id, r.deviceId)
        assertEquals("Studio Mac", r.name)
        assertEquals("room-1", r.room)
        assertEquals("s3cr3t-pairing-secret", r.secret)
        assertEquals("HOSTKEY1", r.hostKey)
        assertEquals("main route first, only relay urls, at most 4", listOf("wss://relay.nekko.example/r/1", "ws://100.64.1.2:7777", "wss://b.example/r", "wss://c.example/r"), r.routes)
        assertFalse("the secret never prints", r.toString().contains("s3cr3t"))
        // The secret has its own sealed slot, not the plain state.
        assertFalse(secrets.items["cloud.state"]!!.contains("s3cr3t"))
        assertTrue(secrets.items["cloud.reach"]!!.contains("s3cr3t"))
        // A relaunch keeps it.
        assertEquals(1, phone(fake, key, secrets).view.value.reach.size)

        // A newer revision replaces it.
        sealReach(fake, mac, mac.id, reachJson(mac.id, name = "Studio", routes = "\"wss://x.example/r\""), 2)
        p.sync()
        assertEquals(listOf("wss://x.example/r"), p.view.value.reach.single().routes)
        assertEquals("Studio", p.view.value.reach.single().name)

        // The tombstone removes it; a replayed older record does not bring it back.
        sealReach(fake, mac, mac.id, "{\"v\":1,\"deleted\":true,\"deviceId\":\"${mac.id}\"}", 3)
        p.sync()
        assertTrue(p.view.value.reach.isEmpty())
        sealReach(fake, mac, mac.id, reachJson(mac.id), 1)
        p.sync()
        assertTrue("a replayed old revision is ignored", p.view.value.reach.isEmpty())
        assertFalse(secrets.items["cloud.reach"]!!.contains("s3cr3t"))
    }

    @Test fun `tampered, swapped, foreign-key and own reach records are ignored`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val p = phone(fake)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        val mine = p.me!!.id
        // Filed under another computer's object id (the server swapping records).
        sealReach(fake, mac, "other-1", reachJson("other-1"), 1, oid = SyncCrypto.objectId(mac.keyring, "reach", "mac-2"))
        // A flipped bit doesn't open.
        val o = SyncCrypto.objectId(mac.keyring, "reach", "mac-3")
        val raw = SyncCrypto.fromBase64url(SyncCrypto.sealRecord(mac.keyring, fake.account, 1, "reach", o, 1, reachJson("mac-3").toByteArray()))
        raw[40] = (raw[40].toInt() xor 1).toByte()
        fake.add("reach", o, 1, 1, SyncCrypto.base64url(raw))
        // This phone's own id is no computer to dial.
        sealReach(fake, mac, mine, reachJson(mine), 1)
        // Wrong shape: no relay route, an unknown version, a missing secret.
        sealReach(fake, mac, "mac-4", reachJson("mac-4", routes = "\"ftp://x\""), 1)
        sealReach(fake, mac, "mac-5", reachJson("mac-5").replace("\"v\":1", "\"v\":2"), 1)
        sealReach(fake, mac, "mac-6", reachJson("mac-6").replace(",\"secret\":\"s3cr3t-pairing-secret\"", ""), 1)
        // Sealed under a key the account doesn't hold.
        sealReach(fake, mac, "mac-7", reachJson("mac-7"), 1, keyring = SyncCrypto.Keyring(SyncCrypto.randomBytes(64)))
        p.sync()
        assertTrue(p.view.value.reach.toString(), p.view.value.reach.isEmpty())
        // One good record still lands beside them.
        sealReach(fake, mac, "mac-8", reachJson("mac-8"), 1)
        p.sync()
        assertEquals(listOf("mac-8"), p.view.value.reach.map { it.deviceId })
    }

    @Test fun `signing out hides the account's computers and forgetting everything removes them`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val secrets = MemorySecrets()
        val p = phone(fake, secrets = secrets)
        p.verifyCode("ada@example.com", "123456")
        p.restore(mac.recovery.text)
        sealReach(fake, mac, mac.id, reachJson(mac.id), 1)
        p.sync()
        assertEquals(1, p.view.value.reach.size)
        p.signOut()
        assertTrue(p.view.value.reach.isEmpty())
        assertNull(p.accountIdentity())
        p.forgetAll()
        assertNull(secrets.items["cloud.reach"])
    }

    @Test fun `the account HELLO is a fleet HELLO with an empty org id, bound to the handshake`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val p = phone(fake)
        assertNull("signed out", p.accountIdentity())
        p.verifyCode("ada@example.com", "123456")
        assertNull("not joined", p.accountIdentity())
        p.restore(mac.recovery.text)
        val id = p.accountIdentity()!!
        val me = p.me!!.id
        assertEquals("fleet:$me", id.linkDeviceId)
        val b = FleetBinding("room-1", "chal-1", "hostEph1", "clientEph1", "helloKey1")
        val fleet = id.hello(b)
        assertEquals("1", fleet["v"]!!.jsonPrimitive.content)
        assertEquals(fake.account, fleet["accountId"]!!.jsonPrimitive.content)
        assertEquals("1", fleet["keyId"]!!.jsonPrimitive.content)
        assertEquals("the account device id, with no fleet: prefix", me, fleet["deviceId"]!!.jsonPrimitive.content)
        assertEquals(setOf("v", "accountId", "keyId", "deviceId", "proof"), fleet.keys)
        val plain = Json.parseToJsonElement(
            String(FleetLink.openHelloProof(AccountKeyring(mac.keyring.bytes), fake.account, 1, me, fleet["proof"]!!.jsonPrimitive.content)),
        ) as JsonObject
        assertEquals(setOf("v", "orgId", "room", "challenge", "hostEph", "clientEph", "helloKey"), plain.keys)
        assertEquals("account scope", "", plain["orgId"]!!.jsonPrimitive.content)
        assertEquals("room-1", plain["room"]!!.jsonPrimitive.content)
        assertEquals("chal-1", plain["challenge"]!!.jsonPrimitive.content)
        assertEquals("hostEph1", plain["hostEph"]!!.jsonPrimitive.content)
        assertEquals("clientEph1", plain["clientEph"]!!.jsonPrimitive.content)
        assertEquals("helloKey1", plain["helloKey"]!!.jsonPrimitive.content)
        // Sealed for this device and account: another device id does not open it.
        fails("a proof opens for another device") { FleetLink.openHelloProof(AccountKeyring(mac.keyring.bytes), fake.account, 1, "other", fleet["proof"]!!.jsonPrimitive.content) }
        p.signOut()
        assertNull("signed out says nothing", p.accountIdentity())
    }

    @Test fun `the account refusals have plain words`() {
        for (code in listOf("fleet-off", "fleet-device", "fleet-epoch", "fleet-account", "fleet-locked", "invalid")) {
            assertNotNull(code, FleetLink.accountRefusalText(code))
            assertFalse(code, FleetLink.accountRefusalText(code)!!.contains(0x2014.toChar()))
        }
        assertEquals(DenyReason.FLEET_OFF, DenyReason.parse("fleet-off"))
        assertTrue(DenyReason.parse("fleet-epoch").isFleet)
        assertFalse(DenyReason.REVOKED.isFleet)
    }

    @Test fun `the background loop does nothing signed out, then syncs on start, on foreground and on a timer`() = runBlocking {
        val fake = FakeCloud()
        val mac = computer(fake)
        val p = phone(fake)
        assertFalse("signed out", p.syncQuietly())
        p.verifyCode("ada@example.com", "123456")
        assertFalse("signed in but not joined: it never starts a join", p.syncQuietly())
        p.restore(mac.recovery.text)
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)
        val loop = AccountSyncLoop(scope, p, intervalMs = 20)
        try {
            suspend fun until(what: String, ok: () -> Boolean) {
                repeat(200) { if (ok()) return; kotlinx.coroutines.delay(10) }
                fail(what)
            }
            sealReach(fake, mac, "mac-1", reachJson("mac-1"), 1)
            loop.start()
            until("the first sync reads the record") { p.view.value.reach.any { it.deviceId == "mac-1" } }
            // The timer picks up a later record without anyone asking.
            sealReach(fake, mac, "mac-2", reachJson("mac-2"), 1)
            until("the timer reads the next record") { p.view.value.reach.any { it.deviceId == "mac-2" } }
            loop.stop()
            sealReach(fake, mac, "mac-3", reachJson("mac-3"), 1)
            loop.onForeground()
            until("foreground reads it") { p.view.value.reach.any { it.deviceId == "mac-3" } }
        } finally {
            scope.cancel()
        }
    }
}

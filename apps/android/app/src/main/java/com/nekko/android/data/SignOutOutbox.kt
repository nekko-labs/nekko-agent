package com.nekko.android.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * *Sign out this phone* that could not reach the computer yet (SK-8). The
 * phone forgets the computer at once; what is kept here is only what it takes
 * to say `device:signOut` once more: the relay, the room and its keys, and
 * this phone's id. Nothing else about the computer (name, chats, settings)
 * survives the sign-out.
 *
 * Kept in [SecureStore] like any pairing secret, tried at every app start and
 * dropped once the computer answers, once it says this phone is already
 * unknown or revoked, after [MAX_AGE_MS] (the owner can still remove the
 * phone on the computer), or when the same computer is paired again (a later
 * delivery must never sign out the new pairing).
 */
data class PendingSignOut(
    val relayUrl: String,
    val room: String,
    val key: String,
    val keyHex: String,
    val deviceId: String,
    val at: Long,
) {
    /** Never print the secret. */
    override fun toString(): String = "PendingSignOut(room=$room, at=$at)"
}

class SignOutOutbox(private val store: SecureStore) {
    suspend fun list(): List<PendingSignOut> = decode(store.get(KEY))

    suspend fun add(p: PendingSignOut) {
        val rest = list().filterNot { it.sameComputer(p.relayUrl, p.room) }
        save(rest + p)
    }

    suspend fun remove(p: PendingSignOut) = save(list().filterNot { it.sameComputer(p.relayUrl, p.room) })

    /** The computer at [relayUrl] / [room] was paired again: its old sign-out must not reach the new pairing. */
    suspend fun cancel(relayUrl: String, room: String) {
        val all = list()
        val rest = all.filterNot { it.sameComputer(relayUrl, room) }
        if (rest.size != all.size) save(rest)
    }

    /** Drop what is older than [MAX_AGE_MS]; returns what is left. */
    suspend fun prune(now: Long): List<PendingSignOut> {
        val all = list()
        val rest = all.filter { now - it.at < MAX_AGE_MS }
        if (rest.size != all.size) save(rest)
        return rest
    }

    private fun PendingSignOut.sameComputer(url: String, r: String) = relayUrl == url && room == r

    private suspend fun save(list: List<PendingSignOut>) = store.set(KEY, if (list.isEmpty()) null else encode(list))

    companion object {
        const val KEY = "nekko.signOutOutbox"
        /** Tried for a month; after that the computer's *Paired devices* list is the place to remove the phone. */
        const val MAX_AGE_MS = 30L * 24 * 60 * 60 * 1000

        private val json = Json { ignoreUnknownKeys = true }

        internal fun encode(list: List<PendingSignOut>): String = buildJsonArray {
            list.forEach { p ->
                add(buildJsonObject {
                    put("relayUrl", p.relayUrl)
                    put("room", p.room)
                    put("key", p.key)
                    put("keyHex", p.keyHex)
                    put("deviceId", p.deviceId)
                    put("at", p.at)
                })
            }
        }.toString()

        internal fun decode(raw: String?): List<PendingSignOut> {
            val arr = raw?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() } as? JsonArray ?: return emptyList()
            return arr.mapNotNull { e ->
                val o = e as? JsonObject ?: return@mapNotNull null
                fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
                PendingSignOut(
                    relayUrl = s("relayUrl") ?: return@mapNotNull null,
                    room = s("room") ?: return@mapNotNull null,
                    key = s("key") ?: return@mapNotNull null,
                    keyHex = s("keyHex") ?: return@mapNotNull null,
                    deviceId = s("deviceId") ?: return@mapNotNull null,
                    at = (o["at"] as? JsonPrimitive)?.longOrNull ?: 0,
                )
            }
        }
    }
}

package com.nekko.android.data

import com.nekko.protocol.Activity
import com.nekko.protocol.DenyReason
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.WorkspaceFolder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** A paired computer: the non-secret half, safe to show on screen. */
data class Computer(
    val id: String,
    val name: String,
    val relayUrl: String,
    val pairedAt: Long,
    /** OS of the computer, learned from app:info once connected. */
    val platform: String? = null,
)

/** Secret half of a pairing, kept in [SecureStore] only. */
data class ComputerSecret(
    val room: String,
    val key: String,
    /** PBKDF2 output, cached so reconnecting doesn't cost a second of CPU. */
    val keyHex: String,
    /** Present until the computer welcomes us once. */
    val pair: String? = null,
) {
    /** Never print the secret. */
    override fun toString(): String = "ComputerSecret(room=$room, pair=${pair != null})"
}

data class ComputersState(
    val ready: Boolean = false,
    val computers: List<Computer> = emptyList(),
    val activeId: String? = null,
    val conn: RelayState = RelayState.IDLE,
    val connDetail: String? = null,
    val denied: DenyReason? = null,
    val summaries: List<SessionSummary> = emptyList(),
    val summariesLoading: Boolean = false,
    val providers: List<PublicProvider> = emptyList(),
    val defaults: RemoteDefaults = RemoteDefaults(),
    val models: Map<String, List<ModelInfo>> = emptyMap(),
    val workspaces: List<WorkspaceFolder> = emptyList(),
    /** Chats mid-run or waiting on an approval/answer, by session id. */
    val activity: Map<String, Activity> = emptyMap(),
    val lastError: String? = null,
) {
    val active: Computer? get() = computers.firstOrNull { it.id == activeId }
}

/** Hand-written JSON for what we persist; the app has no serialization plugin. */
internal object StoredJson {
    private val json = Json { ignoreUnknownKeys = true }

    fun encodeIndex(list: List<Computer>): String = buildJsonArray {
        list.forEach { c ->
            add(buildJsonObject {
                put("id", c.id)
                put("name", c.name)
                put("relayUrl", c.relayUrl)
                put("pairedAt", c.pairedAt)
                c.platform?.let { put("platform", it) }
            })
        }
    }.toString()

    fun decodeIndex(raw: String?): List<Computer> {
        val arr = parse(raw) as? JsonArray ?: return emptyList()
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            Computer(
                id = o.str("id") ?: return@mapNotNull null,
                name = o.str("name") ?: "My computer",
                relayUrl = o.str("relayUrl") ?: return@mapNotNull null,
                pairedAt = (o["pairedAt"] as? JsonPrimitive)?.longOrNull ?: 0,
                platform = o.str("platform"),
            )
        }
    }

    fun encodeSecret(s: ComputerSecret): String = buildJsonObject {
        put("room", s.room)
        put("key", s.key)
        put("keyHex", s.keyHex)
        s.pair?.let { put("pair", it) }
    }.toString()

    fun decodeSecret(raw: String?): ComputerSecret? {
        val o = parse(raw) as? JsonObject ?: return null
        return ComputerSecret(
            room = o.str("room") ?: return null,
            key = o.str("key") ?: return null,
            keyHex = o.str("keyHex") ?: return null,
            pair = o.str("pair"),
        )
    }

    private fun parse(raw: String?): JsonElement? =
        raw?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }

    private fun JsonObject.str(k: String): String? =
        (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
}

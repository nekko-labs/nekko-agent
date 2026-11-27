package com.nekko.android.data

import com.nekko.protocol.ProtocolCheck
import com.nekko.protocol.Activity
import com.nekko.protocol.DenyReason
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.PcSettings
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
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import com.nekko.protocol.RouteChoice

/** A paired computer: the non-secret half, safe to show on screen. */
data class Computer(
    val id: String,
    val name: String,
    val relayUrl: String,
    val pairedAt: Long,
    /** OS of the computer, learned from app:info once connected. */
    val platform: String? = null,
    /** Other addresses of the same relay, from the pairing link (AN-28). */
    val alts: List<String> = emptyList(),
    /** Its `machineIcon`, learned from app:info once connected. Null shows nothing. */
    val icon: String? = null,
    val nameIsCustom: Boolean? = null,
    /**
     * Turned off on this phone ("Connect to <name>", #2059, the iPhone's connection intent): the
     * pairing, saved chats, drafts and queued prompts stay, but the phone doesn't dial it. Null is on.
     */
    val connectionDisabled: Boolean? = null,
    /** Which kinds of route this phone dials to reach it (#3346). Saves from before this load as [RouteChoice.AUTO]. */
    val routeChoice: RouteChoice = RouteChoice.AUTO,
    /**
     * A computer of this phone's Nekko Cloud account with no pairing (decision 0126): dialed with the account
     * HELLO, never saved with the pairings, gone on sign-out. Its [relayUrl] and [alts] are its `reach` record's routes.
     */
    val fromAccount: Boolean = false,
    /**
     * Routes the computer's `reach` record adds to a paired computer (decision 0126), kept in memory only:
     * the saved pairing is never rewritten, and they go when the record is tombstoned or gone.
     */
    val accountRoutes: List<String> = emptyList(),
) {
    /**
     * The addresses this phone dials, in the pairing's order then any the account added: [routeChoice]'s kinds,
     * or all when that leaves none.
     */
    val routes: List<String> get() = routeChoice.filter((listOf(relayUrl) + alts + accountRoutes).distinct())
}

/** Secret half of a pairing, kept in [SecureStore] only. */
data class ComputerSecret(
    val room: String,
    val key: String,
    /** PBKDF2 output, cached so reconnecting doesn't cost a second of CPU. */
    val keyHex: String,
    /** Present until the computer welcomes us once. */
    val pair: String? = null,
    /** The computer's public key, pinned from the pairing link; older pairings have none (decision 0041). */
    val hostKey: String? = null,
    /** [com.nekko.protocol.E2E.PAIRING_VERSION] when saved; older pairings must pair again (decisions 0036, 0041). */
    val version: Int = com.nekko.protocol.E2E.PAIRING_VERSION,
) {
    /** The key to dial with; null when this pairing must be made again, since a first-seen key is never trusted. */
    val pin: String? get() = hostKey.takeIf { version >= com.nekko.protocol.E2E.PAIRING_VERSION }

    /** Never print the secret. */
    override fun toString(): String = "ComputerSecret(room=$room, pair=${pair != null})"
}

data class ComputersState(
    val ready: Boolean = false,
    val computers: List<Computer> = emptyList(),
    val activeId: String? = null,
    val conn: RelayState = RelayState.IDLE,
    val connDetail: String? = null,
    /** The relay address in use or being dialed, one of the active computer's routes. */
    val route: String? = null,
    val denied: DenyReason? = null,
    val summaries: List<SessionSummary> = emptyList(),
    /** The sub-agents each of the active computer's chats spawned and hasn't completed, oldest first, by parent id (#2509). */
    val subagents: Map<String, List<SessionSummary>> = emptyMap(),
    val summariesLoading: Boolean = false,
    /** The active computer's own list has been read since it became active (not the phone's saved copy). */
    val summariesLoaded: Boolean = false,
    val providers: List<PublicProvider> = emptyList(),
    val defaults: RemoteDefaults = RemoteDefaults(),
    /** The computer's phone-settable settings (Settings → On <computer>); defaults until it answers. */
    val pcSettings: PcSettings = PcSettings(),
    val models: Map<String, List<ModelInfo>> = emptyMap(),
    /** Why a provider's models could not be listed, by provider id. */
    val modelErrors: Map<String, String> = emptyMap(),
    val workspaces: List<WorkspaceFolder> = emptyList(),
    /** Chats mid-run or waiting on an approval/answer, by session id. */
    val activity: Map<String, Activity> = emptyMap(),
    /** Authoritative waiting inputs for local alerts and launcher badges, independent of the open chat. */
    val attention: AttentionState = AttentionState(),
    val lastError: String? = null,
    /** When the list on screen is the phone's saved copy, when it was saved; null once the computer answers. */
    val savedListAt: Long? = null,
    /** The computer lets a phone quit Nekko Agent there (`app:info` `quitFromPhone`, SK-3); false until it says. */
    val quitFromPhone: Boolean = false,
    /** Explicit app:info capability; absent/older hosts never infer support. */
    val imageGeneration: Boolean = false,
    /** When this phone stopped remote access on the active computer (SK-8); null otherwise. */
    val remoteStoppedAt: Long? = null,
    /** When this phone quit Nekko Agent on the active computer (SK-8); null otherwise. */
    val remoteQuitAt: Long? = null,
    /** The active computer's phone protocol from its welcome (IO-32); null until it has welcomed this phone. */
    val hostProtocol: Int? = null,
    /**
     * Every paired computer but the active one, kept connected beside it
     * (2026-11-05, the iPhone's fleet): its state, chats, folders and which
     * chats run or need you. Empty unless the repository stays connected.
     */
    val peers: Map<String, Peer> = emptyMap(),
) {
    val active: Computer? get() = computers.firstOrNull { it.id == activeId }

    /** A computer's connection state, active or not. */
    fun connOf(id: String): RelayState = if (id == activeId) conn else peers[id]?.conn ?: RelayState.IDLE

    /** The relay keeps closing on a bad pairing key: not a denial (it isn't sealed), but worth asking to pair again. */
    val badKey: Boolean get() = connDetail == RelayStatus.BAD_KEY && conn != RelayState.IDLE

    /** Which side to update when the phone and the computer speak different versions. */
    val protocolCheck: ProtocolCheck get() = ProtocolCheck.compare(hostProtocol)
}

/** What the phone knows about one paired computer that isn't the active one. */
data class Peer(
    val conn: RelayState = RelayState.CONNECTING,
    val detail: String? = null,
    val denied: DenyReason? = null,
    val summaries: List<SessionSummary> = emptyList(),
    /** Its chats' running sub-agents, by parent id (#2509). */
    val subagents: Map<String, List<SessionSummary>> = emptyMap(),
    val activity: Map<String, Activity> = emptyMap(),
    val workspaces: List<WorkspaceFolder> = emptyList(),
    /** The computer answered on this link (not only a saved list). */
    val loaded: Boolean = false,
    /** The list shown is the phone's saved copy, from then. */
    val savedAt: Long? = null,
    /** What waits there, as the reconnect read settles "Needs you" (the active computer's [AttentionState]). */
    val attention: AttentionState = AttentionState(),
)

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
                if (c.alts.isNotEmpty()) put("alts", buildJsonArray { c.alts.forEach { add(JsonPrimitive(it)) } })
                c.icon?.let { put("icon", it) }
                c.nameIsCustom?.let { put("nameIsCustom", it) }
                if (c.connectionDisabled == true) put("connectionDisabled", true)
                if (c.routeChoice != RouteChoice.AUTO) put("routeChoice", c.routeChoice.wire)
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
                alts = (o["alts"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty(),
                icon = o.str("icon"),
                nameIsCustom = (o["nameIsCustom"] as? JsonPrimitive)?.booleanOrNull,
                connectionDisabled = (o["connectionDisabled"] as? JsonPrimitive)?.booleanOrNull?.takeIf { it },
                routeChoice = RouteChoice.parse(o.str("routeChoice")),
            )
        }
    }

    fun encodeSecret(s: ComputerSecret): String = buildJsonObject {
        put("room", s.room)
        put("key", s.key)
        put("keyHex", s.keyHex)
        s.pair?.let { put("pair", it) }
        s.hostKey?.let { put("hostKey", it) }
        put("v", s.version)
    }.toString()

    fun decodeSecret(raw: String?): ComputerSecret? {
        val o = parse(raw) as? JsonObject ?: return null
        return ComputerSecret(
            room = o.str("room") ?: return null,
            key = o.str("key") ?: return null,
            keyHex = o.str("keyHex") ?: return null,
            pair = o.str("pair"),
            hostKey = o.str("hostKey"),
            // Saved before the relay credential was derived: 1.
            version = (o["v"] as? JsonPrimitive)?.intOrNull ?: 1,
        )
    }

    private fun parse(raw: String?): JsonElement? =
        raw?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }

    private fun JsonObject.str(k: String): String? =
        (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
}

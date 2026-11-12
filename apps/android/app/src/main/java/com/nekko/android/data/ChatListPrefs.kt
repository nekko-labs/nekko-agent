package com.nekko.android.data

import com.nekko.protocol.ChatListView
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** The chat list's view menu and group order: phone preferences, as on the iPhone, never sent to the computer. */
object ChatListPrefs {
    /** Group by, sort by and what is shown ([ChatListView], the iPhone's encoding). */
    val VIEW: PhonePrefs.Key<ChatListView> = PhonePrefs.key("chatList.view", ChatListView.STANDARD, { it.encoded() }, { ChatListView.parse(it) })

    /** Per computer id: its project groups' order as arranged on this phone (folder ids and General). */
    val GROUP_ORDER: PhonePrefs.Key<Map<String, List<String>>> = PhonePrefs.key(
        "chatList.groupOrder",
        emptyMap(),
        { m -> JsonObject(m.mapValues { (_, keys) -> JsonArray(keys.map(::JsonPrimitive)) }).toString() },
        { raw ->
            (Json.parseToJsonElement(raw) as? JsonObject)?.mapValues { (_, v) ->
                (v as? JsonArray)?.mapNotNull { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }.orEmpty()
            }
        },
    )

    /**
     * The groups opened on this phone, by their stable key (the iPhone's `openedChatGroups`, #2107):
     * groups start folded, as on the iPhone. Kept across leaving the list and cold launches.
     * Anything unreadable reads as none opened. Replaces `chatList.collapsedGroups` (#2133, when
     * groups started open), which is no longer read: every group starts folded once.
     */
    val OPENED_GROUPS: PhonePrefs.Key<Set<String>> = PhonePrefs.key(
        "chatList.openedGroups",
        emptySet(),
        { keys -> JsonArray(keys.sorted().map(::JsonPrimitive)).toString() },
        { raw ->
            (runCatching { Json.parseToJsonElement(raw) }.getOrNull() as? JsonArray)
                ?.mapNotNull { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }?.toSet()
        },
    )

    /** [keys] after a tap on [key]'s header. */
    fun toggled(keys: Set<String>, key: String): Set<String> = if (key in keys) keys - key else keys + key
}

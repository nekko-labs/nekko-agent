package com.nekko.android.data

import com.nekko.protocol.Activity
import com.nekko.protocol.ChatPlace
import com.nekko.protocol.ComputerColors
import com.nekko.protocol.PhoneChat
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.WorkspaceFolder

/**
 * The chat list across every paired computer and this phone (#2108, the iPhone's
 * `Fleet.chats(on:)` with `PhoneChats.summaries`): the active computer's chats first,
 * then each other computer's in pairing order, then the phone's.
 */
data class AllChats(
    val chats: List<SessionSummary>,
    /** Running or waiting, by chat id; the first place to say wins. */
    val activity: Map<String, Activity>,
    /** Project folders, each id once. */
    val folders: List<WorkspaceFolder>,
    /** Where each chat runs: a computer id or [ChatPlace.PHONE]. */
    val owners: Map<String, String>,
    /** Every place the list can show: the computers in pairing order, then the phone once it is set up. */
    val places: List<ChatPlace>,
    /** The places shown now: all of them, or the one the list is filtered to. */
    val shown: List<ChatPlace>,
) {
    fun placeOf(chat: SessionSummary): String? = owners[chat.id]

    /** A chat's place, by id, when the list holds more than one (the row says where it runs). */
    fun place(chatId: String): ChatPlace? = owners[chatId]?.let { id -> places.firstOrNull { it.id == id } }

    /** The chats on one computer, for what is asked of that computer only (PR chips). */
    fun on(placeId: String): List<SessionSummary> = chats.filter { owners[it.id] == placeId }

    companion object {
        /**
         * [filter] is a place id, or null for every place; one that no longer exists shows every place.
         * [phoneName] is this phone's name in the phone's language ("This phone").
         */
        fun of(
            s: ComputersState,
            phoneChats: List<PhoneChat>,
            phoneRunning: Set<String>,
            phoneSetUp: Boolean,
            filter: String?,
            phoneName: String,
        ): AllChats {
            val places = s.computers.mapIndexed { i, c -> ChatPlace(c.id, c.name, c.icon, ComputerColors.computer(i)) } +
                if (phoneSetUp || phoneChats.isNotEmpty()) listOf(ChatPlace(ChatPlace.PHONE, phoneName)) else emptyList()
            val shown = places.filter { it.id == filter }.ifEmpty { places }
            val wanted = shown.map { it.id }.toSet()
            val chats = ArrayList<SessionSummary>()
            val owners = HashMap<String, String>()
            val activity = HashMap<String, Activity>()
            val folders = LinkedHashMap<String, WorkspaceFolder>()
            // The active computer first, as the list was; then the others in pairing order.
            val order = listOfNotNull(s.activeId) + s.computers.map { it.id }.filter { it != s.activeId }
            for (id in order) {
                if (id !in wanted) continue
                val (list, act, dirs) = if (id == s.activeId) Triple(s.summaries, s.activity, s.workspaces)
                    else s.peers[id]?.let { Triple(it.summaries, it.activity, it.workspaces) } ?: continue
                for (c in list) if (owners.putIfAbsent(c.id, id) == null) chats += c
                act.forEach { (k, v) -> activity.putIfAbsent(k, v) }
                dirs.forEach { folders.putIfAbsent(it.id, it) }
            }
            if (ChatPlace.PHONE in wanted) {
                for (c in phoneChats.sortedByDescending { it.updatedAt }) {
                    if (owners.putIfAbsent(c.id, ChatPlace.PHONE) != null) continue
                    chats += summary(c)
                    if (c.id in phoneRunning) activity[c.id] = Activity.RUNNING
                }
            }
            return AllChats(chats, activity, folders.values.toList(), owners, places, shown)
        }

        /** A phone chat as a row of the list. */
        fun summary(c: PhoneChat): SessionSummary = SessionSummary(
            id = c.id,
            title = c.title,
            updatedAt = c.updatedAt,
            modelId = c.modelId,
            lastReplyText = c.messages.lastOrNull { it.role == "assistant" && it.text.isNotBlank() }?.text,
            firstUserText = c.messages.firstOrNull { it.role == "user" }?.text,
            archived = false,
            parentSessionId = null,
            taskId = null,
            trainingRunId = null,
            providerId = c.providerId,
            exchangeCount = c.messages.count { it.role == "user" }.toLong(),
        )
    }
}

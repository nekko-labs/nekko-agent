package com.nekko.android.data

import com.nekko.protocol.Channels
import com.nekko.protocol.FinderChat
import com.nekko.protocol.FinderSearch
import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.SessionSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

/**
 * What chats said, for the chat list's search inside messages (#3448): read
 * from each chat's computer with `sessions:finderText`, [FinderSearch.BATCH]
 * chats at a time, only while someone searches. A chat is read again once it
 * has moved on (its summary's `updatedAt`). A computer that doesn't have the
 * channel (an older Nekko Agent) is not asked again: its chats are searched by
 * their summaries only, as before.
 */
class FinderTexts {
    private val _texts = MutableStateFlow<Map<String, FinderChat>>(emptyMap())
    val texts: StateFlow<Map<String, FinderChat>> = _texts.asStateFlow()

    /** The summary's `updatedAt` each held text was read at. */
    private val readAt = mutableMapOf<String, Long>()
    private val unsupported = mutableSetOf<String>()

    /** The chats of [computer] whose text is not held, or older than the chat. Newest first. */
    @Synchronized fun due(computer: String, chats: List<SessionSummary>): List<SessionSummary> =
        if (computer in unsupported) emptyList()
        else chats.filter { readAt[it.id] != it.updatedAt }.sortedByDescending { it.updatedAt }

    @Synchronized private fun keep(read: Map<String, FinderChat>, at: Map<String, Long>) {
        for ((id, chat) in read) readAt[id] = at[id] ?: continue
        _texts.update { it + read }
    }

    @Synchronized private fun refuse(computer: String) { unsupported += computer }

    /** Read the due chats of [computer] over [caller]. Stops at the first failure; what was read stays. */
    suspend fun load(computer: String, chats: List<SessionSummary>, caller: Caller) {
        var due = due(computer, chats)
        while (due.isNotEmpty() && currentCoroutineContext().isActive) {
            val batch = due.take(FinderSearch.BATCH)
            val reply = try {
                caller.call(Channels.SESSIONS_FINDER_TEXT, JsonArray(batch.map { JsonPrimitive(it.id) }))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (PhoneRefusal.parse(e.message)?.code == "channel-denied") refuse(computer)
                return
            }
            val read = FinderChat.parse(reply).filterKeys { id -> batch.any { it.id == id } }
            // A reply that answered nothing would ask the same chats forever.
            if (read.isEmpty()) return
            keep(read, batch.associate { it.id to it.updatedAt })
            due = due.filter { it.id !in read }
        }
    }

    /** Another set of computers: their chats' text is not this one's. */
    @Synchronized fun clear() {
        readAt.clear()
        unsupported.clear()
        _texts.value = emptyMap()
    }
}

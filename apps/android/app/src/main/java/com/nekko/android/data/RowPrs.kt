package com.nekko.android.data

import com.nekko.protocol.Channels
import com.nekko.protocol.PullRequest
import com.nekko.protocol.SessionSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.serialization.json.JsonPrimitive

/**
 * The state of the PRs each chat row names (`pr:sessionList`), for the row's PR
 * chip: the iPhone's `loadRowPrs`, so a row reads "#12 merged +1" as the
 * desktop's agent card does. Asked [BATCH] chats at a time, and again after
 * [FRESH_MS], or sooner when the chat moves on or names another PR.
 */
class RowPrs(private val now: () -> Long = System::currentTimeMillis) {
    private val _byChat = MutableStateFlow<Map<String, List<PullRequest>>>(emptyMap())
    val byChat: StateFlow<Map<String, List<PullRequest>>> = _byChat.asStateFlow()

    private data class Asked(val urls: List<String>, val at: Long)
    private val asked = mutableMapOf<String, Asked>()

    /** The chats whose PRs are due a lookup: they name one, and were not asked about lately with the same links. Newest first. */
    @Synchronized fun due(chats: List<SessionSummary>): List<SessionSummary> {
        val t = now()
        return chats.filter { s ->
            if (s.prUrls.isEmpty()) return@filter false
            val a = asked[s.id] ?: return@filter true
            a.urls != s.prUrls || s.updatedAt > a.at || t - a.at > FRESH_MS
        }.sortedByDescending { it.updatedAt }
    }

    @Synchronized private fun mark(ids: List<SessionSummary>, at: Long) { ids.forEach { asked[it.id] = Asked(it.prUrls, at) } }

    @Synchronized private fun forget(id: String) { asked.remove(id) }

    /** Look up the PRs of the due chats on the computer that lists them. A failed lookup is asked again next time. */
    suspend fun load(chats: List<SessionSummary>, caller: Caller) {
        for (batch in due(chats).chunked(BATCH)) {
            if (!currentCoroutineContext().isActive) return
            // Marked asked as it goes out, so a cancelled walk leaves the rest due.
            mark(batch, now())
            val results = coroutineScope {
                batch.map { s ->
                    async {
                        s.id to try {
                            PullRequest.list(caller.call(Channels.PR_SESSION_LIST, JsonPrimitive(s.id), JsonPrimitive(false)))
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            null
                        }
                    }
                }.awaitAll()
            }
            for ((id, prs) in results) {
                if (prs != null) _byChat.update { it + (id to prs) } else forget(id)
            }
        }
    }

    /** Another computer's list: its chats' PRs are not this one's. */
    @Synchronized fun clear() {
        asked.clear()
        _byChat.value = emptyMap()
    }

    companion object {
        const val BATCH = 8
        const val FRESH_MS = 5 * 60 * 1000L
    }
}

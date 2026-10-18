package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The phone's own copy of one computer's chat list, kept only when the user
 * turns on *Keep the chat list when offline* (off by default). The same shape
 * as the iPhone app's `SavedChatList`: each visible chat's id, title, times,
 * folder and manual order, plus the folder names. Never replies, first
 * messages, models or anything a chat contains.
 */
data class SavedChatList(val savedAt: Long, val summaries: List<SessionSummary>, val folders: List<WorkspaceFolder>) {
    fun json(): JsonElement = buildJsonObject {
        put("v", VERSION)
        put("savedAt", savedAt)
        put("chats", JsonArray(summaries.map { s ->
            buildJsonObject {
                put("id", s.id)
                put("title", s.title)
                put("updatedAt", s.updatedAt)
                s.workspaceId?.let { put("workspaceId", it) }
                s.archivedAt?.let { put("archivedAt", it) }
                s.order?.let { put("order", JsonPrimitive(it)) }
            }
        }))
        put("folders", buildJsonArray {
            folders.forEach { f -> add(buildJsonObject { put("id", f.id); put("name", f.name) }) }
        })
    }

    companion object {
        /** Bumped when the shape changes; an older or newer file is ignored, not misread. */
        const val VERSION = 1L

        fun from(e: JsonElement?): SavedChatList? {
            val o = e.obj() ?: return null
            if (o.long("v") != VERSION) return null
            val savedAt = o.long("savedAt") ?: return null
            return SavedChatList(savedAt, SessionSummary.visible(o["chats"]), WorkspaceFolder.list(o["folders"]))
        }
    }
}

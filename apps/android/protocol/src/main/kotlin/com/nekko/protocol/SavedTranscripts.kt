package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One chat as the phone last read it, kept to read while the computer is out of reach (OF-5). */
data class SavedTranscript(val savedAt: Long, val session: Session) {
    /**
     * What is written: the chat's title, model, folder, tool policy and
     * messages as the phone shows them. Photos never: a message keeps only how
     * many it had (`imageCount`). Not the queue, the running state or the
     * prompt ids, which only the computer can say now.
     */
    fun json(): JsonObject = buildJsonObject {
        put("v", VERSION)
        put("savedAt", savedAt)
        put("session", sessionJson(session.messages, session.omittedMessages))
    }

    internal fun sessionJson(messages: List<ChatMessage>, omitted: Int): JsonObject = buildJsonObject {
        val s = session
        put("id", s.id)
        put("title", s.title)
        put("updatedAt", s.updatedAt)
        s.providerId?.let { put("providerId", it) }
        s.modelId?.let { put("modelId", it) }
        s.workspaceId?.let { put("workspaceId", it) }
        s.mode?.let { put("mode", it.wire) }
        s.effort?.let { put("effort", it) }
        if (omitted > 0) put("omittedMessages", omitted)
        put("messages", JsonArray(messages.map { it.savedJson() }))
    }

    companion object {
        /** Bumped when the shape changes; an older or newer file is ignored, not misread. */
        const val VERSION = 1L

        fun from(e: JsonElement?): SavedTranscript? {
            val o = e.obj() ?: return null
            if (o.long("v") != VERSION) return null
            val at = o.long("savedAt") ?: return null
            return SavedTranscript(at, Session.from(o["session"]) ?: return null)
        }
    }
}

/** The message as `ChatMessage.from` reads it back, without photo data. */
fun ChatMessage.savedJson(): JsonObject = buildJsonObject {
    put("id", id)
    put("role", role)
    put("content", content)
    reasoning?.let { put("reasoning", it) }
    createdAt?.let { put("createdAt", it) }
    if (imageCount > 0) put("imageCount", imageCount)
    skill?.let { (name, input) -> put("skill", buildJsonObject { put("name", name); put("input", input) }) }
    if (toolCalls.isNotEmpty()) {
        put("toolCalls", JsonArray(toolCalls.map { c -> buildJsonObject { put("id", c.id); put("name", c.name); put("input", c.input) } }))
    }
    toolResult?.let { r ->
        put("toolResult", buildJsonObject {
            put("toolCallId", r.toolCallId)
            put("output", r.output)
            if (r.isError) put("isError", true)
            r.outputChars?.let { put("truncated", true); put("outputChars", it) }
            if (r.omittedImages > 0) put("omittedImages", r.omittedImages)
        })
    }
    if (interrupted) put("interrupted", true)
}

/**
 * The active computer's saved chats: the last [maxChats] opened, at most
 * [maxBytes] together and [maxChatBytes] each (a longer chat keeps its newest
 * messages). The least recently opened goes first. Saved each time the
 * computer answers for an open chat; nothing is kept while [files] is null
 * (*Keep recent chats to read offline*, on by default). The iPhone's
 * `SavedTranscripts` (NekkoKit/SavedTranscripts.swift).
 */
class SavedTranscripts(
    private val maxChats: Int = DEFAULT_MAX_CHATS,
    private val maxBytes: Int = DEFAULT_MAX_BYTES,
    maxChatBytes: Int = DEFAULT_MAX_CHAT_BYTES,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val maxChatBytes = minOf(maxChatBytes, maxBytes)

    internal data class Entry(val id: String, val file: String, val openedAt: Long, val bytes: Int, val hash: String)

    var files: OfflineFiles? = null
        private set
    var computerId: String? = null
        private set
    /** Most recently opened first. */
    private var entries: List<Entry> = emptyList()

    /** The chats saved for the active computer, most recently opened first. */
    val chatIds: List<String> @Synchronized get() = entries.map { it.id }

    /** Bytes on disk for the active computer. */
    val totalBytes: Int @Synchronized get() = entries.sumOf { it.bytes }

    /** Keep chats in [files] (null: keep none), for [computerId]. */
    @Synchronized
    fun use(files: OfflineFiles?, computerId: String?) {
        this.files = files
        load(computerId)
    }

    /** Show [computerId]'s saved chats. */
    @Synchronized
    fun load(computerId: String?) {
        this.computerId = computerId
        entries = emptyList()
        val f = files ?: return
        val v = computerId?.let { f.load(it, INDEX) }.obj() ?: return
        if (v.long("v") != INDEX_VERSION) return
        entries = v["chats"].arr()?.mapNotNull { e ->
            val o = e.obj() ?: return@mapNotNull null
            Entry(o.str("id") ?: return@mapNotNull null, o.str("file") ?: return@mapNotNull null, o.long("openedAt") ?: 0, o.long("bytes")?.toInt() ?: 0, o.str("hash") ?: "")
        }?.sortedByDescending { it.openedAt } ?: emptyList()
    }

    /** The saved copy of [chatId], if there is one. */
    @Synchronized
    fun saved(chatId: String): SavedTranscript? {
        val f = files ?: return null
        val id = computerId ?: return null
        val e = entries.firstOrNull { it.id == chatId } ?: return null
        return SavedTranscript.from(f.load(id, e.file))?.takeIf { it.session.id == chatId }
    }

    /** The saved copy was opened: it is the most recent now. */
    @Synchronized
    fun touch(chatId: String) {
        if (entries.none { it.id == chatId }) return
        entries = entries.map { if (it.id == chatId) it.copy(openedAt = now()) else it }.sortedByDescending { it.openedAt }
        writeIndex()
    }

    /** Keep [session] as the chat's saved copy (the computer just sent it). */
    @Synchronized
    fun save(session: Session) {
        val f = files ?: return
        val id = computerId ?: return
        val at = now()
        val encoded = encode(SavedTranscript(at, session), maxChatBytes)
        if (encoded == null) {
            // One message bigger than a whole chat may be: better none than a misleading part.
            remove(session.id)
            return
        }
        val (text, hash) = encoded
        val file = fileName(session.id)
        val same = entries.firstOrNull { it.id == session.id }?.hash == hash
        entries = if (same) {
            // The same chat as last time: only the order changes.
            entries.map { if (it.id == session.id) it.copy(openedAt = at) else it }
        } else {
            f.save(id, file, WireJson.parseToJsonElement(text))
            entries.filterNot { it.id == session.id } + Entry(session.id, file, at, text.toByteArray().size, hash)
        }.sortedByDescending { it.openedAt }
        evict()
        writeIndex()
    }

    /** The chat is gone (deleted here or on the computer). */
    @Synchronized
    fun remove(chatId: String) {
        val f = files ?: return
        val id = computerId ?: return
        val e = entries.firstOrNull { it.id == chatId } ?: return
        f.removeFile(id, e.file)
        entries = entries - e
        writeIndex()
    }

    /** Only chats the computer still has stay (its full list just arrived). */
    @Synchronized
    fun keepOnly(ids: Set<String>) {
        val f = files ?: return
        val id = computerId ?: return
        val gone = entries.filter { it.id !in ids }
        if (gone.isEmpty()) return
        gone.forEach { f.removeFile(id, it.file) }
        entries = entries - gone.toSet()
        writeIndex()
    }

    private fun evict() {
        val f = files ?: return
        val id = computerId ?: return
        val kept = ArrayList<Entry>()
        var bytes = 0
        for (e in entries) {
            if (kept.size < maxChats && bytes + e.bytes <= maxBytes) {
                kept += e
                bytes += e.bytes
            } else {
                f.removeFile(id, e.file)
            }
        }
        entries = kept
    }

    private fun writeIndex() {
        val f = files ?: return
        val id = computerId ?: return
        f.save(id, INDEX, buildJsonObject {
            put("v", INDEX_VERSION)
            put("chats", JsonArray(entries.map { e ->
                buildJsonObject {
                    put("id", e.id); put("file", e.file); put("openedAt", e.openedAt); put("bytes", e.bytes); put("hash", e.hash)
                }
            }))
        })
    }

    companion object {
        const val DEFAULT_MAX_CHATS = 20
        const val DEFAULT_MAX_BYTES = 5 * 1024 * 1024
        const val DEFAULT_MAX_CHAT_BYTES = 1024 * 1024
        const val INDEX = "transcripts"
        const val INDEX_VERSION = 1L

        /**
         * The copy as written, within [limit] bytes, and a hash of the chat in it
         * (not the time) to tell a changed chat from the same one. A longer chat
         * drops its oldest messages, counted with the ones the computer already
         * left out. Null when even the newest message is too big.
         */
        internal fun encode(t: SavedTranscript, limit: Int): Pair<String, String>? {
            var messages = t.session.messages
            var omitted = t.session.omittedMessages
            while (true) {
                val session = t.sessionJson(messages, omitted)
                val text = buildJsonObject {
                    put("v", SavedTranscript.VERSION)
                    put("savedAt", t.savedAt)
                    put("session", session)
                }.toString()
                if (text.toByteArray().size <= limit) return text to hash(session.toString().toByteArray())
                if (messages.size <= 1) return null
                val drop = maxOf(1, messages.size / 8)
                messages = messages.drop(drop)
                omitted += drop
            }
        }

        /** FNV-1a, 64 bits, as hex: a file name and a change check, not security. */
        fun hash(data: ByteArray): String {
            var h = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
            for (b in data) {
                h = h xor (b.toLong() and 0xff)
                h *= 0x100000001b3L
            }
            return java.lang.Long.toUnsignedString(h, 16)
        }

        /** One file per chat, named from its id (the index keeps the id itself). */
        fun fileName(chatId: String): String = "chat-" + hash(chatId.toByteArray())
    }
}

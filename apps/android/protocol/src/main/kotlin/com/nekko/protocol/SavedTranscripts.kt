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
        s.chatType?.let { put("chatType", it) }
        // Preserve even unsignable saved params verbatim; never turn an offline image chat into text.
        s.imageParams?.let { params ->
            put("imageParams", buildJsonObject {
                params.modelId?.let { put("modelId", it) }
                fun number(key: String, n: Double) { if (n.isFinite()) put(key, n) else put(key, kotlinx.serialization.json.JsonNull) }
                number("width", params.width); number("height", params.height); number("steps", params.steps)
                number("cfgScale", params.cfgScale); number("seed", params.seed)
            })
        }
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
    // The narrow projection only: counts and identifiers, never the provider's raw payload.
    turnStats?.let { put("turnStats", it.json()) }
}

/**
 * The active computer's saved chats: the last [maxChats] opened, at most
 * [maxBytes] together and [maxChatBytes] each (a longer chat keeps its newest
 * messages). The least recently opened goes first. Saved each time the
 * computer answers for an open chat; nothing is kept while [files] is null
 * (*Keep recent chats to read offline*, on by default). The iPhone's
 * `SavedTranscripts` (NekkoKit/SavedTranscripts.swift).
 *
 * With an [io] queue, saving never costs the caller more than filing the chat away (#3413): a chat
 * whose messages, last message and update time are unchanged since the last save only moves to the
 * front, and any other is queued; the newest copy per chat is encoded, hashed and written on the
 * queue about a quarter of a second later, so a burst of re-reads is one write. Removals and the
 * index follow on the same queue, in order. [chatIds] and [totalBytes] follow when the write lands;
 * [flush] waits for it. Without an [io] queue everything happens on the caller's thread.
 */
class SavedTranscripts(
    private val maxChats: Int = DEFAULT_MAX_CHATS,
    private val maxBytes: Int = DEFAULT_MAX_BYTES,
    maxChatBytes: Int = DEFAULT_MAX_CHAT_BYTES,
    private val io: BackgroundIO? = null,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val maxChatBytes = minOf(maxChatBytes, maxBytes)

    /** [sig] says what the chat looked like when this copy was written; not kept in the file, so the first save after a start always writes. */
    internal data class Entry(val id: String, val file: String, val openedAt: Long, val bytes: Int, val hash: String, val sig: String? = null)

    /** A save waiting for the queue, with where it goes (the computer can change before it runs). */
    private class Job(val files: OfflineFiles, val computerId: String, val session: Session)

    @Volatile var files: OfflineFiles? = null
        private set
    @Volatile var computerId: String? = null
        private set
    /** Most recently opened first. Written only under [lock]; read without it. */
    @Volatile private var entries: List<Entry> = emptyList()

    /** Held for each change to [entries] and the files they name, so a queued job and a caller never interleave. */
    private val lock = Any()
    private val writer = CoalescedWriter<Job>(io) { _, job -> saveNow(job.files, job.computerId, job.session) }

    /** The chats saved for the active computer, most recently opened first. */
    val chatIds: List<String> get() = entries.map { it.id }

    /** Bytes on disk for the active computer. */
    val totalBytes: Int get() = entries.sumOf { it.bytes }

    /** Keep chats in [files] (null: keep none), for [computerId]. */
    fun use(files: OfflineFiles?, computerId: String?) {
        writer.cancelAll()
        synchronized(lock) {
            this.files = files
            load(computerId)
        }
    }

    /** Show [computerId]'s saved chats. */
    fun load(computerId: String?) {
        writer.cancelAll()
        synchronized(lock) {
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
    }

    /** The saved copy of [chatId], if there is one (the newest one still waiting to be written first). */
    fun saved(chatId: String): SavedTranscript? {
        // Read back the way a file would be, so a copy still waiting to be written shows the same.
        writer.pending(chatId)?.let { return SavedTranscript.from(SavedTranscript(now(), it.session).json()) }
        val f = files ?: return null
        val id = computerId ?: return null
        val e = entries.firstOrNull { it.id == chatId } ?: return null
        return SavedTranscript.from(f.load(id, e.file))?.takeIf { it.session.id == chatId }
    }

    /** The saved copy was opened: it is the most recent now. */
    fun touch(chatId: String) {
        val f = files ?: return
        val id = computerId ?: return
        if (entries.none { it.id == chatId }) return
        ordered { touchNow(f, id, chatId) }
    }

    /** Keep [session] as the chat's saved copy (the computer just sent it). */
    fun save(session: Session) {
        val f = files ?: return
        val id = computerId ?: return
        val sig = signature(session)
        val known = entries.firstOrNull { it.id == session.id }
        if (known?.sig == sig && writer.pending(session.id) == null) {
            // The same chat as last time: only the order changes.
            ordered { touchNow(f, id, session.id) }
            return
        }
        writer.submit(session.id, Job(f, id, session))
    }

    /** The chat is gone (deleted here or on the computer). */
    fun remove(chatId: String) {
        writer.cancel(chatId)
        val f = files ?: return
        val id = computerId ?: return
        ordered { removeNow(f, id, chatId) }
    }

    /** Only chats the computer still has stay (its full list just arrived). */
    fun keepOnly(ids: Set<String>) {
        val f = files ?: return
        val id = computerId ?: return
        // A chat still waiting to be written is one the computer no longer has: it must not come back.
        entries.filter { it.id !in ids }.forEach { writer.cancel(it.id) }
        ordered { keepOnlyNow(f, id, ids) }
    }

    /** Hand every save still waiting to the queue now (the app is going to the background). */
    fun flushNow() = writer.flushNow()

    /** Hand every save still waiting to the queue and wait for the queue to finish (for tests). */
    fun flush() {
        writer.flushNow()
        io?.waitUntilIdle()
    }

    private fun ordered(work: () -> Unit) {
        if (io == null) synchronized(lock) { work() } else io.run { synchronized(lock) { work() } }
    }

    /** A cheap stand-in for "this chat as last saved": its size, last message, update time, settings and amount of text. */
    private fun signature(s: Session): String {
        val last = s.messages.lastOrNull()
        var chars = 0L
        for (m in s.messages) chars += m.content.length + (m.reasoning?.length ?: 0) + (m.toolResult?.output?.length ?: 0)
        return listOf(s.messages.size, last?.id, last?.content?.hashCode(), last?.toolResult?.output?.hashCode(), s.updatedAt, s.omittedMessages, chars,
            s.title, s.providerId, s.modelId, s.workspaceId, s.mode, s.effort, s.chatType, s.imageParams).joinToString("|")
    }

    private fun current(f: OfflineFiles, id: String) = files === f && computerId == id

    private fun saveNow(f: OfflineFiles, id: String, session: Session) {
        val at = now()
        val encoded = encode(SavedTranscript(at, session), maxChatBytes)
        synchronized(lock) {
            // The computer or the setting changed while this waited: it is not this save's any more.
            if (!current(f, id)) return
            if (encoded == null) {
                // One message bigger than a whole chat may be: better none than a misleading part.
                removeNow(f, id, session.id)
                return
            }
            val (text, hash) = encoded
            val file = fileName(session.id)
            val same = entries.firstOrNull { it.id == session.id }?.hash == hash
            val sig = signature(session)
            entries = if (same) {
                entries.map { if (it.id == session.id) it.copy(openedAt = at, sig = sig) else it }
            } else {
                f.save(id, file, WireJson.parseToJsonElement(text))
                entries.filterNot { it.id == session.id } + Entry(session.id, file, at, text.toByteArray().size, hash, sig)
            }.sortedByDescending { it.openedAt }
            evict(f, id)
            writeIndex(f, id)
        }
    }

    private fun touchNow(f: OfflineFiles, id: String, chatId: String) {
        if (!current(f, id) || entries.none { it.id == chatId }) return
        entries = entries.map { if (it.id == chatId) it.copy(openedAt = now()) else it }.sortedByDescending { it.openedAt }
        writeIndex(f, id)
    }

    private fun removeNow(f: OfflineFiles, id: String, chatId: String) {
        if (!current(f, id)) return
        val e = entries.firstOrNull { it.id == chatId } ?: return
        f.removeFile(id, e.file)
        entries = entries - e
        writeIndex(f, id)
    }

    private fun keepOnlyNow(f: OfflineFiles, id: String, ids: Set<String>) {
        if (!current(f, id)) return
        val gone = entries.filter { it.id !in ids }
        if (gone.isEmpty()) return
        gone.forEach { f.removeFile(id, it.file) }
        entries = entries - gone.toSet()
        writeIndex(f, id)
    }

    private fun evict(f: OfflineFiles, id: String) {
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

    private fun writeIndex(f: OfflineFiles, id: String) {
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

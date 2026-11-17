package com.nekko.android.chat

import com.nekko.android.data.Caller
import com.nekko.protocol.Channels
import java.io.InputStream
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive

/**
 * Videos going with a message (#2777, the iPhone's #2635). A clip is not carried in the message:
 * it goes to the computer at once, in pieces of at most [CHUNK] bytes over `attachment:upload`,
 * and the computer attaches it to the chat, so the message sent next reads it. Send waits until
 * every clip has arrived. It needs the computer connected: a clip never waits in an outbox.
 */
class ClipTray(private val newId: () -> String = { UUID.randomUUID().toString() }) {
    enum class Status { SENDING, ARRIVED, FAILED }

    data class Clip(val id: String, val name: String, val size: Long, val sent: Long = 0, val status: Status = Status.SENDING, val error: String? = null) {
        val progress: Float get() = if (size <= 0) 0f else (sent.toFloat() / size).coerceIn(0f, 1f)
    }

    data class State(val clips: List<Clip> = emptyList(), val error: String? = null) {
        /** Send waits for these. */
        val sending: Boolean get() = clips.any { it.status == Status.SENDING }
        val arrived: List<Clip> get() = clips.filter { it.status == Status.ARRIVED }
        val room: Int get() = (MAX_CLIPS - clips.count { it.status != Status.FAILED }).coerceAtLeast(0)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** A clip the person picked, or a note why not; the caller then runs [upload] with its id. */
    fun add(name: String, size: Long?, online: Boolean): Clip? {
        val why = when {
            !online -> "Videos go only while your computer is connected."
            _state.value.room == 0 -> "Up to $MAX_CLIPS videos per message."
            size == null || size <= 0 -> "Couldn’t read that video."
            size > MAX_BYTES -> "That video is larger than 50 MB. Trim it or send a shorter one."
            else -> null
        }
        if (why != null) { _state.update { it.copy(error = why) }; return null }
        val clip = Clip(newId(), name.ifBlank { "video.mp4" }, size!!)
        _state.update { it.copy(clips = it.clips + clip, error = null) }
        return clip
    }

    /**
     * Send [clip] in order, each piece where the last one ended. A failure keeps the clip with the
     * computer's reason; Remove drops it. The computer starts a new upload when [clip] is tried again.
     */
    suspend fun upload(clip: Clip, chatId: String, caller: Caller, open: () -> InputStream) {
        val uploadId = newId()
        var sent = 0L
        try {
            withContext(Dispatchers.IO) {
                open().use { input ->
                    val buffer = ByteArray(CHUNK)
                    while (sent < clip.size) {
                        val n = fill(input, buffer, minOf(CHUNK.toLong(), clip.size - sent).toInt())
                        if (n <= 0) throw IllegalStateException("The video ended early. Pick it again.")
                        val piece = Base64.getEncoder().encodeToString(if (n == buffer.size) buffer else buffer.copyOf(n))
                        caller.call(
                            Channels.ATTACHMENT_UPLOAD, JsonPrimitive(chatId), JsonPrimitive(uploadId), JsonPrimitive(clip.name),
                            JsonPrimitive(sent), JsonPrimitive(clip.size), JsonPrimitive(piece),
                        )
                        sent += n
                        set(clip.id) { it.copy(sent = sent) }
                    }
                }
            }
            set(clip.id) { it.copy(status = Status.ARRIVED, sent = clip.size) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            set(clip.id) { it.copy(status = Status.FAILED, error = e.message?.takeIf { m -> m.isNotBlank() } ?: "Couldn’t send that video.") }
        }
    }

    /** Remove a clip that hasn't arrived (one that has is already attached on the computer). */
    fun remove(id: String) = _state.update { s -> s.copy(clips = s.clips.filterNot { it.id == id && it.status != Status.ARRIVED }, error = null) }

    /** The message went: the clips that arrived went with it. */
    fun sent() = _state.update { s -> s.copy(clips = s.clips.filterNot { it.status == Status.ARRIVED }) }

    /** A note in the message box: why the picked videos weren't taken. */
    fun refuse(why: String) = _state.update { it.copy(error = why) }

    fun clearError() = _state.update { it.copy(error = null) }

    /** Read up to [len] bytes, as many reads as it takes (`readNBytes` is Android 13+). */
    private fun fill(input: InputStream, buffer: ByteArray, len: Int): Int {
        var n = 0
        while (n < len) {
            val r = input.read(buffer, n, len - n)
            if (r < 0) break
            n += r
        }
        return n
    }

    private fun set(id: String, change: (Clip) -> Clip) = _state.update { s -> s.copy(clips = s.clips.map { if (it.id == id) change(it) else it }) }

    companion object {
        const val MAX_CLIPS = 2
        /** The computer's cap for one file (`PHONE_UPLOAD.maxBytes`). */
        const val MAX_BYTES = 50_000_000L
        /** One piece: 3 MiB, 4 MiB as base64, inside the relay's 10 MB frame (`PHONE_UPLOAD.chunkBytes`). */
        const val CHUNK = 3 * 1024 * 1024
    }
}

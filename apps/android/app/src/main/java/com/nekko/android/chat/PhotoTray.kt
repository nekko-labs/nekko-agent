package com.nekko.android.chat

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Photos waiting in the message box, as the JPEG data URLs the computer's
 * vision models take (`chat:send` / `chat:queue` `images`, like the desktop
 * and the iPhone app). Memory only: nothing is written to the phone's storage.
 * [T] is the preview the composer draws; tests use any type.
 */
class PhotoTray<T> {
    data class Photo<T>(val id: Long, val dataUrl: String, val preview: T)

    data class State<T>(val photos: List<Photo<T>> = emptyList(), val adding: Int = 0, val error: String? = null) {
        val busy: Boolean get() = adding > 0
        val room: Int get() = (MAX_PHOTOS - photos.size - adding).coerceAtLeast(0)
    }

    private val _state = MutableStateFlow(State<T>())
    val state: StateFlow<State<T>> = _state.asStateFlow()
    private var nextId = 0L

    /** How many of [wanted] picked photos fit; the rest are dropped with a note. Call [added] or [failed] for each. */
    fun begin(wanted: Int): Int {
        var n = 0
        _state.update { s ->
            n = wanted.coerceAtMost(s.room)
            s.copy(adding = s.adding + n, error = if (n < wanted) "Up to $MAX_PHOTOS photos per message." else null)
        }
        return n
    }

    fun added(dataUrl: String, preview: T) {
        _state.update { s ->
            val adding = (s.adding - 1).coerceAtLeast(0)
            if (s.photos.sumOf { it.dataUrl.length } + dataUrl.length > MAX_TOTAL_CHARS) {
                s.copy(adding = adding, error = "That photo is too large to send with the others.")
            } else {
                s.copy(adding = adding, photos = s.photos + Photo(nextId++, dataUrl, preview))
            }
        }
    }

    /** Photos from a saved draft, back in the tray as they were. */
    fun seed(saved: List<Pair<String, T>>) {
        if (saved.isEmpty()) return
        _state.update { s -> s.copy(photos = (s.photos + saved.map { (url, preview) -> Photo(nextId++, url, preview) }).take(MAX_PHOTOS)) }
    }

    fun failed(message: String) {
        _state.update { it.copy(adding = (it.adding - 1).coerceAtLeast(0), error = message) }
    }

    fun remove(id: Long) {
        _state.update { s -> s.copy(photos = s.photos.filterNot { it.id == id }, error = null) }
    }

    /** Empties the tray for sending; give the result back to [restore] if the send fails. */
    fun take(): List<Photo<T>> {
        var out = emptyList<Photo<T>>()
        _state.update { s -> out = s.photos; s.copy(photos = emptyList(), error = null) }
        return out
    }

    fun restore(photos: List<Photo<T>>) {
        if (photos.isEmpty()) return
        _state.update { s -> s.copy(photos = (photos + s.photos).take(MAX_PHOTOS)) }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    companion object {
        const val MAX_PHOTOS = ImageAttachments.MAX
        /**
         * All photos of one message together, in data-URL characters: well under
         * the 9 MB a phone frame may carry (`PHONE_MAX_FRAME_BYTES`) once sealed.
         */
        const val MAX_TOTAL_CHARS = 6 * 1024 * 1024
    }
}

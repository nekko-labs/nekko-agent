package com.nekko.protocol

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Where the phone keeps what it must not lose while the computer is out of
 * reach: each computer's drafts and outbox, one small JSON file each. The app
 * keeps them in its no-backup directory, deleted with Forget; tests use memory.
 */
interface OfflineFiles {
    fun load(computerId: String, name: String): JsonElement?
    fun save(computerId: String, name: String, value: JsonElement)
    /** Forget: every file of this computer. */
    fun remove(computerId: String)
}

/**
 * The active computer's drafts: one per chat, plus New chat's under [NEW_CHAT].
 * Saved shortly after each edit (and at once when one is cleared or the app
 * leaves the screen), so a draft survives leaving the chat and Android ending
 * the app. A draft is cleared only once its prompt is sent or in the outbox,
 * which is saved first. The iPhone's `DraftStore`, same file shape.
 */
class DraftStore(
    private val files: OfflineFiles?,
    private val scope: CoroutineScope,
    private val debounceMs: Long = 500,
) {
    private val _drafts = MutableStateFlow<Map<String, Draft>>(emptyMap())
    val drafts: StateFlow<Map<String, Draft>> = _drafts.asStateFlow()

    /** Whose drafts these are; null before a computer is connected. */
    var computerId: String? = null
        private set
    private var saveJob: Job? = null

    /** Show [computerId]'s drafts, saving the previous computer's first. */
    @Synchronized
    fun load(computerId: String?) {
        flush()
        this.computerId = computerId
        val v = computerId?.let { files?.load(it, FILE) } as? JsonObject
        if (v == null || v.long("v") != VERSION) {
            _drafts.value = emptyMap()
            return
        }
        _drafts.value = v["drafts"].obj()?.mapNotNull { (key, d) -> Draft.from(d)?.takeUnless { it.isEmpty }?.let { key to it } }?.toMap() ?: emptyMap()
    }

    fun draft(key: String): Draft = _drafts.value[key] ?: Draft()

    /** Keep what the composer holds now; saved after a short pause in typing. */
    @Synchronized
    fun set(key: String, draft: Draft) {
        val next = draft.takeUnless { it.isEmpty }
        if (_drafts.value[key] == next) return
        _drafts.value = if (next == null) _drafts.value - key else _drafts.value + (key to next)
        scheduleSave()
    }

    /** The prompt was sent (or is in the outbox now), or the user cleared it. */
    @Synchronized
    fun clear(key: String) {
        if (key !in _drafts.value) return
        _drafts.value = _drafts.value - key
        flush()
    }

    /** A prompt the computer refused (or one taken back to edit) comes back, in front of anything typed since. */
    @Synchronized
    fun handBack(key: String, back: Draft) {
        _drafts.value = _drafts.value + (key to draft(key).merging(back))
        flush()
    }

    /** Move a draft to another key (a chat created from New chat got its id). */
    @Synchronized
    fun move(from: String, to: String) {
        val d = _drafts.value[from] ?: return
        _drafts.value = _drafts.value - from + (to to (_drafts.value[to] ?: Draft()).merging(d))
        flush()
    }

    /** Write now: the app is going to the background, or the computer changes. */
    @Synchronized
    fun flush() {
        saveJob?.cancel()
        saveJob = null
        val id = computerId ?: return
        val f = files ?: return
        f.save(id, FILE, buildJsonObject {
            put("v", VERSION)
            put("drafts", JsonObject(_drafts.value.mapValues { it.value.json() }))
        })
    }

    private fun scheduleSave() {
        saveJob?.cancel()
        saveJob = scope.launch {
            if (debounceMs > 0) delay(debounceMs)
            flush()
        }
    }

    companion object {
        /** New chat's draft. */
        const val NEW_CHAT = "new"
        const val FILE = "drafts"
        /** Bumped when the shape changes; an older or newer file is ignored, not misread. */
        const val VERSION = 1L
    }
}

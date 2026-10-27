package com.nekko.android.files

import com.nekko.protocol.FileContent
import com.nekko.protocol.FileListing
import com.nekko.protocol.FileRoot
import com.nekko.protocol.FileSaveResult
import com.nekko.protocol.FileSearch
import com.nekko.protocol.FilesError
import com.nekko.protocol.FilesRequest
import com.nekko.protocol.RelayException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement

/**
 * A chat's or saved folder's files from the phone (AN-33, the iPhone's
 * `FilesModel`): browse, search, read, and save small text files. Reads are
 * plain calls; a save goes through [change], which signs it, so the phone
 * asks for the fingerprint, face or screen lock (once per 5 minutes) and the
 * computer checks the signature and the hash the phone read.
 */
class FilesController(
    val root: FileRoot,
    private val read: suspend (FilesRequest) -> JsonElement,
    private val change: suspend (FilesRequest) -> JsonElement,
) {
    /** Reading from this phone is turned off on the computer (it said so). */
    private val _readOff = MutableStateFlow(false)
    val readOff: StateFlow<Boolean> = _readOff.asStateFlow()

    /** Changes from this phone are turned off on the computer (it said so): Save is hidden. */
    private val _changeOff = MutableStateFlow(false)
    val changeOff: StateFlow<Boolean> = _changeOff.asStateFlow()

    suspend fun list(path: String = ""): FileListing = FileListing.from(reading(FilesRequest.list(root, path)))
        ?: throw RelayException("The computer sent no listing.")

    suspend fun search(query: String): FileSearch = FileSearch.from(reading(FilesRequest.search(root, query)))

    suspend fun open(path: String): FileContent = FileContent.from(reading(FilesRequest.read(root, path)))
        ?: throw RelayException("This file can’t be shown on a phone.")

    /** Save [content] over the version with [expectHash]. */
    suspend fun save(path: String, content: String, expectHash: String): FileSaveResult {
        val v = try {
            change(FilesRequest.write(root, path, content, expectHash))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw noted(e)
        }
        _changeOff.value = false
        return FileSaveResult.from(v) ?: throw RelayException("The computer didn’t say whether it saved.")
    }

    private suspend fun reading(r: FilesRequest): JsonElement = try {
        read(r).also { _readOff.value = false }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        throw noted(e)
    }

    private fun noted(e: Exception): Exception {
        val r = e as? RelayException ?: return e
        when (r.refusal?.code) {
            "read-off" -> _readOff.value = true
            "change-off" -> _changeOff.value = true
            null -> return RelayException(FilesError.plain(r.message.orEmpty()), afterSend = r.afterSend)
        }
        return r
    }

    companion object {
        /** What to show for a failed call. */
        fun message(e: Throwable): String = e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t reach your computer."
    }
}

/** What the file editor draws. */
data class FileEditState(
    /** The text as read, and its hash on the computer. */
    val base: String,
    val hash: String,
    val draft: String,
    val saving: Boolean = false,
    val error: String? = null,
    /** The computer's copy changed since it was read; [conflictHash] is its hash now (null: it is gone). */
    val conflict: Boolean = false,
    val conflictHash: String? = null,
    val savedAt: Long? = null,
) {
    val dirty: Boolean get() = draft != base
    /** A newer version on the computer can be saved over (not when the file is gone: a phone never creates one). */
    val canOverwrite: Boolean get() = conflict && conflictHash != null
    /** The draft is larger than a phone may save (`PHONE_FILES_VIEW.writeBytes`). */
    val tooLarge: Boolean get() = draft.toByteArray(Charsets.UTF_8).size > FileEditController.WRITE_BYTES
}

/**
 * Editing one text file (the iPhone's `FileEditModel`): the version read (its
 * hash), the draft, and what happens on Save when the computer's copy changed
 * meanwhile (*Changed on the computer*: reload it, or save over that newer version).
 */
class FileEditController(val path: String, private val files: FilesController, file: FileContent) {
    private val _state = MutableStateFlow(FileEditState(file.text.orEmpty(), file.hash.orEmpty(), file.text.orEmpty()))
    val state: StateFlow<FileEditState> = _state.asStateFlow()

    fun edit(text: String) = _state.update { it.copy(draft = text) }

    /** Whether Save is offered: there is something to save and the computer allows changes. */
    fun canSave(s: FileEditState = _state.value): Boolean = s.dirty && !s.saving && !files.changeOff.value && !s.conflict

    /** Save the draft over the version read. True when it saved. */
    suspend fun save(): Boolean = save(over = _state.value.hash)

    /** Save over the computer's newer version, after *Changed on the computer*. */
    suspend fun overwrite(): Boolean {
        val s = _state.value
        if (!s.canOverwrite) return false
        return save(over = s.conflictHash!!)
    }

    /** Throw the draft away and read the computer's version again. */
    suspend fun reload() {
        try {
            val f = files.open(path)
            _state.update {
                it.copy(base = f.text.orEmpty(), hash = f.hash.orEmpty(), draft = f.text.orEmpty(), conflict = false, conflictHash = null,
                    error = if (f.canEdit) null else "This file can no longer be edited from a phone.")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(error = FilesController.message(e)) }
        }
    }

    /** Keep editing without resolving the conflict yet. */
    fun dismissConflict() = _state.update { it.copy(conflict = false, conflictHash = null) }

    private suspend fun save(over: String): Boolean {
        val s = _state.value
        if (s.saving) return false
        if (s.tooLarge) {
            _state.update { it.copy(error = "Too large to save from a phone (256 KB at most).") }
            return false
        }
        _state.update { it.copy(saving = true) }
        return try {
            when (val r = files.save(path, s.draft, over)) {
                is FileSaveResult.Saved -> {
                    _state.update { it.copy(base = s.draft, hash = r.hash, conflict = false, conflictHash = null, error = null, savedAt = System.currentTimeMillis()) }
                    true
                }
                is FileSaveResult.Conflict -> {
                    _state.update { it.copy(conflict = true, conflictHash = r.current, error = null) }
                    false
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(error = FilesController.message(e)) }
            false
        } finally {
            _state.update { it.copy(saving = false) }
        }
    }

    companion object {
        const val WRITE_BYTES = 256 * 1024
    }
}

package com.nekko.android.files

import com.nekko.protocol.FilesRequest
import com.nekko.protocol.LogInfo
import com.nekko.protocol.LogText
import com.nekko.protocol.RelayException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement

/** What the Logs list draws. */
data class LogsState(val logs: List<LogInfo> = emptyList(), val loaded: Boolean = false, val error: String? = null)

/**
 * The computer's logs, read only (AN-34, the iPhone's `LogsModel`): the
 * desktop app's log, the engine's, and each chat's agent run log, their
 * tails and the lines matching a search. The computer redacts every line it
 * sends; Share redacts again (`LogShare`).
 */
class LogsController(private val read: suspend (FilesRequest) -> JsonElement) {
    private val _state = MutableStateFlow(LogsState())
    val state: StateFlow<LogsState> = _state.asStateFlow()

    suspend fun load() {
        try {
            val logs = LogInfo.list(read(FilesRequest.logs()))
            _state.update { it.copy(logs = logs, error = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(error = FilesController.message(e)) }
        }
        _state.update { it.copy(loaded = true) }
    }

    /** The end of a log. */
    suspend fun tail(id: String, bytes: Int = TAIL_BYTES): LogText =
        LogText.from(read(FilesRequest.log(id, tailBytes = bytes))) ?: throw RelayException("The computer sent no log.")

    /** The log's lines that hold [query] (case-insensitive), numbered. */
    suspend fun search(id: String, query: String): LogText =
        LogText.from(read(FilesRequest.log(id, query = query))) ?: throw RelayException("The computer sent no log.")

    companion object {
        /** How much of a tail to ask for. */
        const val TAIL_BYTES = 64 * 1024
    }
}

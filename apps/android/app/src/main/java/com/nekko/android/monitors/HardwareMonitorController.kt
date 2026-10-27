package com.nekko.android.monitors

import com.nekko.android.data.Caller
import com.nekko.android.data.PhonePrefs
import com.nekko.protocol.Channels
import com.nekko.protocol.ENGINE_PROVIDER_ID
import com.nekko.protocol.EngineStatus
import com.nekko.protocol.GpuStats
import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.RelayException
import com.nekko.protocol.SystemStats
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** Simple or Expert at the top left of every chat; the phone's own choice, Simple by default. */
val EXPERT_MODE = PhonePrefs.boolean("expertMode", default = false)

/** What the Expert strip and the Monitor sheet draw. */
data class HardwareState(
    val system: SystemStats? = null,
    val gpu: GpuStats? = null,
    val engine: EngineStatus? = null,
    /** The first read answered (or failed). */
    val loaded: Boolean = false,
    val error: String? = null,
    /** The model being unloaded. */
    val unloading: String? = null,
)

/**
 * The Expert monitor (spec/phone/iphone-simple-and-expert-modes.md): the
 * computer's hardware and the Model Server's loaded models, re-read every
 * [POLL_MS] while Expert is on and a chat is open, as the iPhone's
 * HardwareMonitorModel. The logic without Android, like [MonitorsController].
 */
class HardwareMonitorController(
    private val caller: Caller,
    private val computerName: () -> String,
) {
    private val _state = MutableStateFlow(HardwareState())
    val state: StateFlow<HardwareState> = _state.asStateFlow()

    /**
     * Read the hardware and the Model Server once. A computer too old to answer
     * a channel refuses it; that reading stays empty and the rest shows.
     */
    suspend fun refresh() {
        val failures = mutableListOf<Exception>()
        suspend fun read(channel: String): JsonElement? = try {
            caller.call(channel)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failures += e
            null
        }
        val (s, g, e) = coroutineScope {
            val s = async { SystemStats.from(read(Channels.SYSTEM_STATS)) }
            val g = async { GpuStats.from(read(Channels.GPU_STATS)) }
            val e = async { EngineStatus.from(read(Channels.ENGINE_STATUS)) }
            Triple(s.await(), g.await(), e.await())
        }
        val error = when {
            s != null || g != null || e != null -> null
            failures.isEmpty() || failures.all { PhoneRefusal.parse(it.message)?.code == "channel-denied" } ->
                "${computerName()} didn’t send its monitors. Update Nekko Agent there to see them."
            else -> failures.first().let { PhoneRefusal.parse(it.message)?.message(computerName()) ?: it.message }
        }
        _state.update { it.copy(system = s, gpu = g, engine = e, loaded = true, error = error) }
    }

    /** Reads now and every [POLL_MS] until cancelled (Expert turned off, the chat closed, the app went to the background). */
    suspend fun poll() {
        while (true) {
            refresh()
            delay(POLL_MS)
        }
    }

    /**
     * Unload a model from the Model Server: it frees its memory, and the next
     * reply that uses it loads it again. Returns the computer's message; throws
     * with it when the computer refused.
     */
    suspend fun unload(id: String): String {
        _state.update { it.copy(unloading = id) }
        try {
            val res = caller.call(Channels.MODEL_UNLOAD, JsonPrimitive(ENGINE_PROVIDER_ID), JsonPrimitive(id)) as? JsonObject
            val ok = (res?.get("ok") as? JsonPrimitive)?.booleanOrNull == true
            val message = (res?.get("message") as? JsonPrimitive)?.contentOrNull ?: if (ok) "Unloaded." else "Couldn’t unload it."
            refresh()
            if (!ok) throw RelayException(message)
            return message
        } finally {
            _state.update { it.copy(unloading = null) }
        }
    }

    companion object {
        /** The desktop samples hardware every few seconds. */
        const val POLL_MS: Long = 3_000
    }
}

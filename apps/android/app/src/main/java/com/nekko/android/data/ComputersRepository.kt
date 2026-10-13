package com.nekko.android.data

import com.nekko.protocol.Activity
import com.nekko.protocol.ActivityTracker
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.AppInfo
import com.nekko.protocol.Channels
import com.nekko.protocol.E2E
import com.nekko.protocol.Events
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.PairingLink
import com.nekko.protocol.PendingInput
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.WorkspaceFolder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

/** Name the computer after its OS (`app:info` platform), like the Expo app. */
fun osName(platform: String?): String = when (platform) {
    "win32" -> "Windows PC"
    "darwin" -> "Mac"
    "linux" -> "Linux PC"
    else -> DEFAULT_COMPUTER_NAME
}

const val DEFAULT_COMPUTER_NAME = "My computer"

/**
 * Computers this phone is paired with, and the live connection to the active
 * one. A port of `apps/mobile/src/services/computers.ts`. Pairing material
 * lives in [SecureStore] only; screens read the non-secret parts (name, relay
 * host, connection state, chat list) from [state]. One relay connection at a
 * time: the computer you're looking at.
 */
class ComputersRepository(
    private val store: SecureStore,
    private val remotes: RemoteFactory,
    private val scope: CoroutineScope,
    private val deviceName: () -> String,
    /** PBKDF2 is slow on purpose (~1s): keep it off the main thread. */
    private val deriveKey: suspend (secret: String, room: String) -> ByteArray = { s, r ->
        withContext(Dispatchers.Default) { E2E.deriveKey(s, r) }
    },
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val now: () -> Long = System::currentTimeMillis,
    private val summariesDebounceMs: Long = 600,
) {
    private val _state = MutableStateFlow(ComputersState())
    val state: StateFlow<ComputersState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 512)
    /** Every `agent:event` from the active computer. Chat screens filter by session. */
    val events: SharedFlow<AgentEvent> = _events.asSharedFlow()

    private val lock = Mutex()
    @Volatile private var client: Remote? = null
    private var connJob: Job? = null
    private var summariesJob: Job? = null
    private var cachedDeviceId: String? = null

    /** Calls the active computer at call time; throws when none is connected. */
    val caller: Caller = object : Caller {
        override suspend fun call(channel: String, vararg args: JsonElement): JsonElement =
            remote().call(channel, *args)

        override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement): JsonElement =
            remote().callWithTimeout(timeoutMs, channel, *args)
    }

    fun remote(): Remote = client ?: throw RelayException("Not connected to a computer.")

    suspend fun load() {
        val list = StoredJson.decodeIndex(store.get(INDEX_KEY))
        val saved = store.get(ACTIVE_KEY)
        val activeId = if (list.any { it.id == saved }) saved else list.firstOrNull()?.id
        _state.update { it.copy(ready = true, computers = list, activeId = activeId) }
        activeId?.let { connect(it) }
    }

    /** Save a scanned/pasted pairing and connect. Returns the computer's id. */
    suspend fun pair(link: PairingLink): String {
        val keyHex = E2E.toHex(deriveKey(link.key, link.room))
        val id = lock.withLock {
            // Re-scanning a computer we already know keeps its id and name.
            val list = _state.value.computers
            val existing = list.lastOrNull { c ->
                c.relayUrl == link.relayUrl && StoredJson.decodeSecret(store.get(secretKey(c.id)))?.room == link.room
            }
            val id = existing?.id ?: newId()
            store.set(secretKey(id), StoredJson.encodeSecret(ComputerSecret(link.room, link.key, keyHex, link.pair)))
            val next = if (existing != null) list else list + Computer(id, DEFAULT_COMPUTER_NAME, link.relayUrl, now())
            saveIndex(next)
            _state.update { it.copy(computers = next) }
            id
        }
        connect(id)
        return id
    }

    suspend fun rename(id: String, name: String) = lock.withLock {
        val next = _state.value.computers.map { c ->
            if (c.id == id) c.copy(name = name.trim().take(40).ifEmpty { c.name }) else c
        }
        saveIndex(next)
        _state.update { it.copy(computers = next) }
    }

    suspend fun forget(id: String) {
        val activeId = lock.withLock {
            val wasActive = _state.value.activeId == id
            if (wasActive) disconnect()
            store.set(secretKey(id), null)
            val next = _state.value.computers.filter { it.id != id }
            saveIndex(next)
            val activeId = if (wasActive) next.firstOrNull()?.id else _state.value.activeId
            store.set(ACTIVE_KEY, activeId)
            _state.update {
                it.copy(
                    computers = next, activeId = activeId, summaries = emptyList(), providers = emptyList(),
                    models = emptyMap(), workspaces = emptyList(), denied = if (wasActive) null else it.denied,
                )
            }
            if (wasActive) activeId else null
        }
        activeId?.let { connect(it) }
    }

    /** Make [id] the active computer and (re)connect to it. */
    suspend fun connect(id: String) = lock.withLock {
        disconnect()
        val computer = _state.value.computers.firstOrNull { it.id == id } ?: return@withLock
        val secret = StoredJson.decodeSecret(store.get(secretKey(id))) ?: return@withLock
        store.set(ACTIVE_KEY, id)
        _state.update {
            it.copy(
                activeId = id, conn = RelayState.CONNECTING, denied = null, connDetail = null,
                summaries = emptyList(), providers = emptyList(), models = emptyMap(), activity = emptyMap(),
                lastError = null,
            )
        }
        val config = RelayConfig(
            relayUrl = computer.relayUrl,
            room = secret.room,
            key = secret.key,
            keyBytes = E2E.fromHex(secret.keyHex),
            deviceId = deviceId(),
            deviceName = deviceName(),
            pairCode = secret.pair,
            platform = "android",
        )
        val c = remotes.create(config, scope)
        client = c
        connJob = scope.launch {
            launch {
                c.status.collect { s ->
                    if (client !== c) return@collect
                    _state.update { it.copy(conn = s.state, connDetail = s.detail, denied = s.denied ?: it.denied) }
                    if (s.state == RelayState.ONLINE) scope.launch { refresh() }
                }
            }
            launch {
                c.welcome.collect {
                    // Enrollment done: the one-time code must never be sent again.
                    if (secret.pair != null) dropPairCode(id)
                }
            }
            launch {
                c.events.collect { (channel, payload) ->
                    if (channel != Events.AGENT_EVENT || client !== c) return@collect
                    val e = AgentEvent.from(payload) ?: return@collect
                    _events.emit(e)
                    _state.update { s ->
                        val activity = ActivityTracker.next(s.activity, e)
                        if (activity === s.activity) s else s.copy(activity = activity)
                    }
                    // Keep the list fresh when a turn ends anywhere (another device, a task).
                    if (e is AgentEvent.Done || e is AgentEvent.SessionMeta) scheduleSummaries()
                }
            }
        }
        c.connect()
    }

    /** Drop the live connection (the pairing stays). */
    fun disconnect() {
        connJob?.cancel(); connJob = null
        summariesJob?.cancel(); summariesJob = null
        client?.close()
        client = null
        _state.update { it.copy(conn = RelayState.IDLE) }
    }

    /** App came to the foreground: reconnect now rather than after the backoff. */
    fun nudge() {
        client?.nudge()
    }

    suspend fun refresh() {
        val c = client ?: return
        _state.update { it.copy(summariesLoading = true, lastError = null) }
        try {
            val r = coroutineScope {
                val summaries = async { SessionSummary.visible(c.call(Channels.SESSIONS_SUMMARIES)) }
                // Only the public projections: providers and settings carry secrets.
                val providers = async { PublicProvider.list(c.call(Channels.PROVIDERS_LIST)) }
                val defaults = async { RemoteDefaults.from(c.call(Channels.SETTINGS_GET)) }
                val workspaces = async { orNull { WorkspaceFolder.list(c.call(Channels.WORKSPACE_LIST)) } ?: emptyList() }
                val info = async { orNull { AppInfo.from(c.call(Channels.APP_INFO)) } }
                val pending = async { orNull { PendingInput.map(c.call(Channels.CHAT_PENDING)) } ?: emptyMap() }
                Refresh(summaries.await(), providers.await(), defaults.await(), workspaces.await(), info.await(), pending.await())
            }
            if (client !== c) return
            _state.update { s ->
                // Approvals and questions already waiting when we (re)connect.
                val activity = s.activity.toMutableMap()
                r.pending.forEach { (sid, p) -> if (p.approval != null || p.question != null) activity[sid] = Activity.NEEDS_YOU }
                s.copy(
                    summaries = r.summaries, providers = r.providers, defaults = r.defaults,
                    workspaces = r.workspaces, activity = activity, summariesLoading = false,
                )
            }
            learnPlatform(r.info?.platform)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (client === c) _state.update { it.copy(summariesLoading = false, lastError = e.message ?: "Could not refresh.") }
        }
    }

    suspend fun loadModels(providerId: String): List<ModelInfo> {
        _state.value.models[providerId]?.let { return it }
        val list = ModelInfo.list(remote().call(Channels.MODELS_LIST, JsonPrimitive(providerId)))
        _state.update { it.copy(models = it.models + (providerId to list)) }
        return list
    }

    private fun scheduleSummaries() {
        if (summariesJob?.isActive == true) return
        val c = client ?: return
        summariesJob = scope.launch {
            delay(summariesDebounceMs)
            if (client !== c) return@launch
            try {
                val list = SessionSummary.visible(c.call(Channels.SESSIONS_SUMMARIES))
                if (client === c) _state.update { it.copy(summaries = list) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The next refresh will catch up.
            }
        }
    }

    private suspend fun learnPlatform(platform: String?) {
        if (platform == null) return
        lock.withLock {
            val id = _state.value.activeId ?: return
            val list = _state.value.computers
            val c = list.firstOrNull { it.id == id } ?: return
            if (c.platform == platform) return
            // First connection names the computer after its OS, unless the user renamed it.
            val name = if (c.name == DEFAULT_COMPUTER_NAME) osName(platform) else c.name
            val next = list.map { if (it.id == id) it.copy(platform = platform, name = name) else it }
            _state.update { it.copy(computers = next) }
            saveIndex(next)
        }
    }

    private suspend fun dropPairCode(id: String) {
        val s = StoredJson.decodeSecret(store.get(secretKey(id))) ?: return
        if (s.pair != null) store.set(secretKey(id), StoredJson.encodeSecret(s.copy(pair = null)))
    }

    private suspend fun saveIndex(list: List<Computer>) = store.set(INDEX_KEY, StoredJson.encodeIndex(list))

    private suspend fun deviceId(): String {
        cachedDeviceId?.let { return it }
        val id = store.get(DEVICE_KEY) ?: newId().also { store.set(DEVICE_KEY, it) }
        cachedDeviceId = id
        return id
    }

    private suspend fun <T> orNull(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    private class Refresh(
        val summaries: List<SessionSummary>,
        val providers: List<PublicProvider>,
        val defaults: RemoteDefaults,
        val workspaces: List<WorkspaceFolder>,
        val info: AppInfo?,
        val pending: Map<String, PendingInput>,
    )

    companion object {
        const val INDEX_KEY = "nekko.computers"
        const val ACTIVE_KEY = "nekko.activeComputer"
        const val DEVICE_KEY = "nekko.deviceId"
        fun secretKey(id: String) = "nekko.computer.$id"
    }
}

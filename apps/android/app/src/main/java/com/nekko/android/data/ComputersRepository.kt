package com.nekko.android.data

import com.nekko.protocol.ConnectionLog
import com.nekko.protocol.NetworkPath
import com.nekko.protocol.Tailnet
import com.nekko.protocol.RelayHint
import com.nekko.protocol.DenyReason
import com.nekko.protocol.Activity
import com.nekko.protocol.ActivityTracker
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Appearance
import com.nekko.protocol.AppInfo
import com.nekko.android.security.ChangeCalls
import com.nekko.protocol.ChangeSigner
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
import com.nekko.protocol.SavedChatList
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.StepUpChallenge
import com.nekko.protocol.StepUpProof
import com.nekko.protocol.DraftStore
import com.nekko.protocol.SavedTranscripts
import com.nekko.protocol.OfflineFiles
import com.nekko.protocol.TerminalChannels
import com.nekko.protocol.TerminalEvent
import com.nekko.protocol.WorkspaceFolder
import com.nekko.protocol.WorkspacePath
import com.nekko.android.previews.PreviewLoader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import com.nekko.protocol.PcSettings
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
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
    /** One provider's model list may take this long, like the desktop picker (MODEL_LIST_TIMEOUT_MS). */
    private val modelListTimeoutMs: Long = 6_000,
    /** A computer was forgotten: drop what the phone kept about it elsewhere (New chat defaults). */
    private val onForget: (id: String) -> Unit = {},
    /** How long a safety exit waits for the computer's answer before counting on the next connection. */
    private val exitTimeoutMs: Long = 8_000,
    /** How long a queued sign-out waits for the computer to come online at app start. */
    private val outboxConnectMs: Long = 20_000,
    /** Signs Change actions (AN-32): the Keystore key in the app, a software key in tests, none where unset. */
    private val changeSigner: ChangeSigner? = null,
    /** Which relay routes this phone may dial ([com.nekko.android.connection.RoutePolicy] in the app). */
    private val routeAllowed: (String) -> Boolean = { true },
    /** Each computer's drafts and outbox on disk ([OfflineFileStore] in the app); memory only when null. */
    private val offlineFiles: OfflineFiles? = null,
    private val draftDebounceMs: Long = 500,
) {
    /** The active computer's composers, kept until their prompt is sent (offline mode, the iPhone's drafts). */
    val drafts = DraftStore(offlineFiles, scope, draftDebounceMs)

    /** The last chats opened, to read while the computer is out of reach (OF-5); kept only while the setting is on. */
    val transcripts = SavedTranscripts(now = now)

    /** *Keep recent chats to read offline*: on keeps them from now; off deletes every computer's copies. */
    fun setKeepTranscripts(on: Boolean) {
        val f = offlineFiles ?: return
        if (on) {
            transcripts.use(f, _state.value.activeId)
            return
        }
        // Each computer's copies, then none kept from now on.
        _state.value.computers.forEach { c ->
            transcripts.use(f, c.id)
            transcripts.keepOnly(emptySet())
        }
        transcripts.use(null, _state.value.activeId)
    }

    /** Prompts written offline, or whose send dropped, delivered once the computer is reachable. */
    val outbox = Outbox(
        files = offlineFiles,
        drafts = drafts,
        caller = { client.takeIf { _state.value.conn == RelayState.ONLINE } },
        defaults = { _state.value.defaults },
        scope = scope,
        newId = newId,
        now = now,
    )

    init {
        // A chat started offline now exists, and a delivered prompt changed its chat: read the list again.
        outbox.onDelivered = { _, _ -> scheduleSummaries() }
    }

    /** *Sign out this phone* not yet heard by the computer (SK-8). */
    private val signOuts = SignOutOutbox(store)

    private val _state = MutableStateFlow(ComputersState())
    val state: StateFlow<ComputersState> = _state.asStateFlow()

    private val log = ConnectionLog()
    private var loggedComputer: String? = null
    private val _connectionLog = MutableStateFlow<List<ConnectionLog.Entry>>(emptyList())
    /** The active computer's connection history (memory only, content-free), for Settings → Connection. */
    val connectionLog: StateFlow<List<ConnectionLog.Entry>> = _connectionLog.asStateFlow()

    private val _dismissals = MutableSharedFlow<String>(extraBufferCapacity = 64)
    /** The active computer's relay `dismiss` frames: chat tags whose needs-you notification can go. */
    val dismissals: SharedFlow<String> = _dismissals.asSharedFlow()

    /** The connection log as plain text for a bug report: times, states and the relay's host only. */
    fun connectionLogText(): String {
        val url = _state.value.active?.relayUrl.orEmpty()
        return log.text(RelayHint.host(url), Tailnet.isTailnetRelay(url))
    }

    private fun logStatus(state: RelayState, detail: String? = null, denied: DenyReason? = null) {
        log.record(state, detail, denied)
        _connectionLog.value = log.entries
    }

    /** The computer's theme alone, so the app's root only recomposes when it changes. */
    val appearance: StateFlow<Appearance?> = _state.map { it.appearance }.distinctUntilChanged()
        .stateIn(scope, SharingStarted.Eagerly, null)

    private val _events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 512)
    /** Every `agent:event` from the active computer. Chat screens filter by session. */
    val events: SharedFlow<AgentEvent> = _events.asSharedFlow()

    /**
     * What is open over each chat (Git, the Terminals), by chat id. Kept here,
     * not in a chat screen, so opening or folding the phone (a new activity,
     * and a chat pane instead of a full screen) keeps it open and its
     * terminals attached.
     */
    private val _overlays = MutableStateFlow<Map<String, Any>>(emptyMap())
    val overlays: StateFlow<Map<String, Any>> = _overlays.asStateFlow()

    fun setOverlay(chatId: String, overlay: Any?) {
        _overlays.update { if (overlay == null) it - chatId else it + (chatId to overlay) }
    }

    /** Work that outlives a screen (leaving a terminal after its page is gone). */
    val appScope: CoroutineScope get() = scope

    private val _terminalEvents = MutableSharedFlow<TerminalEvent>(extraBufferCapacity = 512)
    /** The output of the terminals this phone opened on the active computer (AN-31). */
    val terminalEvents: SharedFlow<TerminalEvent> = _terminalEvents.asSharedFlow()

    private val lock = Mutex()
    @Volatile private var client: Remote? = null
    private var connJob: Job? = null
    private var summariesJob: Job? = null
    private var summariesDirty = false
    private var cachedDeviceId: String? = null
    /** Change actions on the live connection: its key registration is per connection. */
    @Volatile private var changeCalls: Pair<Remote, ChangeCalls>? = null
    /** The live list has been read since connecting, so it may be saved. */
    @Volatile private var liveList = false

    /** Set while *Keep the chat list when offline* is on; null keeps nothing. */
    @Volatile var chatListCache: ChatListCache? = null
        set(value) {
            field = value
            if (value == null) _state.update { it.copy(savedListAt = null) } else saveList()
        }

    /** Calls the active computer at call time; throws when none is connected. */
    val caller: Caller = object : Caller {
        override suspend fun call(channel: String, vararg args: JsonElement): JsonElement =
            remote().call(channel, *args)

        override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement): JsonElement =
            remote().callWithTimeout(timeoutMs, channel, *args)
    }

    fun remote(): Remote = client ?: throw RelayException("Not connected to a computer.")

    /** Files and loopback pages the agent linked, read for the preview window and cards (AN-35), cached per chat. */
    val previews: PreviewLoader by lazy { PreviewLoader(read = { r -> caller.call(r.channel, *r.args.toTypedArray()) }) }

    /**
     * A Change action on the active computer (IO-33, AN-32): signed with this
     * phone's key (the fingerprint, face or screen lock within the last 5
     * minutes), the key registered on first use. A refusal is thrown with
     * words for the owner, e.g. "Changes from this phone are turned off on Studio".
     */
    suspend fun callChange(channel: String, args: List<JsonElement>, stepUp: StepUpProof? = null, timeoutMs: Long? = null): JsonElement {
        val r = remote()
        val signer = changeSigner ?: throw RelayException("This phone can’t confirm changes with a fingerprint or screen lock.")
        val calls = changeCalls?.takeIf { it.first === r }?.second
            ?: ChangeCalls(r, signer, deviceId(), _state.value.active?.name ?: "your computer").also { changeCalls = r to it }
        return calls.call(channel, args, stepUp, timeoutMs)
    }

    /**
     * A call that may raise a chat's tool policy: `session:setOptions` with a
     * more permissive `mode`, or `settings:update` raising `defaultChatMode`
     * (ask < guardrails < yolo). Sent plain first; when the computer answers
     * `proof-required` (it was a raise), sent again signed ([callChange]), so
     * the phone asks for the fingerprint or screen lock. Lowering or keeping
     * the mode never asks. A `step-up-required` refusal is thrown for the
     * step-up sheet, which sends it again through [callChange] with its answer.
     */
    suspend fun callRaising(channel: String, args: List<JsonElement>): JsonElement = try {
        remote().call(channel, *args.toTypedArray())
    } catch (e: RelayException) {
        if (e.refusal?.code != "proof-required" || changeSigner == null) throw e
        callChange(channel, args)
    }

    /**
     * Read the paired computers and connect to one: [preferredId] (the phone's
     * default computer, Settings → New chats) when it is still paired, else the
     * one used last, else the first.
     */
    suspend fun load(preferredId: String? = null) {
        val list = StoredJson.decodeIndex(store.get(INDEX_KEY))
        val activeId = NewChatDefaults.startComputer(preferredId, store.get(ACTIVE_KEY), list.map { it.id })
        _state.update { it.copy(ready = true, computers = list, activeId = activeId) }
        activeId?.let { connect(it) }
        // Sign-outs the computer has not heard yet: say them now, beside the normal connection.
        scope.launch { deliverSignOuts() }
    }

    /** Save a scanned/pasted pairing and connect. Returns the computer's id. */
    suspend fun pair(link: PairingLink): String {
        val keyHex = E2E.toHex(deriveKey(link.key, link.room))
        // Paired again after signing out: the old sign-out must never reach the new pairing.
        signOuts.cancel(link.relayUrl, link.room)
        val id = lock.withLock {
            // Re-scanning a computer we already know keeps its id and name.
            val list = _state.value.computers
            val existing = list.lastOrNull { c ->
                c.relayUrl == link.relayUrl && StoredJson.decodeSecret(store.get(secretKey(c.id)))?.room == link.room
            }
            val id = existing?.id ?: newId()
            store.set(secretKey(id), StoredJson.encodeSecret(ComputerSecret(link.room, link.key, keyHex, link.pair)))
            // The computer's routes may have changed since (another Wi-Fi, LAN addresses on or off).
            val next = if (existing != null) list.map { if (it.id == id) it.copy(alts = link.alts) else it }
            else list + Computer(id, DEFAULT_COMPUTER_NAME, link.relayUrl, now(), alts = link.alts)
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
            chatListCache?.remove(id)
            if (_state.value.activeId == id) {
                drafts.load(null)
                outbox.load(null)
                transcripts.load(null)
            }
            offlineFiles?.remove(id)
            onForget(id)
            val next = _state.value.computers.filter { it.id != id }
            saveIndex(next)
            // No computer knows the Change key any more: the next pairing makes a new one.
            if (next.isEmpty()) runCatching { changeSigner?.forget() }
            val activeId = if (wasActive) next.firstOrNull()?.id else _state.value.activeId
            store.set(ACTIVE_KEY, activeId)
            _state.update {
                it.copy(
                    computers = next, activeId = activeId, summaries = emptyList(), providers = emptyList(),
                    models = emptyMap(), modelErrors = emptyMap(), workspaces = emptyList(), denied = if (wasActive) null else it.denied,
                    appearance = if (next.isEmpty()) null else it.appearance,
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
        if (drafts.computerId != id) {
            drafts.load(id)
            outbox.load(id)
        }
        if (transcripts.computerId != id) transcripts.load(id)
        if (loggedComputer != id) {
            log.clear()
            loggedComputer = id
        }
        logStatus(RelayState.CONNECTING)
        _state.update {
            it.copy(
                activeId = id, conn = RelayState.CONNECTING, denied = null, connDetail = null,
                summaries = emptyList(), providers = emptyList(), models = emptyMap(), modelErrors = emptyMap(), activity = emptyMap(),
                // Another computer, or the same one later: its settings are unknown until it answers.
                pcSettings = PcSettings(),
                quitFromPhone = false,
                remoteStoppedAt = null,
                lastError = null,
                savedListAt = null,
                hostProtocol = null,
            )
        }
        liveList = false
        // Opening the app away from the computer: the list as it was, marked as saved.
        chatListCache?.load(id)?.let { saved ->
            _state.update { it.copy(summaries = saved.summaries, workspaces = saved.folders, savedListAt = saved.savedAt) }
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
            alts = computer.alts,
            routeAllowed = routeAllowed,
        )
        // Refusals read with the computer's current name (it can be renamed while connected).
        val c = PlainRefusals(remotes.create(config, scope)) {
            _state.value.computers.firstOrNull { it.id == id }?.name ?: computer.name
        }
        client = c
        connJob = scope.launch {
            launch {
                c.status.collect { s ->
                    if (client !== c) return@collect
                    _state.update { it.copy(conn = s.state, connDetail = s.detail, denied = s.denied ?: it.denied, route = s.route) }
                    logStatus(s.state, s.detail, s.denied)
                    if (s.state == RelayState.ONLINE) scope.launch {
                        refresh()
                        // Back in reach: what was written offline goes now, in order.
                        outbox.flush()
                    }
                }
            }
            launch { c.dismissals.collect { _dismissals.emit(it) } }
            launch {
                c.welcome.collect { w ->
                    if (client === c) _state.update { it.copy(hostProtocol = w.protocol) }
                    // Enrollment done: the one-time code must never be sent again.
                    if (secret.pair != null) dropPairCode(id)
                }
            }
            launch {
                c.events.collect { (channel, payload) ->
                    if (client !== c) return@collect
                    if (channel == Events.APPEARANCE_UPDATED) {
                        // The desktop's theme changed: follow it live.
                        _state.update { it.copy(appearance = Appearance.from(payload)) }
                        return@collect
                    }
                    if (channel == TerminalChannels.EVENT) {
                        TerminalEvent.from(payload)?.let { _terminalEvents.emit(it) }
                        return@collect
                    }
                    if (channel != Events.AGENT_EVENT) return@collect
                    val e = AgentEvent.from(payload) ?: return@collect
                    outbox.onEvent(e)
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
        c.setNetworkPath(networkPath)
        c.connect()
    }

    /** Drop the live connection (the pairing stays). */
    fun disconnect() {
        connJob?.cancel(); connJob = null
        summariesJob?.cancel(); summariesJob = null
        summariesDirty = false
        client?.close()
        client = null
        changeCalls = null
        _state.update { it.copy(conn = RelayState.IDLE, route = null) }
    }

    /** App came to the foreground: reconnect now rather than after the backoff. */
    fun nudge() {
        client?.nudge()
        // Chats completed, restored or started on the computer meanwhile send no event: re-read the list.
        if (_state.value.conn == RelayState.ONLINE) {
            scheduleSummaries()
            outbox.flushSoon()
        }
    }

    /**
     * Change the computer's settings from the phone (Settings → On <computer>).
     * Only the keys the computer lets a phone set; the reply is the computer's
     * reduced view, so the screen shows what was actually saved there.
     */
    suspend fun updatePcSettings(patch: JsonObject, stepUp: StepUpProof? = null) {
        // A step-up only follows a raise, which is signed too.
        val reply = if (stepUp == null) callRaising(Channels.SETTINGS_UPDATE, listOf(patch)) else callChange(Channels.SETTINGS_UPDATE, listOf(patch), stepUp)
        _state.update { it.copy(pcSettings = PcSettings.from(reply)) }
    }

    /**
     * A fresh step-up challenge from the active computer (SK-7): single use,
     * two minutes, and which kinds of method it has. Fetched for every try.
     */
    suspend fun stepUpChallenge(): StepUpChallenge =
        StepUpChallenge.from(remote().call(Channels.SECURITY_CHALLENGE))
            ?: throw RelayException("${_state.value.active?.name ?: "Your computer"} didn’t send a confirmation request. Update Nekko Agent there.")

    // ---- safety exits (SK-8): never a proof or a step-up, decision 0018 ----

    /** How *Sign out this phone* went: heard by the computer now, or queued for when it is reachable. */
    enum class SignOutResult { SENT, QUEUED }

    /**
     * *Sign out this phone* for the active computer: say `device:signOut` if
     * the computer is online (it revokes and kicks this phone), then forget
     * it here either way: pairing secret, saved chat list, New chat defaults.
     * When the computer could not hear it, it is queued and said at the next
     * app start ([deliverSignOuts]). Signing out never waits on the computer.
     */
    // Leaving the screen mid-way must not leave the phone half signed out.
    suspend fun signOutThisPhone(): SignOutResult = withContext(NonCancellable) { signOut() }

    private suspend fun signOut(): SignOutResult {
        val id = _state.value.activeId ?: throw RelayException("No computer to sign out of.")
        val computer = _state.value.active ?: throw RelayException("No computer to sign out of.")
        val secret = StoredJson.decodeSecret(store.get(secretKey(id)))
        val c = client
        val sent = c != null && _state.value.conn == RelayState.ONLINE && try {
            c.callWithTimeout(exitTimeoutMs, Channels.DEVICE_SIGN_OUT)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            false
        }
        if (!sent && secret != null) {
            signOuts.add(PendingSignOut(computer.relayUrl, secret.room, secret.key, secret.keyHex, deviceId(), now()))
        }
        forget(id)
        return if (sent || secret == null) SignOutResult.SENT else SignOutResult.QUEUED
    }

    /**
     * *Stop remote access on the computer*: `remote:stop`. The computer turns
     * remote access off and kicks every phone, so the reply may be lost with
     * the socket; a connection dropped after sending counts as stopped. Only
     * the computer can turn it on again.
     */
    suspend fun stopRemoteAccess() {
        try {
            remote().callWithTimeout(exitTimeoutMs, Channels.REMOTE_STOP)
        } catch (e: RelayException) {
            if (e.refusal != null || !e.afterSend) throw e
        }
        _state.update { it.copy(remoteStoppedAt = now()) }
    }

    /**
     * *Quit Nekko Agent on the computer*: `app:quit`, only offered when
     * `app:info` says `quitFromPhone`. The computer may be gone before it
     * answers; a dropped connection after sending counts as quitting. A
     * refusal (`quit-disabled`: the switch was turned off meanwhile) is thrown,
     * already in plain words.
     */
    suspend fun quitComputer() {
        try {
            remote().callWithTimeout(exitTimeoutMs, Channels.APP_QUIT)
        } catch (e: RelayException) {
            if (e.refusal != null || !e.afterSend) throw e
        }
    }

    /**
     * Say each queued sign-out to its computer over a connection of its own
     * (the phone no longer lists that computer). Dropped once heard, once the
     * computer already refuses this phone (revoked or unknown: signed out
     * all the same), or when too old; kept for the next start otherwise.
     */
    suspend fun deliverSignOuts() {
        for (p in signOuts.prune(now())) {
            val config = RelayConfig(
                relayUrl = p.relayUrl,
                room = p.room,
                key = p.key,
                keyBytes = E2E.fromHex(p.keyHex),
                deviceId = p.deviceId,
                deviceName = deviceName(),
                platform = "android",
            )
            val r = remotes.create(config, scope)
            val done = try {
                r.connect()
                val s = withTimeout(outboxConnectMs) {
                    r.status.first { it.state == RelayState.ONLINE || it.state == RelayState.DENIED }
                }
                if (s.state == RelayState.DENIED) {
                    true
                } else {
                    r.callWithTimeout(exitTimeoutMs, Channels.DEVICE_SIGN_OUT)
                    true
                }
            } catch (_: TimeoutCancellationException) {
                false
            } catch (e: CancellationException) {
                throw e
            } catch (_: RelayException) {
                // Kicked while the answer was on its way is the computer doing what was asked.
                r.status.value.state == RelayState.DENIED
            } catch (_: Exception) {
                false
            } finally {
                r.close()
            }
            if (done) signOuts.remove(p)
        }
    }

    /** Complete a chat (the desktop's archive): it moves under its group's Completed, nothing is deleted. */
    suspend fun completeChat(sessionId: String) {
        val at = now()
        remote().call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(sessionId), buildJsonObject { put("archivedAt", at) })
        setArchived(sessionId, at)
    }

    /** Bring a completed chat back to the active list, like the desktop's Restore. */
    suspend fun restoreChat(sessionId: String) {
        remote().call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(sessionId), buildJsonObject { put("archivedAt", JsonNull) })
        setArchived(sessionId, null)
    }

    /** Rename a chat on the computer; a blank title changes nothing. */
    suspend fun renameChat(sessionId: String, title: String) {
        val t = title.trim()
        if (t.isEmpty()) return
        remote().call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(sessionId), buildJsonObject { put("title", t) })
        _state.update { s -> s.copy(summaries = s.summaries.map { if (it.id == sessionId) it.copy(title = t) else it }) }
    }

    /** Pin or unpin a chat, the desktop's pin: the same flag on the computer. */
    suspend fun setPinned(sessionId: String, pinned: Boolean) {
        remote().call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(sessionId), buildJsonObject { put("pinned", pinned) })
        _state.update { s -> s.copy(summaries = s.summaries.map { if (it.id == sessionId) it.copy(pinned = pinned) else it }) }
    }

    /**
     * Change one chat's tool policy. A raise is signed ([callRaising]); a
     * `step-up-required` refusal is thrown for the step-up sheet, which calls
     * this again with its [stepUp].
     */
    suspend fun setChatMode(sessionId: String, mode: PcSettings.ChatMode, stepUp: StepUpProof? = null) {
        val args = listOf(JsonPrimitive(sessionId), buildJsonObject { put("mode", mode.wire) })
        if (stepUp == null) callRaising(Channels.SESSION_SET_OPTIONS, args) else callChange(Channels.SESSION_SET_OPTIONS, args, stepUp)
    }

    private fun setArchived(sessionId: String, at: Long?) {
        _state.update { s ->
            s.copy(summaries = s.summaries.map { if (it.id == sessionId) it.copy(archived = at != null, archivedAt = at) else it })
        }
    }

    /** Delete a chat on the computer for good. */
    suspend fun deleteChat(sessionId: String) {
        remote().call(Channels.SESSION_DELETE, JsonPrimitive(sessionId))
        dropFromList(sessionId)
        transcripts.remove(sessionId)
    }

    private fun dropFromList(sessionId: String) {
        _state.update { s -> s.copy(summaries = s.summaries.filter { it.id != sessionId }, activity = s.activity - sessionId) }
    }

    /** The phone changed network, or the socket may have died while frozen: dial a fresh one now. */
    fun reconnect() {
        client?.reconnect()
    }

    /** The phone's network, for the route choice; the next connection starts from it too. */
    @Volatile private var networkPath = NetworkPath.UNKNOWN

    /** The phone moved to another network of kind [path]: the best route for it, on a fresh socket now. */
    fun networkChanged(path: NetworkPath) {
        networkPath = path
        client?.networkChanged(path)
    }

    /** Where the phone is, without having moved: dial again only if that changes the route. */
    fun setNetworkPath(path: NetworkPath) {
        networkPath = path
        client?.setNetworkPath(path)
    }

    suspend fun refresh() {
        val c = client ?: return
        _state.update { it.copy(summariesLoading = true, lastError = null) }
        try {
            val r = coroutineScope {
                val summaries = async { SessionSummary.visible(c.call(Channels.SESSIONS_SUMMARIES)) }
                // Only the public projections: providers and settings carry secrets.
                val providers = async { PublicProvider.list(c.call(Channels.PROVIDERS_LIST)) }
                // Only public projections leave this block: settings carry secrets.
                val settings = async { c.call(Channels.SETTINGS_GET).let { Triple(RemoteDefaults.from(it), Appearance.from(it), PcSettings.from(it)) } }
                val workspaces = async { orNull { WorkspaceFolder.list(c.call(Channels.WORKSPACE_LIST)) } ?: emptyList() }
                val info = async { orNull { AppInfo.from(c.call(Channels.APP_INFO)) } }
                val pending = async { orNull { PendingInput.map(c.call(Channels.CHAT_PENDING)) } ?: emptyMap() }
                val (defaults, appearance, pcSettings) = settings.await()
                Refresh(summaries.await(), providers.await(), defaults, appearance, pcSettings, workspaces.await(), info.await(), pending.await())
            }
            if (client !== c) return
            _state.update { s ->
                // Approvals and questions already waiting when we (re)connect.
                val activity = s.activity.toMutableMap()
                r.pending.forEach { (sid, p) -> if (p.approval != null || p.question != null) activity[sid] = Activity.NEEDS_YOU }
                s.copy(
                    summaries = r.summaries, providers = r.providers, defaults = r.defaults, appearance = r.appearance, pcSettings = r.pcSettings,
                    workspaces = r.workspaces, activity = activity, summariesLoading = false, savedListAt = null,
                )
            }
            _state.update { it.copy(quitFromPhone = r.info?.quitFromPhone == true) }
            // The computer's whole list: a saved chat it no longer has goes too.
            transcripts.keepOnly(r.summaries.map { it.id }.toSet())
            liveList = true
            saveList()
            learnPlatform(r.info?.platform)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (client === c) _state.update { it.copy(summariesLoading = false, lastError = e.message ?: "Could not refresh.") }
        }
    }

    suspend fun loadModels(providerId: String): List<ModelInfo> {
        _state.value.models[providerId]?.let { return it }
        val list = ModelInfo.list(remote().callWithTimeout(modelListTimeoutMs, Channels.MODELS_LIST, JsonPrimitive(providerId)))
        _state.update { it.copy(models = it.models + (providerId to list), modelErrors = it.modelErrors - providerId) }
        return list
    }

    /**
     * Every enabled provider's models on the computer, asked in parallel so the
     * picker shows them all at once like the desktop's. A provider that fails or
     * is slower than the desktop's limit is marked unreachable instead of holding
     * up the others. [force] asks again for lists already loaded (Retry).
     */
    suspend fun loadAllModels(force: Boolean = false): List<ModelGroup> = coroutineScope {
        val enabled = _state.value.providers.filter { it.enabled }
        if (force) {
            val ids = enabled.map { it.id }.toSet()
            _state.update { it.copy(models = it.models - ids, modelErrors = it.modelErrors - ids) }
        }
        enabled.map { pr ->
            async {
                try {
                    loadModels(pr.id)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    val why = if (e.message?.endsWith("timed out") == true) "Didn’t answer in time." else (e.message ?: "Couldn’t list its models.")
                    _state.update { it.copy(modelErrors = it.modelErrors + (pr.id to why)) }
                }
            }
        }.awaitAll()
        modelGroups(_state.value)
    }

    /** The live list, as the phone's saved copy (only when the user keeps one). */
    private fun saveList() {
        val cache = chatListCache ?: return
        val s = _state.value
        val id = s.activeId ?: return
        if (!liveList || s.savedListAt != null) return
        cache.save(id, SavedChatList(now(), s.summaries, s.workspaces))
    }

    /** Save a folder on the computer by its absolute path there (a signed Change). */
    suspend fun addWorkspace(path: String) {
        val p = path.trim()
        if (!WorkspacePath.isAbsolute(p)) throw RelayException("Enter an absolute folder path on the computer.")
        changeWorkspace(Channels.WORKSPACE_ADD_BY_PATH, p)
    }

    /** Forget a saved folder (a signed Change). The computer never deletes the folder on disk. */
    suspend fun removeWorkspace(id: String) {
        changeWorkspace(Channels.WORKSPACE_REMOVE, id)
        reloadList()
    }

    private suspend fun changeWorkspace(channel: String, value: String) {
        if (_state.value.conn != RelayState.ONLINE) throw RelayException("Connect to the computer to manage folders.")
        val c = remote()
        val list = WorkspaceFolder.list(callChange(channel, listOf(JsonPrimitive(value))))
        if (client === c) _state.update { it.copy(workspaces = list) }
    }

    /** Read the chat list again soon (a chat was forked or created from here). */
    fun reloadList() = scheduleSummaries()

    private fun scheduleSummaries() {
        val c = client ?: return
        summariesDirty = true
        if (summariesJob?.isActive == true) return
        summariesJob = scope.launch {
            do {
                delay(summariesDebounceMs)
                if (client !== c) return@launch
                // Notifications during the debounce are covered by this call.
                summariesDirty = false
                try {
                    val list = SessionSummary.visible(c.call(Channels.SESSIONS_SUMMARIES))
                    ensureActive()
                    if (client !== c) return@launch
                    _state.update { it.copy(summaries = list) }
                    saveList()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Only a new invalidation retries, never a failed call alone.
                }
            } while (isActive && client === c && summariesDirty)
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
        val appearance: Appearance,
        val pcSettings: PcSettings,
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

/** The picker's groups: every enabled provider on the computer, with its models once listed. */
fun modelGroups(s: ComputersState): List<ModelGroup> =
    s.providers.filter { it.enabled }.map { pr -> ModelGroup(pr, s.models[pr.id], s.modelErrors[pr.id]) }

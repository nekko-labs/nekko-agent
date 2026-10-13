package com.nekko.protocol

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** Connection state, same meanings as `apps/mobile/src/lib/relayClient.ts`. */
enum class RelayState {
    /** Not started, or closed by the app. */
    IDLE,
    /** Dialing the relay, or waiting for the agent's welcome. */
    CONNECTING,
    /** Welcomed by the agent; requests flow. */
    ONLINE,
    /** Relay reachable but the computer isn't connected to it. */
    OFFLINE,
    /** The computer refused this device. Terminal until re-paired. */
    DENIED,
}

enum class DenyReason(val wire: String) {
    UNKNOWN_DEVICE("unknown-device"), REVOKED("revoked"), BAD_CODE("bad-code"), INVALID("invalid"),
    KICKED("kicked"), BAD_KEY("bad-key");

    companion object {
        fun parse(s: String?) = entries.firstOrNull { it.wire == s } ?: INVALID
    }
}

data class WelcomedDevice(val id: String, val name: String, val platform: String)

data class RelayStatus(val state: RelayState, val detail: String? = null, val denied: DenyReason? = null)

class RelayException(message: String) : Exception(message)

/** A minimal WebSocket the client drives; [OkHttpTransport] in production, fakes in tests. */
interface WsTransport {
    fun open(url: String, listener: WsListener): WsConnection
}

interface WsConnection {
    /** False when the socket is not open (the frame is dropped). */
    fun send(text: String): Boolean
    fun close(code: Int, reason: String)
}

interface WsListener {
    fun onOpen()
    fun onMessage(text: String)
    /** Called exactly once per connection, for a clean close or a failure. */
    fun onClosed(code: Int, reason: String)
}

class RelayConfig(
    val relayUrl: String,
    val room: String,
    /** Pairing secret: relay transport auth (the relay hashes it; never decrypts). */
    val key: String,
    /** AES key derived from (key, room) with [E2E.deriveKey]. */
    val keyBytes: ByteArray,
    val deviceId: String,
    val deviceName: String,
    /** One-time enrollment code from the QR; dropped once welcomed. */
    val pairCode: String? = null,
    val platform: String = "android",
    val handshakeTimeoutMs: Long = 15_000,
    val requestTimeoutMs: Long = 120_000,
    /** Backoff knobs; tests shrink them. */
    val retryBaseMs: Long = 1_000,
    val retryMaxMs: Long = 30_000,
    val offlinePollMs: Long = 15_000,
)

/**
 * Relay v2 client: the phone side of `packages/host/src/relay.ts`.
 *
 * Connects as `role=client`, completes the sealed HELLO handshake (device id +
 * optional one-time pairing code), then speaks the host's request protocol:
 * `{type:'req', id, channel, args}` out, `{type:'res'}` and
 * `{type:'event', channel, payload}` back, all E2E-sealed. Reconnects with
 * backoff until closed. A port of the Expo client with the same state machine.
 */
class RelayClient(
    private val config: RelayConfig,
    private val transport: WsTransport,
    private val scope: CoroutineScope,
) {
    private val lock = Any()
    private var conn: WsConnection? = null
    private var welcomed = false
    private var stopped = true
    private var retry = 0
    private var retryJob: Job? = null
    @Volatile private var pairCode: String? = config.pairCode
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()

    private val _status = MutableStateFlow(RelayStatus(RelayState.IDLE))
    val status: StateFlow<RelayStatus> = _status.asStateFlow()

    private val _events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 512)
    /** Every sealed `event` frame as (channel, payload). */
    val events: SharedFlow<Pair<String, JsonElement>> = _events.asSharedFlow()

    private val _welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
    val welcome: SharedFlow<WelcomedDevice> = _welcome.asSharedFlow()

    val state: RelayState get() = _status.value.state

    fun connect() {
        synchronized(lock) {
            if (!stopped) return
            stopped = false
            retry = 0
        }
        dial()
    }

    fun close() {
        val c: WsConnection?
        synchronized(lock) {
            stopped = true
            retryJob?.cancel(); retryJob = null
            c = conn; conn = null
            welcomed = false
        }
        runCatching { c?.close(1000, "closed by app") }
        failPending("disconnected")
        setStatus(RelayStatus(RelayState.IDLE))
    }

    /** Reconnect now instead of waiting out the backoff (app foregrounded). */
    fun nudge() {
        synchronized(lock) {
            if (stopped || state == RelayState.DENIED || state == RelayState.ONLINE) return
            retryJob?.cancel(); retryJob = null
            retry = 0
            if (conn != null) return
        }
        dial()
    }

    /** Call a host IPC channel. Waits (briefly) for the handshake if needed. */
    suspend fun call(channel: String, vararg args: JsonElement): JsonElement =
        callWithTimeout(config.requestTimeoutMs, channel, *args)

    /**
     * Same as [call] with an explicit reply timeout. `chat:send` only replies
     * when the whole turn is over, so it gets hours rather than two minutes.
     */
    suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement): JsonElement {
        awaitReady()
        val id = nextId.getAndIncrement()
        val deferred = CompletableDeferred<JsonElement>()
        pending[id] = deferred
        val frame = buildJsonObject {
            put("type", "req"); put("id", id); put("channel", channel); put("args", JsonArray(args.toList()))
        }
        if (!sendSealed(frame)) {
            pending.remove(id)
            throw RelayException("Could not reach your computer.")
        }
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (_: TimeoutCancellationException) {
            throw RelayException("$channel: timed out")
        } finally {
            pending.remove(id)
        }
    }

    private suspend fun awaitReady() {
        if (isReady()) return
        when {
            state == RelayState.DENIED -> throw RelayException("This phone is no longer paired.")
            synchronized(lock) { stopped } -> throw RelayException("Not connected.")
        }
        try {
            withTimeout(config.handshakeTimeoutMs) {
                status.first { it.state == RelayState.ONLINE || it.state == RelayState.DENIED || it.state == RelayState.IDLE }
            }
        } catch (_: TimeoutCancellationException) {
            throw RelayException(if (state == RelayState.OFFLINE) "Your computer is offline." else "Could not reach your computer.")
        }
        if (!isReady()) throw RelayException(if (state == RelayState.DENIED) "This phone is no longer paired." else "Not connected.")
    }

    private fun isReady() = synchronized(lock) { welcomed && conn != null }

    private fun dial() {
        val url = "${config.relayUrl.trimEnd('/')}/relay?role=client" +
            "&room=${enc(config.room)}&key=${enc(config.key)}"
        synchronized(lock) {
            if (stopped) return
            welcomed = false
        }
        setStatus(RelayStatus(RelayState.CONNECTING))
        lateinit var self: WsConnection
        val listener = object : WsListener {
            override fun onOpen() { if (isCurrent(self)) hello() }
            override fun onMessage(text: String) { if (isCurrent(self)) onRaw(text) }
            override fun onClosed(code: Int, reason: String) = onSocketClosed(self, code, reason)
        }
        val c = try {
            transport.open(url, listener)
        } catch (e: Exception) {
            scheduleRetry(e.message ?: "could not connect")
            return
        }
        self = c
        synchronized(lock) {
            if (stopped) { runCatching { c.close(1000, "closed by app") }; return }
            conn = c
        }
    }

    private fun isCurrent(c: WsConnection) = synchronized(lock) { conn === c }

    private fun onSocketClosed(c: WsConnection, code: Int, reason: String) {
        synchronized(lock) {
            if (conn !== c) return
            conn = null
            welcomed = false
        }
        failPending("connection lost")
        if (synchronized(lock) { stopped } || state == RelayState.DENIED) return
        when {
            code == 4001 -> deny(DenyReason.KICKED)
            code == 1008 && reason.contains("bad pairing key", ignoreCase = true) -> deny(DenyReason.BAD_KEY)
            code == 1008 && reason.contains("agent offline", ignoreCase = true) -> {
                setStatus(RelayStatus(RelayState.OFFLINE))
                scheduleRetry(null, offline = true)
            }
            else -> scheduleRetry(reason.ifBlank { "closed ($code)" })
        }
    }

    private fun hello() {
        sendSealed(buildJsonObject {
            put("type", "hello")
            put("deviceId", config.deviceId)
            put("name", config.deviceName)
            put("platform", config.platform)
            pairCode?.let { put("pair", it) }
        })
    }

    private fun sendSealed(frame: JsonObject): Boolean {
        val c = synchronized(lock) { conn } ?: return false
        val env = buildJsonObject { put("enc", E2E.seal(config.keyBytes, frame)) }
        return c.send(env.toString())
    }

    private fun onRaw(raw: String) {
        val env = runCatching { WireJson.parseToJsonElement(raw) }.getOrNull().obj() ?: return
        val enc = env.str("enc")
        if (enc != null) {
            // Wrong key or tampered: drop silently, like the agent does.
            val frame = runCatching { E2E.open(config.keyBytes, enc) }.getOrNull().obj() ?: return
            onFrame(frame)
            return
        }
        when (env.str("type")) {
            "agent-offline" -> {
                synchronized(lock) { welcomed = false }
                setStatus(RelayStatus(RelayState.OFFLINE))
            }
            "agent-online" -> if (!synchronized(lock) { welcomed }) {
                // The computer (re)joined after us: repeat the handshake.
                setStatus(RelayStatus(RelayState.CONNECTING))
                hello()
            }
        }
    }

    private fun onFrame(frame: JsonObject) {
        when (frame.str("type")) {
            "welcome" -> {
                synchronized(lock) {
                    welcomed = true
                    retry = 0
                }
                pairCode = null // enrollment done; never resend the code
                val d = frame["device"].obj()
                setStatus(RelayStatus(RelayState.ONLINE))
                _welcome.tryEmit(WelcomedDevice(d?.str("id") ?: config.deviceId, d?.str("name") ?: config.deviceName, d?.str("platform") ?: config.platform))
            }
            "denied" -> deny(DenyReason.parse(frame.str("reason")))
            "res" -> {
                val id = frame.long("id") ?: return
                val p = pending.remove(id) ?: return
                val err = frame["error"]
                if (err != null && err !is JsonNull) {
                    p.completeExceptionally(RelayException((err as? JsonPrimitive)?.content ?: err.toString()))
                } else {
                    p.complete(frame["result"] ?: JsonNull)
                }
            }
            "event" -> {
                val ch = frame.str("channel") ?: return
                _events.tryEmit(ch to (frame["payload"] ?: JsonNull))
            }
        }
    }

    private fun deny(reason: DenyReason) {
        val c: WsConnection?
        synchronized(lock) {
            welcomed = false
            stopped = true
            retryJob?.cancel(); retryJob = null
            c = conn; conn = null
        }
        failPending("This phone is no longer paired.")
        runCatching { c?.close(1000, "denied") }
        setStatus(RelayStatus(RelayState.DENIED, reason.wire, reason))
    }

    private fun scheduleRetry(detail: String?, offline: Boolean = false) {
        val delayMs: Long
        synchronized(lock) {
            if (stopped) return
            // 1s, 2s, 4s … capped; an offline computer is polled at a fixed pace.
            delayMs = if (offline) config.offlinePollMs
            else minOf(config.retryMaxMs, config.retryBaseMs shl minOf(retry++, 20))
            retryJob?.cancel()
            retryJob = scope.launch {
                delay(delayMs)
                synchronized(lock) { retryJob = null }
                dial()
            }
        }
        if (!offline) setStatus(RelayStatus(RelayState.CONNECTING, detail))
    }

    private fun failPending(message: String) {
        val all = pending.values.toList()
        pending.clear()
        all.forEach { it.completeExceptionally(RelayException(message)) }
    }

    private fun setStatus(s: RelayStatus) {
        _status.value = s
    }

    private fun enc(s: String) = URLEncoder.encode(s, Charsets.UTF_8)
}

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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
    KICKED("kicked"), BAD_KEY("bad-key"),
    /** The computer's owner turned off phones that speak an older protocol than it does. */
    UPDATE_REQUIRED("update-required");

    companion object {
        fun parse(s: String?) = entries.firstOrNull { it.wire == s } ?: INVALID
    }
}

data class WelcomedDevice(val id: String, val name: String, val platform: String)

data class RelayStatus(val state: RelayState, val detail: String? = null, val denied: DenyReason? = null)

/** A call failed. [refusal] is set when the computer refused the channel from a phone. */
class RelayException(message: String, val refusal: PhoneRefusal? = null) : Exception(message)

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
    /**
     * How long an open socket waits for the computer's challenge before taking it
     * for a computer from before protocol 4 (see [RelayClient]).
     */
    val challengeWaitMs: Long = 3_000,
    val requestTimeoutMs: Long = 120_000,
    /** Backoff knobs; tests shrink them. */
    val retryBaseMs: Long = 1_000,
    val retryMaxMs: Long = 30_000,
    val offlinePollMs: Long = 15_000,
)

/**
 * Relay v2 client: the phone side of `crates/nekko-remote` (and of
 * `packages/host/src/relay.ts`).
 *
 * Connects as `role=client`, then waits for the computer: when the relay
 * announces the connection, the computer seals a `{type:'challenge', challenge}`
 * to it, and the phone answers with the sealed HELLO `{type:'hello', deviceId,
 * name, platform, protocol: 4, challenge, pair?}` (the pairing code only while
 * enrolling). Each challenge is answered once. After the `welcome`, every
 * request is `{type:'req', id, seq, challenge, channel, args}`: `seq` is 1 for
 * the first request after each welcome and goes up by one, and `challenge` is
 * the one the welcomed HELLO answered, so a frame the relay recorded can't be
 * played to the computer again. A challenge while online means the computer
 * reset the handshake (it refused a HELLO or a request): the phone answers it,
 * starts `seq` again at 1, and keeps its calls in flight.
 *
 * A computer from before protocol 4 never challenges. If none arrives within
 * [RelayConfig.challengeWaitMs] of the socket opening (or of `agent-online`),
 * and this client has never been challenged, it sends the legacy HELLO
 * (`protocol: 3`, no challenge) and its requests carry `seq` only. Once it has
 * seen a challenge it never falls back: a socket without one is dropped and
 * dialed again, so a relay can't downgrade it.
 *
 * Replies come back as `{type:'res'}` and `{type:'event', channel, payload}`,
 * all E2E-sealed. Reconnects with backoff until closed. A port of the Expo
 * client with the same state machine.
 */
class RelayClient(
    private val config: RelayConfig,
    private val transport: WsTransport,
    private val scope: CoroutineScope,
) {
    private val lock = Any()
    private var conn: WsConnection? = null
    private var welcomed = false
    /** The challenge the last HELLO on this socket answered; null for a legacy HELLO. */
    private var answered: String? = null
    /** The socket the last HELLO went out on. */
    private var helloOn: WsConnection? = null
    /** What requests carry since the welcome: [answered] when it was welcomed. */
    private var reqChallenge: String? = null
    /** The last request's seq since the welcome. */
    private var seq = 0L
    /** This client has been challenged at least once, so it never sends a legacy HELLO. */
    private var challenged = false
    /** Bumped to cancel the pending challenge wait. */
    private var waitGen = 0L
    private var waitJob: Job? = null
    /** Holds a request's seq and its send together, so seqs reach the socket in order. */
    private val sendLock = Any()
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
            cancelWaitLocked()
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

    /**
     * The phone moved to another network (Wi-Fi to mobile data, airplane mode off):
     * the open socket, if any, is bound to the old one and would only be noticed
     * dead at the next ping. Drop it and dial again now, even if it looks online.
     * Calls in flight fail like on any lost connection. No-op once closed or denied.
     */
    fun reconnect() {
        val c: WsConnection?
        synchronized(lock) {
            if (stopped || state == RelayState.DENIED) return
            retryJob?.cancel(); retryJob = null
            retry = 0
            c = conn; conn = null
            welcomed = false
            cancelWaitLocked()
        }
        // conn is already null, so this socket's late onClosed is ignored.
        runCatching { c?.close(1000, "network changed") }
        if (c != null) failPending("connection lost")
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
        val id = nextId.getAndIncrement()
        val deferred = CompletableDeferred<JsonElement>()
        // The computer may re-challenge between the welcome and the send: wait for it again.
        var sent: SendResult
        var tries = 0
        while (true) {
            awaitReady()
            pending[id] = deferred
            sent = sendRequest(id, channel, JsonArray(args.toList()))
            if (sent == SendResult.SENT) break
            pending.remove(id)
            if (sent == SendResult.FAILED || ++tries >= SEND_ATTEMPTS) break
        }
        if (sent != SendResult.SENT) throw RelayException("Could not reach your computer.")
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
            state == RelayState.DENIED -> throw RelayException(deniedMessage())
            synchronized(lock) { stopped } -> throw RelayException("Not connected.")
        }
        try {
            withTimeout(config.handshakeTimeoutMs) {
                while (!isReady()) {
                    val s = status.first { it.state == RelayState.ONLINE || it.state == RelayState.DENIED || it.state == RelayState.IDLE }
                    if (s.state != RelayState.ONLINE) break
                    // Still marked online, but a challenge just restarted the handshake.
                    if (!isReady()) delay(STALE_ONLINE_POLL_MS)
                }
            }
        } catch (_: TimeoutCancellationException) {
            throw RelayException(if (state == RelayState.OFFLINE) "Your computer is offline." else "Could not reach your computer.")
        }
        if (!isReady()) throw RelayException(if (state == RelayState.DENIED) deniedMessage() else "Not connected.")
    }

    private fun deniedMessage() =
        if (_status.value.denied == DenyReason.UPDATE_REQUIRED) UPDATE_MESSAGE else "This phone is no longer paired."

    private fun isReady() = synchronized(lock) { welcomed && conn != null }

    private enum class SendResult { SENT, NOT_READY, FAILED }

    /** Seal and send one request with the next seq; NOT_READY when the handshake is not done. */
    private fun sendRequest(id: Long, channel: String, args: JsonArray): SendResult = synchronized(sendLock) {
        val c: WsConnection
        val n: Long
        val challenge: String?
        synchronized(lock) {
            c = conn ?: return SendResult.NOT_READY
            if (!welcomed) return SendResult.NOT_READY
            n = ++seq
            challenge = reqChallenge
        }
        val frame = buildJsonObject {
            put("type", "req"); put("id", id); put("seq", n)
            challenge?.let { put("challenge", it) }
            put("channel", channel); put("args", args)
        }
        val env = buildJsonObject { put("enc", E2E.seal(config.keyBytes, frame)) }
        if (c.send(env.toString())) SendResult.SENT else SendResult.FAILED
    }

    private fun dial() {
        val url = "${config.relayUrl.trimEnd('/')}/relay?role=client" +
            "&room=${enc(config.room)}&key=${enc(config.key)}"
        synchronized(lock) {
            if (stopped) return
            welcomed = false
            cancelWaitLocked()
        }
        setStatus(RelayStatus(RelayState.CONNECTING))
        lateinit var self: WsConnection
        // The transport may call back (onOpen on its own thread) before open() has
        // returned. Without this wait the socket wasn't current yet, the challenge
        // wait (or the HELLO) was skipped, and the call failed after the handshake timeout.
        // Bounded, so a transport that calls back inside open() on the same thread can't hang.
        val opened = CountDownLatch(1)
        fun ready() = opened.await(OPEN_WAIT_MS, TimeUnit.MILLISECONDS)
        val listener = object : WsListener {
            override fun onOpen() { if (ready() && isCurrent(self)) awaitChallenge(self, afterOpen = true) }
            override fun onMessage(text: String) { if (ready() && isCurrent(self)) onRaw(self, text) }
            override fun onClosed(code: Int, reason: String) { if (ready()) onSocketClosed(self, code, reason) }
        }
        val c = try {
            transport.open(url, listener)
        } catch (e: Exception) {
            scheduleRetry(e.message ?: "could not connect")
            return
        }
        self = c
        try {
            synchronized(lock) {
                if (stopped) { runCatching { c.close(1000, "closed by app") }; return }
                conn = c
            }
        } finally {
            opened.countDown()
        }
    }

    private fun isCurrent(c: WsConnection) = synchronized(lock) { conn === c }

    private fun onSocketClosed(c: WsConnection, code: Int, reason: String) {
        synchronized(lock) {
            if (conn !== c) return
            conn = null
            welcomed = false
            cancelWaitLocked()
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

    /**
     * Wait for the computer's challenge on [c]. Without one in time: the legacy
     * HELLO for a computer that has never challenged this client, else drop the
     * socket and dial again.
     */
    private fun awaitChallenge(c: WsConnection, afterOpen: Boolean) {
        val gen: Long
        synchronized(lock) {
            if (conn !== c || stopped) return
            // The challenge beat onOpen here and is already answered.
            if (afterOpen && helloOn === c) return
            cancelWaitLocked()
            gen = waitGen
            waitJob = scope.launch {
                delay(config.challengeWaitMs)
                onChallengeTimeout(c, gen)
            }
        }
    }

    private fun onChallengeTimeout(c: WsConnection, gen: Long) {
        val legacy: Boolean
        synchronized(lock) {
            if (conn !== c || waitGen != gen || welcomed || stopped) return
            waitJob = null
            legacy = !challenged
            if (!legacy) {
                // Seen a challenge before: no fallback. A fresh socket gets a fresh challenge.
                conn = null
                welcomed = false
            }
        }
        if (legacy) {
            hello(c, null)
            return
        }
        runCatching { c.close(1000, "no challenge") }
        failPending("connection lost")
        scheduleRetry("no challenge from the computer")
    }

    /** Stop waiting for a challenge. Call with [lock] held. */
    private fun cancelWaitLocked() {
        waitGen++
        waitJob?.cancel(); waitJob = null
    }

    /** The sealed HELLO on [c], answering [challenge]; null sends the legacy (protocol 3) one. */
    private fun hello(c: WsConnection, challenge: String?) {
        synchronized(lock) {
            if (conn !== c) return
            answered = challenge
            helloOn = c
        }
        sendSealed(c, buildJsonObject {
            put("type", "hello")
            put("deviceId", config.deviceId)
            put("name", config.deviceName)
            put("platform", config.platform)
            put("protocol", if (challenge != null) PhoneProtocol.VERSION else PhoneProtocol.LEGACY)
            challenge?.let { put("challenge", it) }
            pairCode?.let { put("pair", it) }
        })
    }

    private fun sendSealed(c: WsConnection, frame: JsonObject): Boolean = synchronized(sendLock) {
        val env = buildJsonObject { put("enc", E2E.seal(config.keyBytes, frame)) }
        c.send(env.toString())
    }

    private fun onRaw(c: WsConnection, raw: String) {
        val env = runCatching { WireJson.parseToJsonElement(raw) }.getOrNull().obj() ?: return
        val enc = env.str("enc")
        if (enc != null) {
            // Wrong key or tampered: drop silently, like the agent does.
            val frame = runCatching { E2E.open(config.keyBytes, enc) }.getOrNull().obj() ?: return
            onFrame(c, frame)
            return
        }
        when (env.str("type")) {
            "agent-offline" -> {
                synchronized(lock) {
                    welcomed = false
                    cancelWaitLocked()
                }
                setStatus(RelayStatus(RelayState.OFFLINE))
            }
            "agent-online" -> if (!synchronized(lock) { welcomed }) {
                // The computer (re)joined after us: it challenges this socket again.
                setStatus(RelayStatus(RelayState.CONNECTING))
                awaitChallenge(c, afterOpen = false)
            }
        }
    }

    private fun onFrame(c: WsConnection, frame: JsonObject) {
        when (frame.str("type")) {
            "challenge" -> {
                val challenge = frame.str("challenge")?.takeIf { it.isNotBlank() } ?: return
                val wasOnline: Boolean
                synchronized(lock) {
                    if (conn !== c) return
                    challenged = true
                    cancelWaitLocked()
                    wasOnline = welcomed
                    // A new handshake: requests wait for its welcome; calls in flight stay pending.
                    welcomed = false
                    reqChallenge = null
                    seq = 0
                }
                if (wasOnline) setStatus(RelayStatus(RelayState.CONNECTING))
                hello(c, challenge)
            }
            "welcome" -> {
                synchronized(lock) {
                    if (conn !== c) return
                    welcomed = true
                    retry = 0
                    cancelWaitLocked()
                    reqChallenge = answered
                    seq = 0
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
                    val text = (err as? JsonPrimitive)?.content ?: err.toString()
                    p.completeExceptionally(RelayException(text, PhoneRefusal.parse(text)))
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
            cancelWaitLocked()
            c = conn; conn = null
        }
        failPending(if (reason == DenyReason.UPDATE_REQUIRED) UPDATE_MESSAGE else "This phone is no longer paired.")
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

/** How long a socket callback waits for [RelayClient] to finish opening that socket. */
private const val OPEN_WAIT_MS = 5_000L

/** How often a call re-checks while the status still says online during a new handshake. */
private const val STALE_ONLINE_POLL_MS = 10L

/** A call to a computer that turned off phones on an older protocol. */
private const val UPDATE_MESSAGE = "Update this app to connect to your computer."

/** How many times a call waits for the handshake again when the computer re-challenged before it went out. */
private const val SEND_ATTEMPTS = 3

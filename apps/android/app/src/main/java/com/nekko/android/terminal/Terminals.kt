package com.nekko.android.terminal

import com.nekko.protocol.PhoneTerminal
import com.nekko.protocol.RelayException
import com.nekko.protocol.SshHost
import com.nekko.protocol.TerminalEvent
import com.nekko.protocol.TerminalKey
import com.nekko.protocol.TerminalKeys
import com.nekko.protocol.TerminalLimits
import com.nekko.protocol.TerminalOpened
import com.nekko.protocol.TerminalRefusal
import com.nekko.protocol.TerminalRequest
import com.nekko.protocol.TerminalScreen
import com.nekko.protocol.TerminalTail
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement

/** What the terminal screens need from the connected computer (AN-31). The repository is one; tests use a stand-in. */
interface TerminalBackend {
    /** A plain call (read-class channels, typing with a token, leaving). */
    suspend fun read(r: TerminalRequest): JsonElement
    /** A Change action, signed (the fingerprint, face or screen lock within 5 minutes). */
    suspend fun change(r: TerminalRequest): JsonElement
    /** Every `terminal:event` from the computer (only terminals this phone opened). */
    val events: Flow<TerminalEvent>
    /** The computer's name, for messages. */
    val computerName: String
}

/** An error as the owner should read it: the terminal refusals in plain words, else the (already reworded) message. */
internal fun describe(e: Throwable, computer: String): String =
    TerminalRefusal.code(e)?.let { TerminalRefusal.message(it, computer) } ?: e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t reach $computer."

/** What the Terminals screen draws. */
data class TerminalsState(
    val terminals: List<PhoneTerminal> = emptyList(),
    val hosts: List<SshHost> = emptyList(),
    val loading: Boolean = false,
    val loaded: Boolean = false,
    val error: String? = null,
    /** Why the hosts couldn't be read (no `~/.ssh/config`, Read turned off). */
    val hostsError: String? = null,
)

/** A chat's terminals and the computer's SSH hosts (chat → ⋮ → Terminals). The iPhone's `TerminalsModel`. */
class TerminalsController(
    val sessionId: String,
    private val backend: TerminalBackend,
    /** Outlives the screens: leaving a terminal runs here after its page is gone. */
    val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(TerminalsState())
    val state: StateFlow<TerminalsState> = _state.asStateFlow()

    /** The terminal on screen, kept here so opening or folding the phone (a new activity) keeps it open. */
    private val _active = MutableStateFlow<TerminalSession?>(null)
    val active: StateFlow<TerminalSession?> = _active.asStateFlow()

    fun show(session: TerminalSession) {
        _active.value = session
    }

    /** Back to the list: stop watching the terminal that was on screen. */
    fun hide() {
        val s = _active.value ?: return
        _active.value = null
        scope.launch { s.leave() }
    }

    suspend fun load() {
        _state.update { it.copy(loading = true) }
        val listed = try {
            Result.success(PhoneTerminal.list(backend.read(TerminalRequest.list(sessionId))))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }
        val hosts = try {
            Result.success(SshHost.list(backend.read(TerminalRequest.hosts())))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }
        _state.update {
            it.copy(
                terminals = listed.getOrDefault(it.terminals),
                error = listed.exceptionOrNull()?.let { e -> describe(e, backend.computerName) },
                hosts = hosts.getOrDefault(emptyList()),
                hostsError = hosts.exceptionOrNull()?.let { e -> describe(e, backend.computerName) },
                loading = false,
                loaded = true,
            )
        }
    }

    /** A new terminal in the chat's folder, opened on this phone. */
    suspend fun newTerminal(cols: Int, rows: Int): TerminalSession = opened(TerminalRequest.create(sessionId, cols, rows))

    /** An SSH session to one of the computer's hosts, opened on this phone. */
    suspend fun openSsh(host: SshHost, cols: Int, rows: Int): TerminalSession = opened(TerminalRequest.sshOpen(host.alias, sessionId, cols, rows))

    /** A terminal from the list, not opened yet ([TerminalSession.start]). */
    fun session(terminal: PhoneTerminal) = TerminalSession(terminal, backend, scope)

    private suspend fun opened(r: TerminalRequest): TerminalSession {
        val name = backend.computerName
        val opened = TerminalOpened.from(backend.change(r))
        val terminal = opened?.tail?.terminal ?: throw RelayException("$name didn’t open the terminal. Update Nekko Agent on $name.")
        val s = TerminalSession(terminal, backend, scope)
        s.apply(opened)
        scope.launch { load() }
        return s
    }
}

/**
 * One terminal open on the phone: its screen, typing with the token, resize,
 * leave and close. Output arrives as `terminal:event` for this terminal only.
 * The iPhone's `TerminalSession`.
 */
class TerminalSession(terminal: PhoneTerminal, private val backend: TerminalBackend, private val scope: CoroutineScope) {
    sealed interface State {
        data object Opening : State
        /** Attached: output streams, typing works. */
        data object Live : State
        /** The agent's command log: refresh to read more. */
        data object ReadOnly : State
        data class Exited(val code: Int?) : State
        data object Closed : State
        data class Failed(val message: String) : State
    }

    val terminalId: String = terminal.id
    private val _terminal = MutableStateFlow(terminal)
    val terminal: StateFlow<PhoneTerminal> = _terminal.asStateFlow()
    private val _state = MutableStateFlow<State>(State.Opening)
    val state: StateFlow<State> = _state.asStateFlow()
    /** Bumped whenever the screen changed, for the view to redraw. */
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version.asStateFlow()
    /** The last error of a write or resize, to show briefly. */
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    val screen = TerminalScreen()

    @Volatile private var token: String? = null
    private var listening: Job? = null
    /** The terminal's size when this phone opened it, restored on leaving. */
    private var originalSize: Pair<Int, Int>? = null
    /** Typing and resizing, in order, one call at a time (the iPhone's queue). */
    private sealed interface Op {
        data class Write(val text: String) : Op
        data class Resize(val cols: Int, val rows: Int) : Op
    }
    private val queue = Channel<Op>(Channel.UNLIMITED)
    private var drainer: Job? = null
    private val ops = Mutex()
    private var lastResync = 0L

    /** Whether typing is possible now. */
    val canType: Boolean get() = _state.value == State.Live && token != null

    /** Attach (a Change action: the fingerprint or screen lock within 5 minutes) and replay the tail, or for the agent's log just read it. */
    suspend fun start() {
        listen()
        if (_terminal.value.readOnly) return refresh()
        _state.value = State.Opening
        try {
            reopen()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.value = State.Failed(describe(e, backend.computerName))
        }
    }

    /** Read the tail again (the agent's log; or after the computer dropped output). */
    suspend fun refresh() {
        try {
            val tail = TerminalTail.from(backend.read(TerminalRequest.tail(terminalId))) ?: return
            replay(tail)
            if (_terminal.value.readOnly) _state.value = State.ReadOnly
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (_terminal.value.readOnly) _state.value = State.Failed(describe(e, backend.computerName)) else _error.value = describe(e, backend.computerName)
        }
    }

    /** The reply of `terminal:open` / `terminal:create` / `ssh:open`. */
    fun apply(opened: TerminalOpened) {
        listen()
        token = opened.token
        if (originalSize == null) originalSize = opened.tail.cols to opened.tail.rows
        replay(opened.tail)
        val t = opened.tail.terminal
        _state.value = if (t?.running == false) State.Exited(t.exitCode) else State.Live
    }

    private fun replay(tail: TerminalTail) {
        tail.terminal?.let { _terminal.value = it }
        synchronized(screen) {
            screen.reset()
            screen.resize(tail.cols, tail.rows)
            screen.feed(tail.buffer)
        }
        _version.update { it + 1 }
    }

    private suspend fun reopen() {
        val name = backend.computerName
        val opened = TerminalOpened.from(backend.change(TerminalRequest.open(terminalId)))
            ?: throw RelayException("$name didn’t open the terminal. Update Nekko Agent on $name.")
        apply(opened)
    }

    private fun listen() {
        if (listening != null) return
        listening = scope.launch { backend.events.collect { handle(it) } }
    }

    /** One `terminal:event` (every open session hears every one). */
    fun handle(event: TerminalEvent) {
        if (event.terminalId != terminalId) return
        when (event) {
            is TerminalEvent.Data -> {
                if (event.skipped > 0) {
                    // The computer dropped part of a flood: read where it stands now.
                    val now = System.currentTimeMillis()
                    if (now - lastResync > 1_000) {
                        lastResync = now
                        scope.launch { refresh() }
                    }
                    return
                }
                synchronized(screen) { screen.feed(event.text) }
                _version.update { it + 1 }
            }
            is TerminalEvent.Exit -> {
                _state.value = State.Exited(event.code)
                token = null
                _version.update { it + 1 }
            }
        }
    }

    // ---- typing ----

    /** Raw input: what a key or the command line produced. Sent in order, one call at a time. */
    fun send(text: String) {
        if (text.isEmpty()) return
        for (p in TerminalKeys.chunks(text)) queue.trySend(Op.Write(p))
        drain()
    }

    private fun drain() {
        if (drainer != null) return
        drainer = scope.launch {
            for (op in queue) {
                ops.withLock {
                    when (op) {
                        is Op.Write -> perform { TerminalRequest.write(terminalId, op.text, it) }
                        // Only the newest size matters.
                        is Op.Resize -> if (screen.cols == op.cols && screen.rows == op.rows) perform { TerminalRequest.resize(terminalId, op.cols, op.rows, it) }
                    }
                }
            }
        }
    }

    fun key(key: TerminalKey) {
        TerminalKeys.bytes(key, appCursor = screen.appCursor)?.let(::send)
    }

    fun paste(text: String) = send(TerminalKeys.paste(text, bracketed = screen.bracketedPaste))

    /** The command line: the whole line, then Return. */
    fun sendLine(text: String) = send(TerminalKeys.line(text))

    /** The phone's screen fits [cols] × [rows]: the terminal follows. */
    fun resize(cols: Int, rows: Int) {
        if (!canType || cols <= 0 || rows <= 0) return
        val c = minOf(cols, TerminalLimits.MAX_COLS)
        val r = minOf(rows, TerminalLimits.MAX_ROWS)
        if (c == screen.cols && r == screen.rows) return
        synchronized(screen) { screen.resize(c, r) }
        _version.update { it + 1 }
        queue.trySend(Op.Resize(c, r))
        drain()
    }

    private suspend fun perform(request: (String) -> TerminalRequest) {
        val t = token
        if (_state.value != State.Live || t == null) return
        try {
            backend.read(request(t))
            _error.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!TerminalRefusal.needsReopen(e)) {
                _error.value = describe(e, backend.computerName)
                return
            }
            // The token ended (idle, too old, the computer restarted): open again, then retry once.
            try {
                reopen()
                val fresh = token ?: return
                backend.read(request(fresh))
                _error.value = null
            } catch (e2: CancellationException) {
                throw e2
            } catch (e2: Exception) {
                _error.value = describe(e2, backend.computerName)
            }
        }
    }

    // ---- leaving ----

    /** Stop watching: the desktop's badge goes, the size it had comes back. */
    suspend fun leave() {
        listening?.cancel()
        listening = null
        drainer?.cancel()
        drainer = null
        val t = token
        if (_state.value != State.Live && t == null) return
        ops.withLock {
            val size = originalSize
            if (size != null && t != null && (size.first != screen.cols || size.second != screen.rows)) {
                runCatching { backend.read(TerminalRequest.resize(terminalId, size.first, size.second, t)) }
            }
            runCatching { backend.read(TerminalRequest.leave(terminalId)) }
        }
        token = null
        if (_state.value == State.Live) _state.value = State.Closed
    }

    /** Close the terminal on the computer (a Change action). */
    suspend fun close() {
        backend.change(TerminalRequest.close(terminalId))
        token = null
        _state.value = State.Closed
        listening?.cancel()
        listening = null
        drainer?.cancel()
        drainer = null
    }

    /** The connection came back: the computer forgot this phone's session, so open it again. */
    suspend fun reconnected() {
        if (_state.value != State.Live && _state.value != State.Opening) return
        try {
            reopen()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.value = State.Failed(describe(e, backend.computerName))
        }
    }
}

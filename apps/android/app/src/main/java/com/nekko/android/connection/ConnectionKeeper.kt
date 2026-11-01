package com.nekko.android.connection

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import androidx.core.content.ContextCompat
import com.nekko.android.chat.PhoneEvent
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.lock.AppLock
import com.nekko.protocol.AgentEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import com.nekko.protocol.LiveCard
import com.nekko.protocol.LiveCardState
import com.nekko.protocol.LiveLevel

/**
 * Keeps the relay connection healthy while the app is out of sight:
 *
 * - reconnects as soon as the phone's network changes ([NetworkChanges]);
 * - runs [KeepAliveService] while a chat on the computer is mid-run, so Android
 *   does not freeze the app and drop the socket ([KeepAlive.wanted]);
 * - turns the events that arrive meanwhile into local notifications ([Notices]).
 */
class ConnectionKeeper(
    private val context: Context,
    private val repo: ComputersRepository,
    private val prefs: PhonePrefs,
    private val lock: AppLock,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {
    val notices = Notices(context)

    private val foreground = MutableStateFlow(false)
    private val lastEventAt = MutableStateFlow(0L)

    private val _status = MutableStateFlow<KeepAlive.Status?>(null)
    /** What the keep-alive notification says while the service should run, else null. */
    val status: StateFlow<KeepAlive.Status?> = _status.asStateFlow()

    // The Lock Screen card (LiveCards): what each run is doing, the chat Next brought up, and the card.
    private val runs = MutableStateFlow<Map<String, LiveCards.Run>>(emptyMap())
    private val pinned = MutableStateFlow<String?>(null)
    private val _card = MutableStateFlow<LiveCardState?>(null)
    /** The card the keep-alive notification draws, else null (level None, or nothing to show). */
    val card: StateFlow<LiveCardState?> = _card.asStateFlow()
    /** Settings → Connection → Lock Screen card. */
    val level: StateFlow<LiveLevel?> get() = prefs.flow(LiveCards.LEVEL)

    fun start() {
        // The first level, once: Minimal with the app lock on, Standard with it off (as on the iPhone).
        if (prefs.get(LiveCards.LEVEL) == null) prefs.set(LiveCards.LEVEL, LiveCards.firstLevel(lock.enabled.value))
        watchNetwork()
        // Answered elsewhere, or its run ended: the needs-you notification goes.
        scope.launch { repo.dismissals.collect { notices.dismissNeedsYou(it) } }
        scope.launch {
            repo.events.collect { e ->
                lastEventAt.value = now()
                runs.update { m -> LiveCards.next(m[e.sessionId], e, seconds())?.let { m + (e.sessionId to it) } ?: m }
                onEvent(e.sessionId, PhoneEvent.of(e) ?: return@collect, (e as? AgentEvent.ApprovalRequired)?.approval?.call?.id)
            }
        }
        // A minute tick so a run that went silent stops the service after IDLE_LIMIT_MS.
        val tick = flow { while (true) { emit(Unit); delay(60_000) } }
        scope.launch {
            combine(prefs.flow(KeepAlive.ENABLED), repo.state, lastEventAt, tick) { on, s, last, _ ->
                val busy = s.activity.size
                val wanted = KeepAlive.wanted(on, s.conn, busy, now() - last)
                if (wanted) KeepAlive.status(busy, s.active?.name ?: "your computer") else null
            }.distinctUntilChanged().collect { line ->
                _status.value = line
                // In the app nothing needs keeping alive; on leaving, onForeground starts it.
                // A run that starts while the app is already in the background can only try:
                // Android 12+ refuses, and the connection lasts as long as the app is allowed to run.
                // The service stops itself when the status turns null.
                if (line != null && !foreground.value) startService()
            }
        }
        // Another computer: its runs are not this one's.
        scope.launch { repo.state.map { it.activeId }.distinctUntilChanged().collect { runs.value = emptyMap(); pinned.value = null } }
        scope.launch {
            combine(prefs.flow(LiveCards.LEVEL), repo.state, runs, pinned, tick) { level, s, r, pin, _ ->
                val built = LiveCard.build(LiveCards.chats(s.summaries, s.activity, r, seconds()), _card.value, pin, level ?: LiveLevel.MINIMAL, seconds())
                // Next holds its chat until another newly needs you, which takes the card.
                if (pin != null && built?.focusId != pin) pinned.value = null
                built
            }.distinctUntilChanged().collect { _card.value = it }
        }
    }

    /** The card's Next: bring up the chat after the one it shows. */
    fun nextOnCard() {
        val c = _card.value ?: return
        pinned.value = LiveCards.after(c.chats.map { it.id }, c.focusId)
    }

    private fun seconds(): Double = now() / 1000.0

    fun onForeground(visible: Boolean) {
        foreground.value = visible
        // Leaving the app is the last moment Android reliably lets us start the service.
        if (!visible && _status.value != null) startService()
    }

    private fun onEvent(sessionId: String, event: PhoneEvent, callId: String?) {
        // In the app the chat itself shows it (and A6's haptics react).
        if (foreground.value || !Notices.wants(prefs, event)) return
        val s = repo.state.value
        // Only the chats the phone lists: not subagents, tasks or training runs.
        val chat = s.summaries.firstOrNull { it.id == sessionId } ?: return
        notices.post(
            EventNotice.of(
                sessionId = sessionId,
                event = event,
                chatTitle = chat.title,
                computer = s.active?.name ?: "your computer",
                hideContent = lock.enabled.value,
                callId = callId,
            ),
        )
    }

    private fun startService() {
        try {
            ContextCompat.startForegroundService(context, Intent(context, KeepAliveService::class.java))
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (API 31+) when the app is already in
            // the background: the connection then lasts as long as Android lets the app run.
            Log.w(TAG, "keep-alive service not started: ${e.message}")
        }
    }

    private fun watchNetwork() {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        val changes = NetworkChanges(same = repo::setNetworkPath, changed = repo::networkChanged)
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) =
                    changes.onAvailable(network, RoutePolicy.path(cm.getNetworkCapabilities(network)))
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) =
                    changes.onPath(network, RoutePolicy.path(caps))
                override fun onLost(network: Network) = changes.onLost(network)
            })
        } catch (e: RuntimeException) {
            // TooManyRequestsException on a phone with too many callbacks registered: keep the backoff.
            Log.w(TAG, "network callback not registered: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "NekkoConnection"
    }
}

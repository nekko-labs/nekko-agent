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

    fun start() {
        watchNetwork()
        scope.launch {
            repo.events.collect { e ->
                lastEventAt.value = now()
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
    }

    fun onForeground(visible: Boolean) {
        foreground.value = visible
        // Leaving the app is the last moment Android reliably lets us start the service.
        if (!visible && _status.value != null) startService()
    }

    private fun onEvent(sessionId: String, event: PhoneEvent, callId: String?) {
        // In the app the chat itself shows it (and A6's haptics react).
        if (foreground.value || !prefs.get(Notices.ENABLED)) return
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

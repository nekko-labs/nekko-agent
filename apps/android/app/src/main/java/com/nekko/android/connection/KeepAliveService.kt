package com.nekko.android.connection

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import com.nekko.android.NekkoApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.combine
import com.nekko.protocol.LiveLevel

/**
 * Foreground service that keeps the app (and so the relay socket) alive while a
 * chat on the computer runs. It holds no connection of its own: being a
 * foreground service is what stops Android from freezing the process. It stops
 * itself as soon as [ConnectionKeeper.status] says nothing is running.
 *
 * Type `remoteMessaging` (Android 14+): it relays a conversation between the
 * user's computer and phone, needs no runtime permission, and has no time limit
 * (unlike `dataSync`, capped at 6 h a day from Android 15).
 */
class KeepAliveService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var started = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val keeper = (application as NekkoApp).connection
        val line = keeper.status.value
        // startForeground must follow startForegroundService, even when we are about to stop.
        ServiceCompat.startForeground(
            this,
            Notices.ID_KEEP_ALIVE,
            keeper.notices.keepAlive(line ?: KeepAlive.FINISHING, keeper.card.value, keeper.level.value ?: LiveLevel.NONE),
            if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0,
        )
        if (!started) {
            started = true
            scope.launch {
                // The counts, or the Lock Screen card when its level is on and it has chats.
                combine(keeper.status, keeper.card, keeper.level) { l, card, level -> Triple(l, card, level) }.collect { (l, card, level) ->
                    if (l == null) {
                        ServiceCompat.stopForeground(this@KeepAliveService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                        stopSelf()
                    } else {
                        runCatching {
                            NotificationManagerCompat.from(this@KeepAliveService)
                                .notify(Notices.ID_KEEP_ALIVE, keeper.notices.keepAlive(l, card, level ?: LiveLevel.NONE))
                        }
                    }
                }
            }
        }
        // Not sticky: if Android kills the app, there is no run to keep alive any more.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}

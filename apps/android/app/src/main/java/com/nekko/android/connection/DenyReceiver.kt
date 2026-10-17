package com.nekko.android.connection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.nekko.android.NekkoApp
import com.nekko.protocol.Channels
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive

/**
 * The approval notification's **Deny**: answers the waiting tool call with
 * `tool:approve(sessionId, callId, false)` over the live connection, without
 * opening the app. Not exported: only the app's own notification reaches it.
 */
class DenyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val sessionId = intent.getStringExtra(SESSION) ?: return
        val callId = intent.getStringExtra(CALL) ?: return
        val app = context.applicationContext as? NekkoApp ?: return
        val done = goAsync()
        scope.launch {
            try {
                withTimeout(TIMEOUT_MS) {
                    app.computers.caller.call(Channels.TOOL_APPROVE, JsonPrimitive(sessionId), JsonPrimitive(callId), JsonPrimitive(false))
                }
                app.connection.notices.clear(sessionId)
            } catch (e: Exception) {
                // Offline or already answered: the notification stays, and opening it shows the chat.
                Log.w(TAG, "deny from the notification failed: ${e.message}")
            } finally {
                done.finish()
            }
        }
    }

    companion object {
        const val ACTION = "com.nekko.android.DENY"
        const val SESSION = "sessionId"
        const val CALL = "callId"
        private const val TAG = "NekkoDeny"
        // goAsync allows about 10 s before Android calls it an ANR.
        private const val TIMEOUT_MS = 8_000L
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}

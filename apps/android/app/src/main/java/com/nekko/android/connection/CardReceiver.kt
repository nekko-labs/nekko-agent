package com.nekko.android.connection

import android.app.PendingIntent
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
 * The Lock Screen card's buttons ([LiveCards], [Notices.keepAlive]): Allow the
 * waiting tool (the action asks Android for an unlocked phone first), Stop the
 * run, or bring up the Next chat. Deny is [DenyReceiver], as on the approval
 * notification. Each answers over the live connection the keep-alive service
 * holds; offline or already answered, nothing changes and the card stays.
 */
class CardReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as? NekkoApp ?: return
        val sessionId = intent.getStringExtra(SESSION) ?: return
        if (intent.action == NEXT) {
            app.connection.nextOnCard()
            return
        }
        val done = goAsync()
        scope.launch {
            try {
                withTimeout(TIMEOUT_MS) {
                    when (intent.action) {
                        ALLOW -> {
                            val callId = intent.getStringExtra(CALL) ?: return@withTimeout
                            app.computers.caller.call(Channels.TOOL_APPROVE, JsonPrimitive(sessionId), JsonPrimitive(callId), JsonPrimitive(true))
                            app.connection.notices.clear(sessionId)
                        }
                        STOP -> app.computers.caller.call(Channels.CHAT_ABORT, JsonPrimitive(sessionId))
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "${intent.action} from the card failed: ${e.message}")
            } finally {
                done.finish()
            }
        }
    }

    companion object {
        const val ALLOW = "com.nekko.android.card.ALLOW"
        const val STOP = "com.nekko.android.card.STOP"
        const val NEXT = "com.nekko.android.card.NEXT"
        private const val SESSION = "sessionId"
        private const val CALL = "callId"
        private const val TAG = "NekkoCard"
        // goAsync allows about 10 s before Android calls it an ANR.
        private const val TIMEOUT_MS = 8_000L
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        fun intent(context: Context, action: String, sessionId: String, callId: String? = null): PendingIntent {
            val i = Intent(context, CardReceiver::class.java).setAction(action).putExtra(SESSION, sessionId).putExtra(CALL, callId)
            // One request code per action and chat, so a button never carries another chat's call.
            return PendingIntent.getBroadcast(context, (action + sessionId).hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
    }
}

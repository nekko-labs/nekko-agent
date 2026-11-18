package com.nekko.android.connection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import com.nekko.android.NekkoApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Android Auto's **Reply** and **Mark as read** on a chat's car notification (#2782). Android Auto
 * reads the dictated words back and asks before it sends them. The words go to that chat through
 * the outbox, on the active computer only (as CarPlay): they wait there while it is offline. The
 * notification then shows the reply as sent, so the car stops waiting. Not exported.
 */
class CarReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(SESSION) ?: return
        val app = context.applicationContext as? NekkoApp ?: return
        val notices = app.connection.notices
        when (intent.action) {
            ACTION_READ -> notices.clearCar(sessionId)
            ACTION_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY)?.toString()?.trim().orEmpty()
                if (text.isEmpty()) return
                val done = goAsync()
                scope.launch {
                    try {
                        val repo = app.computers
                        val computer = intent.getStringExtra(COMPUTER)
                        // Only the computer the phone is on: its outbox is the one that reaches it.
                        val sent = computer != null && computer == repo.state.value.activeId && repo.state.value.summaries.any { it.id == sessionId }
                        if (sent) {
                            repo.outbox.add(sessionId, text)
                            repo.outbox.flushSoon()
                        }
                        notices.carReplied(sessionId, text, sent)
                    } finally {
                        done.finish()
                    }
                }
            }
        }
    }

    companion object {
        const val ACTION_REPLY = "com.nekko.android.CAR_REPLY"
        const val ACTION_READ = "com.nekko.android.CAR_READ"
        const val SESSION = "sessionId"
        const val COMPUTER = "computerId"
        const val KEY = "reply"
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    }
}

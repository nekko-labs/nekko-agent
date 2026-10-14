package com.nekko.android.connection

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.nekko.android.MainActivity
import com.nekko.android.R
import com.nekko.android.chat.PhoneEvent
import com.nekko.android.data.PhonePrefs

/** The app's notification channels and the local notifications about computer chats. */
class Notices(private val context: Context) {
    private val manager = NotificationManagerCompat.from(context)

    init {
        createChannels()
    }

    /** Notifications need POST_NOTIFICATIONS on Android 13+; the user can also turn them off. */
    fun allowed(): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return manager.areNotificationsEnabled()
    }

    fun post(n: EventNotice) {
        if (!allowed()) return
        val notification = NotificationCompat.Builder(context, if (n.needsYou) CHANNEL_NEEDS_YOU else CHANNEL_REPLIES)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(n.title)
            .setContentText(n.text)
            .setCategory(if (n.needsYou) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (n.needsYou) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            // Text is already free of content; PRIVATE still hides it on a secure lock screen.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(openChat(n.sessionId))
            .build()
        try {
            manager.notify(EventNotice.tag(n.sessionId), ID_EVENT, notification)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the post.
        }
    }

    /** The chat was opened: its notification is no longer news. */
    fun clear(sessionId: String) = manager.cancel(EventNotice.tag(sessionId), ID_EVENT)

    /** The ongoing notification of [KeepAliveService]; tapping it opens the app. */
    fun keepAlive(line: String): Notification =
        NotificationCompat.Builder(context, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Staying connected")
            .setContentText(line)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openApp())
            .build()

    private fun openChat(sessionId: String): PendingIntent {
        // The same deep link as nekko-agent://chat/<id>; it goes through the app lock like any other.
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nekko-agent://chat/${Uri.encode(sessionId)}"), context, MainActivity::class.java)
        return PendingIntent.getActivity(context, sessionId.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun openApp(): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_NEEDS_YOU, "Approvals and questions", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "A chat on your computer is waiting for you"
                },
                NotificationChannel(CHANNEL_REPLIES, "Replies", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "A reply on your computer finished or failed"
                },
                NotificationChannel(CHANNEL_CONNECTION, "Connection", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while the app stays connected for a running chat"
                    setShowBadge(false)
                },
            ),
        )
    }

    companion object {
        /** Settings → Connection → Notify me. Only applies while the app is out of sight. */
        val ENABLED = PhonePrefs.boolean("notify_events", default = true)

        const val CHANNEL_NEEDS_YOU = "needs_you"
        const val CHANNEL_REPLIES = "replies"
        const val CHANNEL_CONNECTION = "connection"
        const val ID_EVENT = 1
        const val ID_KEEP_ALIVE = 2

        /** Which channel a [PhoneEvent] goes to. */
        fun channelOf(e: PhoneEvent) = if (e == PhoneEvent.APPROVAL || e == PhoneEvent.NEEDS_INPUT) CHANNEL_NEEDS_YOU else CHANNEL_REPLIES
    }
}

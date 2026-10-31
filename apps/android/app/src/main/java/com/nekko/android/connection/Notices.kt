package com.nekko.android.connection

import com.nekko.protocol.LiveLevel
import com.nekko.protocol.LiveChatState
import com.nekko.protocol.LiveCardState
import com.nekko.protocol.E2E

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

    /** The chats with a needs-you notification up, by their tag: what a relay `dismiss` can take down. */
    private val needsYou = java.util.concurrent.ConcurrentHashMap<String, String>()

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
            .apply {
                // Deny is safe to answer unseen (nothing runs), so it skips the app lock;
                // Allow needs the command in view, so it is only in the chat.
                if (n.canDeny) addAction(0, "Deny", deny(n.sessionId, n.callId!!))
            }
            .build()
        if (n.needsYou) needsYou[E2E.activityTag(n.sessionId)] = n.sessionId else needsYou.values.remove(n.sessionId)
        try {
            manager.notify(EventNotice.tag(n.sessionId), ID_EVENT, notification)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the post.
        }
    }

    /** The chat was opened: its notification is no longer news. */
    fun clear(sessionId: String) {
        needsYou.values.remove(sessionId)
        manager.cancel(EventNotice.tag(sessionId), ID_EVENT)
    }

    /**
     * An approval or a question was answered somewhere (the desktop, another
     * phone, this one) or its run ended: the relay's `dismiss` names the chat by
     * its tag, and its needs-you notification goes. A finished or failed one stays.
     */
    fun dismissNeedsYou(tag: String) {
        val sessionId = needsYou.remove(tag) ?: return
        manager.cancel(EventNotice.tag(sessionId), ID_EVENT)
    }

    /**
     * *Send a test notification*: one shown by the app now, on the approvals
     * channel. Android has no push from the relay yet (AN-6), so this is what
     * a notification from a chat looks like while the app runs in the background.
     */
    fun postTest(computer: String): Boolean {
        if (!allowed()) return false
        val notification = NotificationCompat.Builder(context, CHANNEL_NEEDS_YOU)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Test from Nekko Agent")
            .setContentText("Notifications from $computer will look like this.")
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build()
        return try {
            manager.notify(TAG_TEST, ID_EVENT, notification)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    /**
     * The ongoing notification of [KeepAliveService]. On Android 16+ it asks to
     * be a Live Update: a chip in the status bar and a place at the top of the
     * lock screen, like the iPhone's Live Activity. The user can turn that off
     * per app; it then stays an ordinary ongoing notification.
     *
     * With a [card] it is the Lock Screen card ([LiveCards]): the chat that most
     * needs you, its live step, and its buttons. Minimal shows no chat text;
     * Standard adds the chat's short title, its step and Allow; Detailed adds the
     * reply line. At Standard and Detailed a locked phone that hides sensitive
     * content shows the Minimal words. Without a card it says counts only.
     */
    fun keepAlive(status: KeepAlive.Status, card: LiveCardState? = null, level: LiveLevel = LiveLevel.NONE): Notification {
        val focused = card?.focused
        if (card == null || focused == null || level == LiveLevel.NONE) {
            return base(status.chip)
                .setContentTitle("Staying connected")
                .setContentText(status.line)
                .setContentIntent(openApp())
                .build()
        }
        val generic = LiveCards.generic(focused.state)
        val others = card.chats.size - 1 + card.more
        val count = if (others > 0) "+$others more" else null
        val chip = if (focused.state == LiveChatState.NEEDS_YOU) "Needs you" else status.chip
        fun minimal() = base(chip)
            .setContentTitle(generic)
            .setContentText(count ?: status.line)
        val b = if (level == LiveLevel.MINIMAL) {
            minimal().setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        } else {
            val text = focused.step.ifEmpty { generic }
            base(chip)
                .setContentTitle(focused.short.ifEmpty { generic })
                .setContentText(text)
                .setSubText(count)
                .setStyle(NotificationCompat.BigTextStyle().bigText(if (focused.reply.isNotEmpty()) "$text\n${focused.reply}" else text))
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(minimal().setContentIntent(openApp()).build())
        }
        if (focused.startedAt != null && (focused.state == LiveChatState.WORKING || focused.state == LiveChatState.NEEDS_YOU)) {
            b.setWhen((focused.startedAt!! * 1000).toLong()).setUsesChronometer(true).setShowWhen(true)
        }
        b.setContentIntent(openChat(focused.id))
        val callId = focused.callId
        when {
            focused.state == LiveChatState.NEEDS_YOU && callId != null -> {
                // Allow needs an unlocked phone (Android 12+); below that it stays in the chat. Deny is safe unseen.
                if (level != LiveLevel.MINIMAL && Build.VERSION.SDK_INT >= 31) {
                    b.addAction(
                        NotificationCompat.Action.Builder(0, "Allow", CardReceiver.intent(context, CardReceiver.ALLOW, focused.id, callId))
                            .setAuthenticationRequired(true)
                            .build(),
                    )
                }
                b.addAction(0, "Deny", deny(focused.id, callId))
            }
            focused.state == LiveChatState.WORKING -> b.addAction(0, "Stop", CardReceiver.intent(context, CardReceiver.STOP, focused.id))
        }
        if (others > 0) b.addAction(0, "Next", CardReceiver.intent(context, CardReceiver.NEXT, focused.id))
        return b.build()
    }

    private fun base(chip: String) = NotificationCompat.Builder(context, CHANNEL_CONNECTION)
        .setSmallIcon(R.drawable.ic_launcher_foreground)
        .setRequestPromotedOngoing(true)
        .setShortCriticalText(chip)
        .setOngoing(true)
        .setSilent(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

    private fun openChat(sessionId: String): PendingIntent {
        // The same deep link as nekko-agent://chat/<id>; it goes through the app lock like any other.
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nekko-agent://chat/${Uri.encode(sessionId)}"), context, MainActivity::class.java)
        return PendingIntent.getActivity(context, sessionId.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun deny(sessionId: String, callId: String): PendingIntent {
        val intent = Intent(context, DenyReceiver::class.java)
            .setAction(DenyReceiver.ACTION)
            .putExtra(DenyReceiver.SESSION, sessionId)
            .putExtra(DenyReceiver.CALL, callId)
        return PendingIntent.getBroadcast(context, sessionId.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
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
        /**
         * The single *Notify me* switch from before the per-kind ones: read once
         * to start them as it was ([migrate]), and kept in step for older code paths.
         */
        val ENABLED = PhonePrefs.boolean("notify_events", default = true)

        /** *Notify me about* (the iPhone's IO-30): one switch per kind, only while the app is out of sight. */
        val NEEDS_YOU = PhonePrefs.boolean("notify.needs_you", default = true)
        val FINISHED = PhonePrefs.boolean("notify.finished", default = true)
        val FAILED = PhonePrefs.boolean("notify.failed", default = true)
        private val MIGRATED = PhonePrefs.boolean("notify.kinds_migrated", default = false)

        /** Each kind starts as the old single switch was, once. */
        fun migrate(prefs: PhonePrefs) {
            if (prefs.get(MIGRATED)) return
            val was = prefs.get(ENABLED)
            listOf(NEEDS_YOU, FINISHED, FAILED).forEach { prefs.set(it, was) }
            prefs.set(MIGRATED, true)
        }

        /** The switch for [e]'s kind. */
        fun keyOf(e: PhoneEvent) = when (e) {
            PhoneEvent.APPROVAL, PhoneEvent.NEEDS_INPUT -> NEEDS_YOU
            PhoneEvent.FINISHED -> FINISHED
            PhoneEvent.FAILED -> FAILED
        }

        /** Whether the user wants a notification for [e]. */
        fun wants(prefs: PhonePrefs, e: PhoneEvent): Boolean {
            migrate(prefs)
            return prefs.get(keyOf(e))
        }

        /** All kinds on or off at once (the first run's answer). */
        fun setAll(prefs: PhonePrefs, on: Boolean) {
            migrate(prefs)
            listOf(NEEDS_YOU, FINISHED, FAILED).forEach { prefs.set(it, on) }
            prefs.set(ENABLED, on)
        }

        const val TAG_TEST = "test"

        const val CHANNEL_NEEDS_YOU = "needs_you"
        const val CHANNEL_REPLIES = "replies"
        const val CHANNEL_CONNECTION = "connection"
        const val ID_EVENT = 1
        const val ID_KEEP_ALIVE = 2

        /** Which channel a [PhoneEvent] goes to. */
        fun channelOf(e: PhoneEvent) = if (e == PhoneEvent.APPROVAL || e == PhoneEvent.NEEDS_INPUT) CHANNEL_NEEDS_YOU else CHANNEL_REPLIES
    }
}

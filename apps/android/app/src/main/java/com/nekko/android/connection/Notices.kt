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
            .setContentTitle(title(n))
            .setContentText(text(n))
            .setCategory(if (n.needsYou) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (n.needsYou) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            // Text is already free of content; PRIVATE still hides it on a secure lock screen.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(openChat(n.sessionId))
            .apply {
                // Deny is safe to answer unseen (nothing runs), so it skips the app lock;
                // Allow needs the command in view, so it is only in the chat.
                if (n.canDeny) addAction(0, context.getString(R.string.chat_notice_deny), deny(n.sessionId, n.callId!!))
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
            .setContentTitle(context.getString(R.string.chat_notice_test_title))
            .setContentText(context.getString(R.string.chat_notice_test_text, computer))
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
            return base(chip(status))
                .setContentTitle(context.getString(R.string.chat_notice_staying_connected))
                .setContentText(line(status))
                .setContentIntent(openApp())
                .build()
        }
        val generic = generic(focused.state)
        val others = card.chats.size - 1 + card.more
        val count = if (others > 0) context.getString(R.string.chat_card_more, others) else null
        val chip = if (focused.state == LiveChatState.NEEDS_YOU) generic(LiveChatState.NEEDS_YOU) else chip(status)
        fun minimal() = base(chip)
            .setContentTitle(generic)
            .setContentText(count ?: line(status))
        val b = if (level == LiveLevel.MINIMAL) {
            minimal().setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        } else {
            val text = step(focused.step).ifEmpty { generic }
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
                        NotificationCompat.Action.Builder(0, context.getString(R.string.chat_card_allow), CardReceiver.intent(context, CardReceiver.ALLOW, focused.id, callId))
                            .setAuthenticationRequired(true)
                            .build(),
                    )
                }
                b.addAction(0, context.getString(R.string.chat_notice_deny), deny(focused.id, callId))
            }
            focused.state == LiveChatState.WORKING -> b.addAction(0, context.getString(R.string.chat_card_stop), CardReceiver.intent(context, CardReceiver.STOP, focused.id))
        }
        if (others > 0) b.addAction(0, context.getString(R.string.chat_card_next), CardReceiver.intent(context, CardReceiver.NEXT, focused.id))
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

    /** [LiveCards.generic] in the phone's language. */
    private fun generic(state: LiveChatState): String = context.getString(
        when (state) {
            LiveChatState.NEEDS_YOU -> R.string.chat_card_needs_you
            LiveChatState.WORKING -> R.string.chat_card_working
            LiveChatState.WATCHING -> R.string.chat_card_watching
            LiveChatState.DONE -> R.string.chat_card_done
            LiveChatState.FAILED -> R.string.chat_card_failed
        },
    )

    /** A card step in the phone's language when it is one of [LiveCards]' own words; a tool label or question stays as it is. */
    private fun step(step: String): String = when (step) {
        "Writing…" -> context.getString(R.string.chat_card_writing)
        "Thinking…" -> context.getString(R.string.chat_card_thinking)
        else -> LiveChatState.entries.firstOrNull { LiveCards.generic(it) == step }?.let(::generic) ?: step
    }

    /** [EventNotice]'s title in the phone's language: it is English, by the event's kind. */
    private fun title(n: EventNotice): String = context.getString(
        when (n.event) {
            PhoneEvent.FINISHED -> R.string.chat_notice_reply_ready
            PhoneEvent.FAILED -> R.string.chat_notice_reply_failed
            PhoneEvent.NEEDS_INPUT -> R.string.chat_notice_question_waiting
            PhoneEvent.APPROVAL -> R.string.chat_notice_approval_needed
        },
    )

    /**
     * [EventNotice]'s line in the phone's language. Its two fixed forms are
     * recognised by building them again; "chat · computer" has no words of its own.
     */
    private fun text(n: EventNotice): String {
        val hidden = EventNotice.of(n.sessionId, n.event, null, "", hideContent = true).text
        if (n.text == hidden) return context.getString(R.string.chat_notice_open_to_see)
        val computer = n.text.removePrefix(A_CHAT_ON)
        if (computer != n.text && EventNotice.of(n.sessionId, n.event, null, computer, hideContent = false).text == n.text) {
            return context.getString(R.string.chat_notice_a_chat_on, computer)
        }
        return n.text
    }

    /** The keep-alive line in the phone's language, from the count and computer [KeepAlive.line] put in it. */
    private fun line(status: KeepAlive.Status): String {
        if (status == KeepAlive.FINISHING) return context.getString(R.string.chat_notice_finishing_up)
        val m = KEEP_ALIVE_LINE.matchEntire(status.line) ?: return status.line
        val busy = m.groupValues[1].toIntOrNull() ?: return status.line
        val computer = m.groupValues[2]
        if (KeepAlive.line(busy, computer) != status.line) return status.line
        return if (busy == 1) context.getString(R.string.chat_notice_running_one, computer) else context.getString(R.string.chat_notice_running_other, busy, computer)
    }

    /** The Live Update's chip in the phone's language: "Running" or "N running". */
    private fun chip(status: KeepAlive.Status): String {
        if (status.chip == KeepAlive.chip(1)) return context.getString(R.string.chat_notice_chip_running)
        val busy = status.chip.substringBefore(' ').toIntOrNull() ?: return status.chip
        return if (KeepAlive.chip(busy) == status.chip) context.getString(R.string.chat_notice_chip_n_running, busy) else status.chip
    }

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
                NotificationChannel(CHANNEL_NEEDS_YOU, context.getString(R.string.chat_channel_needs_you), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = context.getString(R.string.chat_channel_needs_you_description)
                },
                NotificationChannel(CHANNEL_REPLIES, context.getString(R.string.chat_channel_replies), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = context.getString(R.string.chat_channel_replies_description)
                },
                NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.chat_channel_connection), NotificationManager.IMPORTANCE_LOW).apply {
                    description = context.getString(R.string.chat_channel_connection_description)
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

        /** The start of [EventNotice]'s line for a chat without a title. */
        private const val A_CHAT_ON = "A chat on "

        /** [KeepAlive.line]: "1 chat running on Mac", "3 chats running on Mac". */
        private val KEEP_ALIVE_LINE = Regex("""(\d+) chats? running on (.+)""", RegexOption.DOT_MATCHES_ALL)

        const val CHANNEL_NEEDS_YOU = "needs_you"
        const val CHANNEL_REPLIES = "replies"
        const val CHANNEL_CONNECTION = "connection"
        const val ID_EVENT = 1
        const val ID_KEEP_ALIVE = 2

        /** Which channel a [PhoneEvent] goes to. */
        fun channelOf(e: PhoneEvent) = if (e == PhoneEvent.APPROVAL || e == PhoneEvent.NEEDS_INPUT) CHANNEL_NEEDS_YOU else CHANNEL_REPLIES
    }
}

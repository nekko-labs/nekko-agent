package com.nekko.android.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.text.format.DateUtils
import android.widget.RemoteViews
import com.nekko.android.MainActivity
import com.nekko.android.R

/** The "Needs you" Home Screen widget. It only reads the snapshot the app saves; tapping it opens the app. */
class StatusWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val views = render(context, StatusStore(context).load())
        ids.forEach { manager.updateAppWidget(it, views) }
    }

    companion object {
        /** Redraws every placed widget from the saved snapshot. */
        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, StatusWidget::class.java))
            if (ids.isEmpty()) return
            val views = render(context, StatusStore(context).load())
            ids.forEach { manager.updateAppWidget(it, views) }
        }

        private fun render(context: Context, s: StatusSnapshot): RemoteViews =
            RemoteViews(context.packageName, R.layout.widget_status).apply {
                setTextViewText(R.id.widget_computer, s.computer ?: "Nekko Agent")
                val headline = s.headline(context)
                setTextViewText(R.id.widget_headline, headline)
                setImageViewResource(R.id.widget_dot, if (s.online) R.drawable.widget_dot_online else R.drawable.widget_dot_offline)
                val age = if (s.at > 0) context.getString(R.string.chat_widget_updated, DateUtils.getRelativeTimeSpanString(s.at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)) else ""
                setTextViewText(R.id.widget_age, age)
                setContentDescription(R.id.widget_root, listOfNotNull(s.computer, headline, context.getString(if (s.online) R.string.chat_widget_online else R.string.chat_widget_offline)).joinToString(", "))
                val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                setOnClickPendingIntent(
                    R.id.widget_root,
                    PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
                )
            }
    }
}

/** [StatusSnapshot.headline] in the phone's language (the snapshot itself stays English, as its tests read it). */
internal fun StatusSnapshot.headline(context: Context): String = when {
    computer == null -> context.getString(R.string.chat_widget_not_paired)
    needsYou > 0 -> if (needsYou == 1) context.getString(R.string.chat_widget_needs_you_one) else context.getString(R.string.chat_widget_needs_you_other, needsYou)
    running > 0 -> if (running == 1) context.getString(R.string.chat_widget_working_one) else context.getString(R.string.chat_widget_working_other, running)
    online -> context.getString(R.string.chat_widget_all_quiet)
    else -> context.getString(R.string.chat_widget_offline_headline)
}

/** [StatusSnapshot.tileDescription] in the phone's language. */
internal fun StatusSnapshot.tileDescription(context: Context): String {
    val computer = computer ?: return context.getString(R.string.chat_widget_tile_not_paired)
    // Mid-sentence the headline is lower case, as in English; German keeps its capital nouns.
    val locale = context.resources.configuration.locales[0]
    val headline = headline(context).let { if (locale.language == "de") it else it.lowercase(locale) }
    return context.getString(R.string.chat_widget_tile_description, computer, headline)
}

/** The snapshot in plain preferences: counts, the computer's name and a time. Nothing secret. */
class StatusStore(context: Context) {
    private val prefs = context.getSharedPreferences("widget.status", Context.MODE_PRIVATE)

    fun load(): StatusSnapshot = StatusSnapshot(
        computer = prefs.getString("computer", null),
        online = prefs.getBoolean("online", false),
        needsYou = prefs.getInt("needsYou", 0),
        running = prefs.getInt("running", 0),
        at = prefs.getLong("at", 0),
    )

    fun save(s: StatusSnapshot) {
        prefs.edit()
            .putString("computer", s.computer)
            .putBoolean("online", s.online)
            .putInt("needsYou", s.needsYou)
            .putInt("running", s.running)
            .putLong("at", s.at)
            .apply()
    }
}

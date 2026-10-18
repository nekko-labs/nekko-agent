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
                setTextViewText(R.id.widget_headline, s.headline)
                setImageViewResource(R.id.widget_dot, if (s.online) R.drawable.widget_dot_online else R.drawable.widget_dot_offline)
                val age = if (s.at > 0) "Updated " + DateUtils.getRelativeTimeSpanString(s.at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS) else ""
                setTextViewText(R.id.widget_age, age)
                setContentDescription(R.id.widget_root, listOfNotNull(s.computer, s.headline, if (s.online) "online" else "offline").joinToString(", "))
                val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                setOnClickPendingIntent(
                    R.id.widget_root,
                    PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
                )
            }
    }
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

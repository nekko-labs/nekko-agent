package com.nekko.android.widget

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.nekko.android.MainActivity
import com.nekko.android.R

/**
 * The Quick Settings tile: the widget's counts one swipe down, from any app.
 * It reads the same saved snapshot as the Home Screen widget (counts only,
 * never chat titles) and never connects to the computer itself. Tapping it
 * opens the app, through the app lock as usual.
 */
class StatusTile : TileService() {
    override fun onStartListening() {
        val tile = qsTile ?: return
        val s = StatusStore(this).load()
        tile.label = getString(R.string.app_name)
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = s.headline(this)
        tile.state = if (s.tileActive) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.contentDescription = s.tileDescription(this)
        tile.icon = Icon.createWithResource(this, R.drawable.ic_tile_status)
        tile.updateTile()
    }

    override fun onClick() {
        val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
        } else {
            openBefore34(open)
        }
    }

    /** Android 13 and older have only the Intent form (it throws from 14 on, which never reaches here). */
    @SuppressLint("StartActivityAndCollapseDeprecated")
    @Suppress("DEPRECATION")
    private fun openBefore34(open: Intent) = startActivityAndCollapse(open)

    companion object {
        /** The counts changed: ask the system to redraw the tile if it is in the panel. */
        fun refresh(context: Context) {
            runCatching { requestListeningState(context, ComponentName(context, StatusTile::class.java)) }
        }
    }
}

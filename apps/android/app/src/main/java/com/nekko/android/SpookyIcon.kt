package com.nekko.android

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import java.time.LocalDate
import java.time.Month

/**
 * The Spooky theme's limited launcher icon (#2118, the iPhone's SpookyIcon): a fall night behind
 * the cat, from October 1 through Halloween. Outside the season, or on any other theme, the app
 * keeps its usual icon. The two icons are activity aliases of MainActivity; exactly one is enabled.
 */
object SpookyIcon {
    /** The Spooky theme's preset id. */
    const val PRESET = "autumn"
    private const val DEFAULT = "com.nekko.android.LauncherDefault"
    private const val SPOOKY = "com.nekko.android.LauncherSpooky"

    fun inSeason(date: LocalDate = LocalDate.now()): Boolean = date.month == Month.OCTOBER

    /** Whether the Spooky icon should show. */
    fun wanted(spooky: Boolean, date: LocalDate = LocalDate.now()): Boolean = spooky && inSeason(date)

    /** Switch only when it changes: some launchers move or re-add the icon each time. */
    fun sync(context: Context, spooky: Boolean, date: LocalDate = LocalDate.now()) {
        val pm = context.packageManager
        val pkg = context.packageName
        val want = wanted(spooky, date)
        val on = ComponentName(pkg, if (want) SPOOKY else DEFAULT)
        val off = ComponentName(pkg, if (want) DEFAULT else SPOOKY)
        if (enabled(pm, on, default = !want) && !enabled(pm, off, default = want)) return
        // The wanted one first, so the app always has a launcher entry.
        pm.setComponentEnabledSetting(on, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
        pm.setComponentEnabledSetting(off, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
    }

    /** [default] is the manifest's: the usual icon enabled, the Spooky one not. */
    private fun enabled(pm: PackageManager, c: ComponentName, default: Boolean): Boolean = when (pm.getComponentEnabledSetting(c)) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED -> false
        else -> default
    }
}

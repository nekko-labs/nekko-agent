package com.nekko.android

import android.content.ComponentName
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.time.LocalDate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #2118: the launcher icon in light and dark mode, and the Spooky theme's October icon. The
 * icons are drawn as the launcher gets them (adaptive, masked) side by side into one picture
 * under `evidence/`; [SpookyIcon.sync] switches the enabled alias and back.
 */
@RunWith(AndroidJUnit4::class)
class LauncherIconsDeviceTest {
    private val app get() = ApplicationProvider.getApplicationContext<NekkoApp>()
    private val pm get() = app.packageManager
    private val default get() = ComponentName(app.packageName, "com.nekko.android.LauncherDefault")
    private val spooky get() = ComponentName(app.packageName, "com.nekko.android.LauncherSpooky")
    private fun on(c: ComponentName, manifest: Boolean) = when (pm.getComponentEnabledSetting(c)) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED -> false
        else -> manifest
    }

    @After fun back() = SpookyIcon.sync(app, spooky = false)

    @Test fun lightDarkAndSpookyIcons() {
        val size = 288
        val out = Bitmap.createBitmap(size * 3 + 80, size + 40, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out).apply { drawColor(Color.rgb(0x88, 0x88, 0x88)) }
        fun draw(i: Int, night: Boolean, res: Int) {
            val config = Configuration(app.resources.configuration).apply {
                uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
            }
            val icon = app.createConfigurationContext(config).getDrawable(res)!!
            val x = 20 + i * (size + 20)
            icon.setBounds(x, 20, x + size, 20 + size)
            icon.draw(canvas)
        }
        draw(0, night = false, R.mipmap.ic_launcher)
        draw(1, night = true, R.mipmap.ic_launcher)
        draw(2, night = false, R.mipmap.ic_launcher_spooky)
        val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
        val dir = File(app.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "launcher-icons-$device.png").outputStream().use { out.compress(Bitmap.CompressFormat.PNG, 100, it) }

        // Out of season, or on another theme: the usual icon.
        SpookyIcon.sync(app, spooky = true, date = LocalDate.of(2026, 11, 17))
        assertEquals(true to false, on(default, true) to on(spooky, false))
        // October on the Spooky theme: the Spooky icon, and only it.
        SpookyIcon.sync(app, spooky = true, date = LocalDate.of(2026, 10, 15))
        assertEquals(false to true, on(default, true) to on(spooky, false))
        SpookyIcon.sync(app, spooky = false, date = LocalDate.of(2026, 10, 15))
        assertEquals(true to false, on(default, true) to on(spooky, false))
    }
}

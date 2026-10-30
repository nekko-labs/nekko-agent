package com.nekko.android

import android.Manifest
import android.app.NotificationManager
import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.PhoneEvent
import com.nekko.android.connection.EventNotice
import com.nekko.android.connection.Notices
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.ui.settings.ConnectionSection
import com.nekko.android.ui.settings.SettingsDeps
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.E2E
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Notify me about (the iPhone's IO-30) on Android: the three switches and *Send a test
 * notification* in Settings → Connection, and a needs-you notification taken down by the
 * relay's `dismiss` for its chat's tag while a finished one stays. Screenshots under `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class NotificationControlsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val app get() = ApplicationProvider.getApplicationContext<NekkoApp>()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val manager get() = app.getSystemService(NotificationManager::class.java)
    /** The chats' notifications (not the group summary Android adds on its own). */
    private fun chatTags() = manager.activeNotifications.mapNotNull { it.tag }.filter { it.startsWith("chat:") }.toSet()

    @Before fun allow() {
        if (Build.VERSION.SDK_INT >= 33) {
            InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
        manager.cancelAll()
    }

    @Test fun switchesAndTestNotification() {
        val prefs = PhonePrefs(object : PrefStore {
            val map = HashMap<String, String>()
            override fun getString(name: String) = map[name]
            override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
        })
        Notices.migrate(prefs)
        prefs.set(Notices.FINISHED, false)
        val deps = SettingsDeps(app.computers, app.themePrefs, prefs, open = {})
        compose.setContent { NekkoTheme(dark = false) { Column(Modifier.verticalScroll(rememberScrollState())) { ConnectionSection(deps) } } }
        compose.onNodeWithTag("settings.testNotification").performScrollTo().performClick()
        compose.waitUntil(5_000) { manager.activeNotifications.any { it.tag == Notices.TAG_TEST } }
        settle()
        shot("1-settings")
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cmd statusbar expand-notifications").close()
        Thread.sleep(1_500)
        shot("2-test-in-shade")
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cmd statusbar collapse").close()
    }

    @Test fun dismissTakesDownTheNeedsYouNotificationOnly() {
        val notices = app.connection.notices
        notices.post(EventNotice.of("s1", PhoneEvent.APPROVAL, "Deploy", "Studio Mac", hideContent = false, callId = "call-1"))
        notices.post(EventNotice.of("s2", PhoneEvent.FINISHED, "Notes", "Studio Mac", hideContent = false))
        Thread.sleep(500)
        assertEquals(setOf(EventNotice.tag("s1"), EventNotice.tag("s2")), chatTags())

        // A tag nobody has, and the finished chat's: nothing goes.
        notices.dismissNeedsYou(E2E.activityTag("other"))
        notices.dismissNeedsYou(E2E.activityTag("s2"))
        Thread.sleep(300)
        assertEquals(2, chatTags().size)

        notices.dismissNeedsYou(E2E.activityTag("s1"))
        Thread.sleep(500)
        val left = chatTags()
        assertTrue("$left", EventNotice.tag("s1") !in left && EventNotice.tag("s2") in left)
        manager.cancelAll()
    }

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(700)
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(app.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "notify-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
